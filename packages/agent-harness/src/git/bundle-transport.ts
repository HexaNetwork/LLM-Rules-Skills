import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { HarnessFailure } from "../errors.js";

/** Host transport filename for the per-run seed bundle. */
export const SEED_BUNDLE_FILENAME = "seed.bundle" as const;

/** Clone-local identity marker (under `.git/info/`, never committed). */
export const CLONE_IDENTITY_RELATIVE_PATH = ".git/info/harness-clone-identity.json" as const;

/** Default RI artifact directories excluded in the clone-local info/exclude. */
export const DEFAULT_RI_EXCLUDE_DIRECTORIES = [".gitnexus", ".codegraph"] as const;

export type SeedBundleCreateResult = {
  bundlePath: string;
  bundleHash: string;
  baseSha: string;
  bytes: number;
};

export type CloneIdentityMarker = {
  runId: string;
  baseSha: string;
  seedBundleHash: string;
  generation: number;
  createdAt: string;
};

export type UnsupportedGitFeaturePolicy = {
  submodules: "reject";
  lfs: "reject";
};

/**
 * Resolve `baseBranch` or an explicit SHA to a full commit object name.
 */
export async function resolveBaseSha(
  controlRoot: string,
  input: { baseBranch: string; baseSha?: string },
): Promise<string> {
  let baseSha = input.baseSha?.trim();
  if (!baseSha) {
    const result = await git(controlRoot, ["rev-parse", `${input.baseBranch}^{commit}`], true);
    baseSha = result.stdout.trim();
    if (result.exitCode !== 0 || !baseSha) {
      throw new HarnessFailure(
        `Could not resolve base branch ${input.baseBranch} to a commit`,
        "workspace",
        false,
      );
    }
    return baseSha;
  }
  const verify = await git(controlRoot, ["rev-parse", "--verify", `${baseSha}^{commit}`], true);
  if (verify.exitCode !== 0) {
    throw new HarnessFailure(
      `Could not resolve baseSha ${baseSha} to a commit`,
      "workspace",
      false,
    );
  }
  return verify.stdout.trim() || baseSha;
}

/**
 * Fail closed when the frozen base requires Git submodules or LFS under the
 * configured policy (MVP: reject only; opt-in modes are future-safe schema fields).
 */
export async function assertUnsupportedGitFeaturesRejected(
  controlRoot: string,
  baseSha: string,
  policy: UnsupportedGitFeaturePolicy,
): Promise<void> {
  if (policy.submodules === "reject") {
    const modules = await git(controlRoot, ["cat-file", "-e", `${baseSha}:.gitmodules`], true);
    if (modules.exitCode === 0) {
      throw new HarnessFailure(
        "Docker execution rejects repositories that require Git submodules at the frozen base. " +
          "Set execution.runtime to local, or remove submodule requirements before retrying. " +
          "(execution.docker.submoduleLfs.submodules currently supports only \"reject\".)",
        "execution",
        false,
      );
    }
  }
  if (policy.lfs === "reject") {
    const lfsFiles = await git(
      controlRoot,
      ["ls-files", "--with-tree", baseSha, "--", ":(attr:filter=lfs)"],
      true,
    );
    if (lfsFiles.exitCode === 0 && lfsFiles.stdout.trim()) {
      throw new HarnessFailure(
        "Docker execution rejects repositories that require Git LFS at the frozen base. " +
          "Set execution.runtime to local, or remove LFS-filtered paths before retrying. " +
          "(execution.docker.submoduleLfs.lfs currently supports only \"reject\".)",
        "execution",
        false,
      );
    }
    // Also catch .gitattributes declaring LFS even when no matching paths are present yet.
    const attrs = await git(controlRoot, ["show", `${baseSha}:.gitattributes`], true);
    if (attrs.exitCode === 0 && /\bfilter=lfs\b/i.test(attrs.stdout)) {
      throw new HarnessFailure(
        "Docker execution rejects repositories whose .gitattributes declare Git LFS filters. " +
          "Set execution.runtime to local, or remove LFS attribute rules before retrying.",
        "execution",
        false,
      );
    }
  }
}

/**
 * Atomically create a seed bundle containing only the required base commit,
 * hash it, and verify with `git bundle verify`.
 */
