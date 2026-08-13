import { spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import type { DockerExecutionPolicy } from "../config/schema.js";
import { HarnessFailure } from "../errors.js";
import { matchesArtifactPattern } from "../git.js";
import { matchesGlob } from "../knowledge.js";
import { hashFileSha256 } from "./bundle-transport.js";
import {
  RESULT_BUNDLE_FILENAME,
  RESULT_MANIFEST_FILENAME,
  RESULT_NO_CHANGE_FILENAME,
  normalizeGitPath,
  quarantineRefForRun,
  readResultManifest,
  type ResultBundleManifest,
} from "./result-export.js";

export type QuarantineImportLimits = DockerExecutionPolicy["bundleLimits"];

export type QuarantineImportInput = {
  controlRoot: string;
  runId: string;
  transportDirectory: string;
  /** Immutable base frozen for the run (must already exist in control repo). */
  baseSha: string;
  limits: QuarantineImportLimits;
  submoduleLfs: DockerExecutionPolicy["submoduleLfs"];
  ignoredArtifactPatterns?: readonly string[];
  /** Late delivery branch name (refs/heads/<name>); created without switching checkout. */
  deliveryBranchName: string;
  /**
   * When set, `git update-ref` for the delivery branch requires this old value
   * (`""` / missing means create-only). Used for idempotent resume.
   */
  expectedDeliveryOldSha?: string | null;
};

export type QuarantineImportResult = {
  status: "promoted" | "rejected";
  tipSha: string;
  treeSha: string;
  baseSha: string;
  deliveryBranch: string;
  deliveryRef: string;
  quarantineRef: string;
  noChange: boolean;
  resultBundleHash?: string;
  rejectionReason?: string;
  manifest: ResultBundleManifest;
};

/**
 * Host-only quarantine import: verify transport artifact, fetch into
 * `refs/harness/quarantine/<runId>` without touching the control working tree,
 * validate ancestry/limits/paths, then atomically promote the late delivery branch.
 */
export async function quarantineImportResult(
  input: QuarantineImportInput,
): Promise<QuarantineImportResult> {
  const manifestPath = path.join(input.transportDirectory, RESULT_MANIFEST_FILENAME);
  let manifest: ResultBundleManifest;
  try {
    manifest = await readResultManifest(manifestPath);
  } catch (error) {
    throw rejectAsFailure(error, "Failed to read result manifest");
  }

  const quarantineRef = quarantineRefForRun(input.runId);
  const deliveryRef = `refs/heads/${input.deliveryBranchName}`;

  try {
    await assertManifestMatchesRun(manifest, input);
    if (manifest.noChange) {
      return await promoteNoChange(input, manifest, quarantineRef, deliveryRef);
    }
    await verifyTransportArtifact(input, manifest);
    await fetchIntoQuarantine(input, manifest, quarantineRef);
    await validateQuarantine(input, manifest, quarantineRef);
    const promoted = await promoteDeliveryRef(input, manifest, quarantineRef, deliveryRef);
    await deleteRef(input.controlRoot, quarantineRef);
    return promoted;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Retain quarantine evidence for diagnosis; do not mutate delivery branch.
    throw new HarnessFailure(reason, "execution", true, {
      cause: error instanceof Error ? error : undefined,
    });
  }
}

/**
 * Idempotent resume: when delivery ref already points at the expected tip,
 * treat import as complete without re-fetching.
 */
export async function resumeOrImportResult(
  input: QuarantineImportInput,
): Promise<QuarantineImportResult> {
  const manifestPath = path.join(input.transportDirectory, RESULT_MANIFEST_FILENAME);
  const manifest = await readResultManifest(manifestPath);
  const deliveryRef = `refs/heads/${input.deliveryBranchName}`;
  const existing = await revParse(input.controlRoot, deliveryRef, true);
  if (existing && existing === manifest.tipSha) {
    return {
      status: "promoted",
      tipSha: manifest.tipSha,
      treeSha: manifest.treeSha,
      baseSha: manifest.baseSha,
      deliveryBranch: input.deliveryBranchName,
      deliveryRef,
      quarantineRef: quarantineRefForRun(input.runId),
      noChange: manifest.noChange,
      resultBundleHash: manifest.bundleHash,
      manifest,
    };
  }
  return quarantineImportResult(input);
}

async function promoteNoChange(
  input: QuarantineImportInput,
  manifest: ResultBundleManifest,
  quarantineRef: string,
  deliveryRef: string,
): Promise<QuarantineImportResult> {
  // Confirm the no-change marker exists (audit evidence).
  const marker = path.join(input.transportDirectory, RESULT_NO_CHANGE_FILENAME);
  await access(marker);

  // Point quarantine at base tip without a bundle fetch (for a uniform promote path).
  await git(input.controlRoot, ["update-ref", quarantineRef, manifest.tipSha]);
  await validateQuarantine(input, manifest, quarantineRef);
  const promoted = await promoteDeliveryRef(input, manifest, quarantineRef, deliveryRef);
  await deleteRef(input.controlRoot, quarantineRef);
  return { ...promoted, noChange: true };
}

async function assertManifestMatchesRun(
  manifest: ResultBundleManifest,
  input: QuarantineImportInput,
): Promise<void> {
  if (manifest.runId !== input.runId) {
    throw new Error(
      `Result manifest runId mismatch (expected ${input.runId}, observed ${manifest.runId})`,
    );
  }
  if (manifest.baseSha !== input.baseSha) {
    throw new Error(
      `Result manifest baseSha mismatch (expected ${input.baseSha}, observed ${manifest.baseSha})`,
    );
  }
  const baseExists = await revParse(input.controlRoot, `${input.baseSha}^{commit}`, true);
  if (!baseExists) {
    throw new Error(`Immutable base ${input.baseSha} is not present in the control repository`);
  }
}

async function verifyTransportArtifact(
  input: QuarantineImportInput,
  manifest: ResultBundleManifest,
): Promise<void> {
  const bundlePath = path.join(input.transportDirectory, RESULT_BUNDLE_FILENAME);
  const info = await stat(bundlePath);
  if (info.size !== manifest.bundleBytes) {
    throw new Error(
      `Result bundle size mismatch (manifest ${manifest.bundleBytes}, observed ${info.size})`,
    );
  }
  if (info.size > input.limits.maxBundleBytes) {
    throw new Error(
      `Result bundle exceeds maxBundleBytes (${info.size} > ${input.limits.maxBundleBytes})`,
    );
  }
  const hash = await hashFileSha256(bundlePath);
  if (hash !== manifest.bundleHash) {
    throw new Error(
      `Result bundle hash mismatch (manifest ${manifest.bundleHash}, observed ${hash})`,
    );
  }
  // Hash/size verified before invoking Git.
  const verify = await git(input.controlRoot, ["bundle", "verify", bundlePath], true);
  if (verify.exitCode !== 0) {
    throw new Error(`git bundle verify failed: ${verify.stderr || verify.stdout}`);
  }
}

async function fetchIntoQuarantine(
  input: QuarantineImportInput,
  manifest: ResultBundleManifest,
  quarantineRef: string,
): Promise<void> {
  const bundlePath = path.join(input.transportDirectory, RESULT_BUNDLE_FILENAME);
  // Fetch the exact exported ref only — never checkout or modify the control working tree.
  const fetch = await git(
    input.controlRoot,
    ["fetch", "--no-tags", bundlePath, `${manifest.exportRef}:${quarantineRef}`],
    true,
  );
  if (fetch.exitCode !== 0) {
    throw new Error(`Quarantine fetch failed: ${fetch.stderr || fetch.stdout}`);
  }
  // Reject unexpected refs: only the quarantine ref should have been updated.
  const tip = await revParse(input.controlRoot, quarantineRef, true);
  if (!tip) {
    throw new Error(`Quarantine ref ${quarantineRef} missing after fetch`);
  }
  if (tip !== manifest.tipSha) {
    throw new Error(
      `Quarantine tip mismatch (expected ${manifest.tipSha}, observed ${tip})`,
    );
  }
}

async function validateQuarantine(
  input: QuarantineImportInput,
  manifest: ResultBundleManifest,
  quarantineRef: string,
): Promise<void> {
  const tipSha = (await git(input.controlRoot, ["rev-parse", quarantineRef])).stdout.trim();
  if (tipSha !== manifest.tipSha) {
    throw new Error(`Quarantine tip ${tipSha} !== manifest tip ${manifest.tipSha}`);
  }
  const treeSha = (await git(input.controlRoot, ["rev-parse", `${tipSha}^{tree}`])).stdout.trim();
  if (treeSha !== manifest.treeSha) {
    throw new Error(`Tree SHA mismatch (expected ${manifest.treeSha}, observed ${treeSha})`);
  }

  const ancestor = await git(
    input.controlRoot,
    ["merge-base", "--is-ancestor", input.baseSha, tipSha],
    true,
  );
  if (ancestor.exitCode !== 0 && tipSha !== input.baseSha) {
    throw new Error(
      `Quarantine tip does not descend from immutable base ${input.baseSha}`,
    );
  }

  if (manifest.commitCount > input.limits.maxCommitCount) {
    throw new Error(
      `Commit count ${manifest.commitCount} exceeds maxCommitCount ${input.limits.maxCommitCount}`,
    );
  }
  if (manifest.objectCount > input.limits.maxObjectCount) {
    throw new Error(
      `Object count ${manifest.objectCount} exceeds maxObjectCount ${input.limits.maxObjectCount}`,
    );
  }
  if (manifest.changedBytes > input.limits.maxChangedBytes) {
    throw new Error(
      `Changed bytes ${manifest.changedBytes} exceeds maxChangedBytes ${input.limits.maxChangedBytes}`,
    );
  }
  if (manifest.bundleBytes > input.limits.maxBundleBytes) {
    throw new Error(
      `Bundle bytes ${manifest.bundleBytes} exceeds maxBundleBytes ${input.limits.maxBundleBytes}`,
    );
  }

  const observedPaths = await listChangedPaths(input.controlRoot, input.baseSha, tipSha);
  const ignored = input.ignoredArtifactPatterns ?? [];
  const observedFiltered = observedPaths.filter(
    (file) => !matchesArtifactPattern(file, [...ignored]),
  );
  const manifestFiltered = manifest.changedPaths
    .map(normalizeGitPath)
    .filter((file) => !matchesArtifactPattern(file, [...ignored]));

  assertPathSetEqual(manifestFiltered, observedFiltered);
  assertPathsNormalized(observedFiltered);
  assertNoSensitivePaths(observedFiltered, input.limits.sensitivePathPatterns);
  await assertSymlinkPolicy(input.controlRoot, tipSha, observedFiltered);
  await assertSubmoduleLfsPolicy(input.controlRoot, tipSha, input.submoduleLfs);
}

async function promoteDeliveryRef(
  input: QuarantineImportInput,
  manifest: ResultBundleManifest,
  quarantineRef: string,
  deliveryRef: string,
): Promise<QuarantineImportResult> {
  const tipSha = manifest.tipSha;
  const existing = await revParse(input.controlRoot, deliveryRef, true);

  if (existing === tipSha) {
    // Idempotent: already promoted.
  } else if (existing && input.expectedDeliveryOldSha && existing !== input.expectedDeliveryOldSha) {
    throw new Error(
      `Delivery ref ${deliveryRef} is at ${existing} but expected old value ${input.expectedDeliveryOldSha}; refusing non-atomic promotion`,
    );
  } else if (existing && existing !== tipSha && input.expectedDeliveryOldSha == null) {
    // Create-or-set with expected old = current for safety when branch exists at wrong tip.
    throw new Error(
      `Delivery branch ${input.deliveryBranchName} already exists at ${existing.slice(0, 12)} but quarantine tip is ${tipSha.slice(0, 12)}. ` +
        "Choose a different branch name; the harness will not reset it.",
    );
  } else if (existing) {
    await git(input.controlRoot, [
      "update-ref",
      deliveryRef,
      tipSha,
      existing,
    ]);
  } else {
    // Atomic create: old value is the zero OID.
    await git(input.controlRoot, [
      "update-ref",
      deliveryRef,
      tipSha,
      "0000000000000000000000000000000000000000",
    ]);
  }

  // Never switch the control checkout.
  return {
    status: "promoted",
    tipSha,
    treeSha: manifest.treeSha,
    baseSha: manifest.baseSha,
    deliveryBranch: input.deliveryBranchName,
    deliveryRef,
    quarantineRef,
    noChange: manifest.noChange,
    resultBundleHash: manifest.bundleHash,
    manifest,
  };
}

function assertPathSetEqual(expected: string[], observed: string[]): void {
  const left = new Set(expected.map(normalizeGitPath));
  const right = new Set(observed.map(normalizeGitPath));
  const missing = [...right].filter((path) => !left.has(path));
  const extra = [...left].filter((path) => !right.has(path));
  if (missing.length > 0 || extra.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) {
      parts.push(`unreported paths in tip: ${missing.slice(0, 20).join(", ")}`);
    }
    if (extra.length > 0) {
      parts.push(`manifest paths absent from tip: ${extra.slice(0, 20).join(", ")}`);
    }
    throw new Error(`Changed-path policy failed (${parts.join("; ")})`);
  }
}

