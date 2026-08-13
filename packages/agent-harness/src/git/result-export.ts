import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { HarnessFailure } from "../errors.js";
import { hashFileSha256 } from "./bundle-transport.js";

/** Host/worker transport filename for the per-run result bundle. */
export const RESULT_BUNDLE_FILENAME = "result.bundle" as const;

/** Sidecar manifest written next to the result bundle. */
export const RESULT_MANIFEST_FILENAME = "result.manifest.json" as const;

/** Marker file written instead of an empty git bundle for no-change runs. */
export const RESULT_NO_CHANGE_FILENAME = "result.no-change.json" as const;

export const RESULT_MANIFEST_VERSION = 1 as const;

export type ResultBundleManifest = {
  version: typeof RESULT_MANIFEST_VERSION;
  runId: string;
  baseSha: string;
  tipSha: string;
  treeSha: string;
  exportRef: string;
  changedPaths: string[];
  commitCount: number;
  objectCount: number;
  changedBytes: number;
  bundleBytes: number;
  bundleHash: string;
  noChange: boolean;
  createdAt: string;
};

export type PrepareResultExportInput = {
  workspacePath: string;
  transportDirectory: string;
  runId: string;
  baseSha: string;
  /** When provided, each SHA must be reachable from HEAD (task commits exist). */
  expectedCommitShas?: readonly string[];
};

export type PrepareResultExportResult = {
  manifest: ResultBundleManifest;
  bundlePath: string | undefined;
  manifestPath: string;
  exportRef: string;
  quarantineRef: string;
};

export function resultExportRef(runId: string): string {
  return `refs/harness/export/${sanitizeRefSegment(runId)}`;
}

export function quarantineRefForRun(runId: string): string {
  return `refs/harness/quarantine/${sanitizeRefSegment(runId)}`;
}

/**
 * Before publish: require a clean container working tree, ensure task commits
 * exist, create a temporary named export ref at HEAD, atomically create
 * `result.bundle` (or an explicit no-change marker), and write the manifest.
 */