export async function createSeedBundle(input: {
  controlRoot: string;
  transportDirectory: string;
  baseSha: string;
  /** Optional explicit output path; defaults to `<transport>/seed.bundle`. */
  bundlePath?: string;
}): Promise<SeedBundleCreateResult> {
  await mkdir(input.transportDirectory, { recursive: true });
  const bundlePath =
    input.bundlePath ?? path.join(input.transportDirectory, SEED_BUNDLE_FILENAME);
  const partialPath = `${bundlePath}.partial`;
  await rm(partialPath, { force: true });
  await rm(bundlePath, { force: true });

  // Name a temporary ref so `git bundle create` always has a tip (bare SHAs can
  // yield empty bundles on some Git builds when used as the sole rev-list arg).
  const seedRef = `refs/harness/seed/${input.baseSha.slice(0, 12)}`;
  await git(input.controlRoot, ["update-ref", seedRef, input.baseSha]);
  try {
    await git(input.controlRoot, ["bundle", "create", partialPath, seedRef]);
  } finally {
    await git(input.controlRoot, ["update-ref", "-d", seedRef], true);
  }

  const verify = await git(input.controlRoot, ["bundle", "verify", partialPath], true);
  if (verify.exitCode !== 0) {
    await rm(partialPath, { force: true }).catch(() => undefined);
    throw new HarnessFailure(
      `Seed bundle failed git bundle verify: ${verify.stderr || verify.stdout}`,
      "execution",
      false,
    );
  }

  await rename(partialPath, bundlePath);
  const bundleHash = await hashFileSha256(bundlePath);
  const bytes = (await readFile(bundlePath)).byteLength;
  return { bundlePath, bundleHash, baseSha: input.baseSha, bytes };
}

/** Verify an existing seed bundle against a control repository (or any git cwd). */
export async function verifySeedBundle(
  controlRoot: string,
  bundlePath: string,
): Promise<void> {
  const verify = await git(controlRoot, ["bundle", "verify", bundlePath], true);
  if (verify.exitCode !== 0) {
    throw new HarnessFailure(
      `Seed bundle verify failed: ${verify.stderr || verify.stdout}`,
      "execution",
      false,
    );
  }
}

export function hashFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(`sha256:${hash.digest("hex")}`));
  });
}

/**
 * Initialize an isolated clone at `workspacePath` from a seed bundle, checkout
 * detached at exactly `baseSha`, configure no remotes, and install clone-local
 * RI excludes + identity marker. Does not touch any control-repo exclude file.
 */
export async function initializeCloneFromSeedBundle(input: {
  workspacePath: string;
  seedBundlePath: string;
  baseSha: string;
  identity: CloneIdentityMarker;
  riExcludeDirectories?: readonly string[];
}): Promise<void> {
  await mkdir(input.workspacePath, { recursive: true });
  const workspace = input.workspacePath;

  // Empty or re-init: refuse if a non-harness git repo already occupies the volume.
  const existing = await git(workspace, ["rev-parse", "--git-dir"], true);
  if (existing.exitCode === 0) {
    const marker = await readCloneIdentity(workspace);
    if (!marker) {
      throw new HarnessFailure(
        `Workspace volume at ${workspace} already contains a Git repository without a harness clone identity marker. Refusing to reseed.`,
        "execution",
        true,
      );
    }
  } else {
    await git(workspace, ["init"]);
  }

  await git(workspace, ["fetch", "--no-tags", input.seedBundlePath, `${input.baseSha}:refs/harness/base`]);
  await git(workspace, ["checkout", "--detach", input.baseSha]);

  const head = await git(workspace, ["rev-parse", "HEAD"]);
  const headSha = head.stdout.trim();
  if (headSha !== input.baseSha) {
    throw new HarnessFailure(
      `Clone HEAD ${headSha} does not match frozen baseSha ${input.baseSha}`,
      "execution",
      false,
    );
  }

  await removeAllRemotes(workspace);
  await ensureCloneLocalRiExcludes(
    workspace,
    input.riExcludeDirectories ?? DEFAULT_RI_EXCLUDE_DIRECTORIES,
  );
  await writeCloneIdentity(workspace, input.identity);

  // Belt-and-suspenders: no remote URLs and no host path remotes remain.
  const remotes = await git(workspace, ["remote"], true);
  if (remotes.stdout.trim()) {
    throw new HarnessFailure(
      `Clone still has remotes after seed init: ${remotes.stdout.trim()}`,
      "execution",
      false,
    );
  }
}