function assertPathsNormalized(paths: readonly string[]): void {
  for (const filePath of paths) {
    const normalized = normalizeGitPath(filePath);
    if (
      normalized !== filePath.replaceAll("\\", "/") ||
      normalized.startsWith("/") ||
      normalized.includes("\\") ||
      normalized.split("/").some((part) => part === ".." || part === "")
    ) {
      throw new Error(`Rejected non-normalized or escaping path: ${filePath}`);
    }
  }
}

function assertNoSensitivePaths(
  paths: readonly string[],
  patterns: readonly string[],
): void {
  const hits = paths.filter((filePath) =>
    patterns.some((pattern) => matchesSensitivePattern(filePath, pattern)),
  );
  if (hits.length > 0) {
    throw new Error(`Sensitive paths present in result bundle: ${hits.slice(0, 12).join(", ")}`);
  }
}

function matchesSensitivePattern(filePath: string, rawPattern: string): boolean {
  const normalized = normalizeGitPath(filePath);
  let pattern = rawPattern.trim();
  if (!pattern) return false;
  if (pattern.endsWith("/")) pattern = `${pattern}**`;
  if (matchesGlob(pattern, normalized)) return true;
  if (!pattern.includes("/")) {
    return matchesGlob(`**/${pattern}`, normalized);
  }
  return false;
}