export async function prepareResultExport(
  input: PrepareResultExportInput,
): Promise<PrepareResultExportResult> {
  await mkdir(input.transportDirectory, { recursive: true });
  const workspace = input.workspacePath;
  const baseSha = (await git(workspace, ["rev-parse", "--verify", `${input.baseSha}^{commit}`]))
    .stdout.trim();
  const tipSha = (await git(workspace, ["rev-parse", "HEAD"])).stdout.trim();
  const treeSha = (await git(workspace, ["rev-parse", `${tipSha}^{tree}`])).stdout.trim();

  await assertCleanWorkingTree(workspace);
  await assertBaseIsAncestor(workspace, baseSha, tipSha);
  await assertExpectedCommitsExist(workspace, tipSha, input.expectedCommitShas);

  const exportRef = resultExportRef(input.runId);
  await git(workspace, ["update-ref", exportRef, tipSha]);

  const commitCount = await countCommits(workspace, baseSha, tipSha);
  const changedPaths = await listChangedPaths(workspace, baseSha, tipSha);
  const objectCount = await countObjects(workspace, baseSha, tipSha);
  const changedBytes = await measureChangedBytes(workspace, baseSha, tipSha, changedPaths);
  const noChange = tipSha === baseSha || commitCount === 0;

  const manifestPath = path.join(input.transportDirectory, RESULT_MANIFEST_FILENAME);
  let bundlePath: string | undefined;
  let bundleHash = "";
  let bundleBytes = 0;

  try {
    if (noChange) {
      // Never invoke `git bundle create` with an empty revision set.
      const markerPath = path.join(input.transportDirectory, RESULT_NO_CHANGE_FILENAME);
      const marker = {
        version: RESULT_MANIFEST_VERSION,
        runId: input.runId,
        baseSha,
        tipSha,
        reason: "no-change",
        createdAt: new Date().toISOString(),
      };
      await writeAtomicJson(markerPath, marker);
      bundleHash = `sha256:${createHash("sha256").update(JSON.stringify(marker)).digest("hex")}`;
      bundleBytes = 0;
    } else {
      bundlePath = path.join(input.transportDirectory, RESULT_BUNDLE_FILENAME);
      const partialPath = `${bundlePath}.partial`;
      await rm(partialPath, { force: true });
      // Prerequisite baseSha is already on the host control repo; bundle carries tip + intermediates.
      await git(workspace, ["bundle", "create", partialPath, exportRef, `^${baseSha}`]);
      const verify = await git(workspace, ["bundle", "verify", partialPath], true);
      if (verify.exitCode !== 0) {
        await rm(partialPath, { force: true }).catch(() => undefined);
        throw new HarnessFailure(
          `Result bundle failed git bundle verify: ${verify.stderr || verify.stdout}`,
          "execution",
          false,
        );
      }
      await rename(partialPath, bundlePath);
      bundleHash = await hashFileSha256(bundlePath);
      bundleBytes = (await stat(bundlePath)).size;
    }
  } finally {
    // Export ref is recorded in the manifest; keep it on the clone for diagnosis
    // until the host imports. Do not leave dangling partials.
  }

  const manifest: ResultBundleManifest = {
    version: RESULT_MANIFEST_VERSION,
    runId: input.runId,
    baseSha,
    tipSha,
    treeSha,
    exportRef,
    changedPaths,
    commitCount: noChange ? 0 : commitCount,
    objectCount: noChange ? 0 : objectCount,
    changedBytes: noChange ? 0 : changedBytes,
    bundleBytes,
    bundleHash,
    noChange,
    createdAt: new Date().toISOString(),
  };
  await writeAtomicJson(manifestPath, manifest);

  return {
    manifest,
    bundlePath,
    manifestPath,
    exportRef,
    quarantineRef: quarantineRefForRun(input.runId),
  };
}