export async function ensureCloneLocalRiExcludes(
  workspacePath: string,
  directories: readonly string[] = DEFAULT_RI_EXCLUDE_DIRECTORIES,
): Promise<void> {
  const excludePath = path.join(workspacePath, ".git", "info", "exclude");
  await mkdir(path.dirname(excludePath), { recursive: true });
  let existing = "";
  try {
    existing = await readFile(excludePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const linesToAdd = directories
    .map((directory) => `/${directory.replace(/^\/+|\/+$/g, "")}/`)
    .filter((line) => !existing.split(/\r?\n/).includes(line));
  if (linesToAdd.length === 0) return;
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await writeFile(
    excludePath,
    `${existing}${prefix}# agent-harness generated repository intelligence indexes (clone-local)\n${linesToAdd.join("\n")}\n`,
    "utf8",
  );
}

export async function writeCloneIdentity(
  workspacePath: string,
  identity: CloneIdentityMarker,
): Promise<void> {
  const markerPath = path.join(workspacePath, ...CLONE_IDENTITY_RELATIVE_PATH.split("/"));
  await mkdir(path.dirname(markerPath), { recursive: true });
  await writeFile(`${markerPath}.partial`, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
  await rename(`${markerPath}.partial`, markerPath);
}

export async function readCloneIdentity(
  workspacePath: string,
): Promise<CloneIdentityMarker | undefined> {
  const markerPath = path.join(workspacePath, ...CLONE_IDENTITY_RELATIVE_PATH.split("/"));
  try {
    const raw = JSON.parse(await readFile(markerPath, "utf8")) as CloneIdentityMarker;
    if (
      typeof raw.runId === "string" &&
      typeof raw.baseSha === "string" &&
      typeof raw.seedBundleHash === "string" &&
      typeof raw.generation === "number"
    ) {
      return raw;
    }
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Reopen checks against an already-materialized clone (host path or container mount).
 * Missing identity / dirty metadata / wrong ancestry → recoverable HarnessFailure.
 */
export async function assertCloneReopenInvariants(input: {
  workspacePath: string;
  expected: {
    /** When known (create/open with run context), must match the clone marker. */
    runId?: string;
    baseSha: string;
    seedBundleHash: string;
    generation: number;
  };
}): Promise<{ headSha: string; dirty: boolean }> {
  const identity = await readCloneIdentity(input.workspacePath);
  if (!identity) {
    throw new HarnessFailure(
      "Docker clone identity marker is missing. The volume may be corrupt; do not silently reseed.",
      "execution",
      true,
    );
  }
  if (input.expected.runId != null && identity.runId !== input.expected.runId) {
    throw new HarnessFailure(
      `Docker clone identity runId mismatch (expected ${input.expected.runId}, observed ${identity.runId})`,
      "execution",
      true,
    );
  }
  if (identity.baseSha !== input.expected.baseSha) {
    throw new HarnessFailure(
      `Docker clone identity baseSha mismatch (expected ${input.expected.baseSha}, observed ${identity.baseSha})`,
      "execution",
      true,
    );
  }
  if (identity.seedBundleHash !== input.expected.seedBundleHash) {
    throw new HarnessFailure(
      `Docker clone identity seedBundleHash mismatch (expected ${input.expected.seedBundleHash}, observed ${identity.seedBundleHash})`,
      "execution",
      true,
    );
  }
  if (identity.generation !== input.expected.generation) {
    throw new HarnessFailure(
      `Docker clone identity generation mismatch (expected ${input.expected.generation}, observed ${identity.generation})`,
      "execution",
      true,
    );
  }

  const ancestor = await git(
    input.workspacePath,
    ["merge-base", "--is-ancestor", input.expected.baseSha, "HEAD"],
    true,
  );
  if (ancestor.exitCode !== 0) {
    throw new HarnessFailure(
      `Docker clone HEAD no longer descends from recorded base ${input.expected.baseSha}`,
      "execution",
      true,
    );
  }

  const head = await git(input.workspacePath, ["rev-parse", "HEAD"]);
  const porcelain = await git(input.workspacePath, ["status", "--porcelain"], true);
  const remotes = await git(input.workspacePath, ["remote"], true);
  if (remotes.stdout.trim()) {
    throw new HarnessFailure(
      `Docker clone unexpectedly has remotes: ${remotes.stdout.trim()}`,
      "execution",
      true,
    );
  }

  return {
    headSha: head.stdout.trim(),
    dirty: porcelain.stdout.trim().length > 0,
  };
}

async function removeAllRemotes(workspacePath: string): Promise<void> {
  const listed = await git(workspacePath, ["remote"], true);
  for (const name of listed.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)) {
    await git(workspacePath, ["remote", "remove", name], true);
  }
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