async function assertSymlinkPolicy(
  controlRoot: string,
  tipSha: string,
  changedPaths: readonly string[],
): Promise<void> {
  for (const filePath of changedPaths) {
    const mode = await git(controlRoot, ["ls-tree", tipSha, "--", filePath], true);
    if (mode.exitCode !== 0 || !mode.stdout.trim()) continue;
    // ls-tree: <mode> <type> <sha>\t<path>
    const match = /^(\d+)\s+blob\s+\S+\t/.exec(mode.stdout.trim());
    if (!match) continue;
    if (match[1] !== "120000") continue;
    const target = (
      await git(controlRoot, ["cat-file", "-p", `${tipSha}:${filePath}`], true)
    ).stdout.trim();
    if (!target) {
      throw new Error(`Empty symlink target at ${filePath}`);
    }
    if (path.isAbsolute(target) || /^[A-Za-z]:[\\/]/.test(target) || target.includes("://")) {
      throw new Error(`Rejected absolute/URI symlink at ${filePath} → ${target}`);
    }
    const normalized = normalizeGitPath(path.posix.normalize(target));
    if (normalized.split("/").includes("..") || normalized.startsWith("../")) {
      // Relative escape outside the path's directory is allowed only within the tree;
      // reject obvious repo-escape patterns that leave the repository root when resolved
      // from the file's directory.
      const fromDir = path.posix.dirname(normalizeGitPath(filePath));
      const resolved = normalizeGitPath(path.posix.normalize(`${fromDir}/${target}`));
      if (resolved.startsWith("../") || resolved.split("/").includes("..")) {
        throw new Error(`Rejected escaping symlink at ${filePath} → ${target}`);
      }
    }
  }
}