async function assertCleanWorkingTree(workspace: string): Promise<void> {
  const porcelain = await git(workspace, ["status", "--porcelain"], true);
  const dirty = porcelain.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    // Clone-local RI / harness markers under .git are never committed.
    .filter((line) => !/\s\.git\//.test(line));
  if (dirty.length > 0) {
    throw new HarnessFailure(
      `Refusing to export: container working tree is not clean: ${dirty.slice(0, 12).join(", ")}`,
      "workspace",
      true,
    );
  }
}

async function assertBaseIsAncestor(
  workspace: string,
  baseSha: string,
  tipSha: string,
): Promise<void> {
  if (baseSha === tipSha) return;
  const ancestor = await git(workspace, ["merge-base", "--is-ancestor", baseSha, tipSha], true);
  if (ancestor.exitCode !== 0) {
    throw new HarnessFailure(
      `Export tip ${tipSha.slice(0, 12)} does not descend from immutable base ${baseSha.slice(0, 12)}`,
      "execution",
      false,
    );
  }
}

async function assertExpectedCommitsExist(
  workspace: string,
  tipSha: string,
  expected: readonly string[] | undefined,
): Promise<void> {
  if (!expected || expected.length === 0) return;
  for (const sha of expected) {
    const trimmed = sha.trim();
    if (!trimmed) continue;
    const exists = await git(workspace, ["cat-file", "-e", `${trimmed}^{commit}`], true);
    if (exists.exitCode !== 0) {
      throw new HarnessFailure(
        `Expected task commit ${trimmed.slice(0, 12)} is missing from the container repository`,
        "execution",
        true,
      );
    }
    const ancestor = await git(workspace, ["merge-base", "--is-ancestor", trimmed, tipSha], true);
    if (ancestor.exitCode !== 0) {
      throw new HarnessFailure(
        `Expected task commit ${trimmed.slice(0, 12)} is not an ancestor of export tip ${tipSha.slice(0, 12)}`,
        "execution",
        true,
      );
    }
  }
}

async function countCommits(workspace: string, baseSha: string, tipSha: string): Promise<number> {
  if (baseSha === tipSha) return 0;
  const result = await git(workspace, ["rev-list", "--count", `${baseSha}..${tipSha}`], true);
  if (result.exitCode !== 0) return 0;
  return Number.parseInt(result.stdout.trim(), 10) || 0;
}

async function countObjects(workspace: string, baseSha: string, tipSha: string): Promise<number> {
  if (baseSha === tipSha) return 0;
  const result = await git(workspace, ["rev-list", "--objects", `${baseSha}..${tipSha}`], true);
  if (result.exitCode !== 0) return 0;
  return result.stdout.split(/\r?\n/).filter((line) => line.trim()).length;
}

async function listChangedPaths(
  workspace: string,
  baseSha: string,
  tipSha: string,
): Promise<string[]> {
  if (baseSha === tipSha) return [];
  const result = await git(
    workspace,
    ["diff", "--name-only", "--diff-filter=ACDMRTUXB", baseSha, tipSha],
    true,
  );
  if (result.exitCode !== 0) return [];
  return uniqueNormalized(
    result.stdout
      .split(/\r?\n/)
      .map((line) => normalizePath(line.trim()))
      .filter(Boolean),
  );
}

async function measureChangedBytes(
  workspace: string,
  baseSha: string,
  tipSha: string,
  changedPaths: readonly string[],
): Promise<number> {
  let total = 0;
  for (const filePath of changedPaths) {
    const tipSize = await blobSizeAt(workspace, tipSha, filePath);
    const baseSize = await blobSizeAt(workspace, baseSha, filePath);
    total += Math.max(tipSize, baseSize);
  }
  return total;
}

async function blobSizeAt(workspace: string, treeish: string, filePath: string): Promise<number> {
  const result = await git(workspace, ["cat-file", "-s", `${treeish}:${filePath}`], true);
  if (result.exitCode !== 0) return 0;
  return Number.parseInt(result.stdout.trim(), 10) || 0;
}

async function writeAtomicJson(filePath: string, value: unknown): Promise<void> {
  const partial = `${filePath}.partial`;
  await writeFile(partial, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(partial, filePath);
}

export async function readResultManifest(manifestPath: string): Promise<ResultBundleManifest> {
  const raw: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!raw || typeof raw !== "object") {
    throw new HarnessFailure("Result manifest is not an object", "execution", false);
  }
  const manifest = raw as ResultBundleManifest;
  if (manifest.version !== RESULT_MANIFEST_VERSION) {
    throw new HarnessFailure(
      `Unsupported result manifest version: ${String((raw as { version?: unknown }).version)}`,
      "execution",
      false,
    );
  }
  return manifest;
}

export function normalizeGitPath(value: string): string {
  return normalizePath(value);
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function uniqueNormalized(paths: string[]): string[] {
  return [...new Set(paths.map(normalizePath))].sort((a, b) => a.localeCompare(b));
}

function sanitizeRefSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._/-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}

async function git(
  cwd: string,
  args: string[],
  allowFailure = false,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString("utf8")}`.slice(-200_000);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-200_000);
    });
    child.once("error", (error) => {
      reject(
        new HarnessFailure(
          `git ${args[0] ?? ""} failed to start: ${error instanceof Error ? error.message : String(error)}`,
          "workspace",
          true,
          { cause: error instanceof Error ? error : undefined },
        ),
      );
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10 * 60 * 1000);
    child.once("close", (code) => {
      clearTimeout(timer);
      const result = { exitCode: code ?? 1, stdout, stderr };
      if (result.exitCode !== 0 && !allowFailure) {
        reject(
          new HarnessFailure(
            `git ${args[0] ?? ""} failed (${result.exitCode}): ${stderr || stdout}`,
            "workspace",
            true,
          ),
        );
        return;
      }
      resolve(result);
    });
  });
}