async function assertSubmoduleLfsPolicy(
  controlRoot: string,
  tipSha: string,
  policy: DockerExecutionPolicy["submoduleLfs"],
): Promise<void> {
  if (policy.submodules === "reject") {
    const modules = await git(controlRoot, ["cat-file", "-e", `${tipSha}:.gitmodules`], true);
    if (modules.exitCode === 0) {
      throw new Error("Result tip introduces or retains Git submodules (.gitmodules)");
    }
  }
  if (policy.lfs === "reject") {
    const attrs = await git(controlRoot, ["show", `${tipSha}:.gitattributes`], true);
    if (attrs.exitCode === 0 && /\bfilter=lfs\b/i.test(attrs.stdout)) {
      throw new Error("Result tip declares Git LFS filters in .gitattributes");
    }
  }
}

async function listChangedPaths(
  cwd: string,
  baseSha: string,
  tipSha: string,
): Promise<string[]> {
  if (baseSha === tipSha) return [];
  const result = await git(
    cwd,
    ["diff", "--name-only", "--diff-filter=ACDMRTUXB", baseSha, tipSha],
    true,
  );
  if (result.exitCode !== 0) return [];
  return [
    ...new Set(
      result.stdout
        .split(/\r?\n/)
        .map((line) => normalizeGitPath(line.trim()))
        .filter(Boolean),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

async function deleteRef(cwd: string, ref: string): Promise<void> {
  await git(cwd, ["update-ref", "-d", ref], true);
}

async function revParse(
  cwd: string,
  rev: string,
  allowFailure = false,
): Promise<string | undefined> {
  const result = await git(cwd, ["rev-parse", "--verify", rev], true);
  if (result.exitCode !== 0) {
    if (allowFailure) return undefined;
    throw new Error(`rev-parse failed for ${rev}: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim() || undefined;
}

function rejectAsFailure(error: unknown, prefix: string): HarnessFailure {
  const message = error instanceof Error ? error.message : String(error);
  return new HarnessFailure(`${prefix}: ${message}`, "execution", true, {
    cause: error instanceof Error ? error : undefined,
  });
}

/**
 * Push a delivery branch by explicit refspec from the control repository.
 * Never uses the container; credentials stay on the host.
 */
export async function pushDeliveryBranch(input: {
  controlRoot: string;
  remote: string;
  branchName: string;
}): Promise<void> {
  const refspec = `refs/heads/${input.branchName}:refs/heads/${input.branchName}`;
  await git(input.controlRoot, ["push", input.remote, refspec]);
}

/**
 * Create a pull request from the host control plane (`gh`), never from a container.
 */
export async function createHostPullRequest(input: {
  controlRoot: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
}): Promise<string | undefined> {
  const result = await runProgram(
    "gh",
    [
      "pr",
      "create",
      "--base",
      input.baseBranch,
      "--head",
      input.headBranch,
      "--title",
      input.title.replace(/[\r\n]+/g, " ").trim().slice(0, 100) || "chore: complete harness task",
      "--body",
      input.body,
    ],
    input.controlRoot,
  );
  return result.stdout.trim().split(/\r?\n/).at(-1);
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

function runProgram(
  executable: string,
  args: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
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
    child.once("error", reject);
    const timer = setTimeout(() => child.kill("SIGKILL"), 10 * 60 * 1000);
    child.once("close", (code) => {
      clearTimeout(timer);
      const result = { exitCode: code ?? 1, stdout, stderr };
      if (result.exitCode !== 0) {
        reject(
          new Error(`${executable} ${args[0] ?? ""} failed (${result.exitCode}): ${stderr || stdout}`),
        );
        return;
      }
      resolve(result);
    });
  });
}
