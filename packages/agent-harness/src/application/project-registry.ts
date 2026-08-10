import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { canonicalizeWorkspacePath } from "../domain/workspace.js";
import { HarnessFailure } from "../errors.js";
import {
  generateProjectKey,
  pathsEqual,
  remoteFingerprintFromUrl,
  resolveHarnessHome,
  resolveProjectPaths,
  type HarnessHomePaths,
  type ProjectPaths,
  WORKTREE_ROOT_OWNERSHIP_FILE,
  type WorktreeRootOwnership,
} from "./harness-home.js";

export const PROJECT_REGISTRATION_VERSION = 1 as const;

export const ProjectRegistrationSchema = z.object({
  version: z.literal(PROJECT_REGISTRATION_VERSION),
  projectKey: z.string().min(1),
  displayName: z.string().min(1),
  controlRoot: z.string().min(1),
  canonicalControlRoot: z.string().min(1),
  gitCommonDir: z.string().min(1).optional(),
  remoteFingerprint: z.string().min(1).optional(),
  worktreeRoot: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type ProjectRegistration = z.infer<typeof ProjectRegistrationSchema>;

export type ProjectLookupResult = {
  registration: ProjectRegistration;
  paths: ProjectPaths;
  home: HarnessHomePaths;
};

export type AddProjectOptions = {
  repository: string;
  name?: string;
  worktreeRoot?: string;
  home?: HarnessHomePaths;
  now?: () => Date;
};

export type RelinkProjectOptions = {
  projectKey: string;
  repository: string;
  home?: HarnessHomePaths;
  now?: () => Date;
};

export type DiscoverProjectOptions = {
  projectKey?: string;
  repository?: string;
  cwd?: string;
  home?: HarnessHomePaths;
};

/**
 * Persist and discover external project registrations under the harness home.
 * Never silently creates a registration during run start/advance.
 */
export class ProjectRegistry {
  constructor(private readonly home: HarnessHomePaths = resolveHarnessHome()) {}

  get homePaths(): HarnessHomePaths {
    return this.home;
  }

  async ensureHomeLayout(): Promise<void> {
    await mkdir(this.home.projectsRoot, { recursive: true });
    await mkdir(this.home.sharedGuidanceRoot, { recursive: true });
    await mkdir(this.home.workflowsRoot, { recursive: true });
    await mkdir(this.home.agentsRoot, { recursive: true });
  }

  async list(): Promise<ProjectRegistration[]> {
    await this.ensureHomeLayout();
    let entries: Dirent[] = [];
    try {
      entries = await readdir(this.home.projectsRoot, { withFileTypes: true });
    } catch {
      entries = [];
    }
    const registrations: ProjectRegistration[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        registrations.push(await this.load(entry.name));
      } catch {
        // Skip incomplete/corrupt project directories during list.
      }
    }
    return registrations.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async load(projectKey: string): Promise<ProjectRegistration> {
    const registrationPath = path.join(this.home.projectsRoot, projectKey, "registration.json");
    const raw: unknown = JSON.parse(await readFile(registrationPath, "utf8"));
    return ProjectRegistrationSchema.parse(raw);
  }

  async get(projectKey: string): Promise<ProjectLookupResult> {
    const registration = await this.load(projectKey);
    return this.toLookup(registration);
  }

  /**
   * Discovery order: explicit project key → repository path → cwd repository root.
   * Throws an actionable error when nothing matches.
   */
  async discover(options: DiscoverProjectOptions = {}): Promise<ProjectLookupResult> {
    if (options.projectKey?.trim()) {
      return this.get(options.projectKey.trim());
    }

    const candidates = await this.list();
    if (options.repository?.trim()) {
      const repository = path.resolve(options.repository.trim());
      const match = await this.findByControlRoot(candidates, repository);
      if (match) return this.toLookup(match);
      throw new HarnessFailure(
        `No project registration matches repository ${repository}. ` +
          `Register it with: agent-harness project add --repository "${repository}"`,
        "config",
        false,
      );
    }

    const cwd = path.resolve(options.cwd ?? process.cwd());
    const repoRoot = (await resolveGitToplevel(cwd)) ?? cwd;
    const match = await this.findByControlRoot(candidates, repoRoot);
    if (match) return this.toLookup(match);

    throw new HarnessFailure(
      `No project registration found for ${repoRoot}. ` +
        `Register it with: agent-harness project add --repository "${repoRoot}"`,
      "config",
      false,
    );
  }

  async add(options: AddProjectOptions): Promise<ProjectLookupResult> {
    await this.ensureHomeLayout();
    const controlRoot = path.resolve(options.repository);
    await assertDirectory(controlRoot);

    const existing = await this.findByControlRoot(await this.list(), controlRoot);
    if (existing) {
      throw new HarnessFailure(
        `Repository ${controlRoot} is already registered as project ${existing.projectKey} (${existing.displayName}).`,
        "config",
        false,
      );
    }

    const identity = await inspectGitIdentity(controlRoot);
    const now = (options.now ?? (() => new Date()))().toISOString();
    const projectKey = generateProjectKey();
    const displayName = options.name?.trim() || path.basename(controlRoot) || projectKey;
    const paths = resolveProjectPaths({
      projectKey,
      controlRoot,
      home: this.home,
      worktreeRoot: options.worktreeRoot,
    });

    const registration: ProjectRegistration = {
      version: PROJECT_REGISTRATION_VERSION,
      projectKey,
      displayName,
      controlRoot: canonicalizeWorkspacePath(controlRoot),
      canonicalControlRoot: canonicalizeWorkspacePath(identity.canonicalRoot),
      ...(identity.gitCommonDir
        ? { gitCommonDir: canonicalizeWorkspacePath(identity.gitCommonDir) }
        : {}),
      ...(identity.remoteFingerprint ? { remoteFingerprint: identity.remoteFingerprint } : {}),
      ...(options.worktreeRoot?.trim()
        ? { worktreeRoot: canonicalizeWorkspacePath(paths.worktreeRoot) }
        : {}),
      createdAt: now,
      updatedAt: now,
    };

    await mkdir(paths.projectStateRoot, { recursive: true });
    await mkdir(paths.runsRoot, { recursive: true });
    await mkdir(paths.projectKnowledgeRoot, { recursive: true });
    await mkdir(paths.projectLocksRoot, { recursive: true });
    await mkdir(paths.projectGuidanceRoot, { recursive: true });
    await writeAtomicJson(paths.registrationPath, registration);
    await ensureWorktreeRootOwnership(paths);

    return this.toLookup(registration);
  }

  async relink(options: RelinkProjectOptions): Promise<ProjectLookupResult> {
    const current = await this.load(options.projectKey);
    const controlRoot = path.resolve(options.repository);
    await assertDirectory(controlRoot);

    const duplicate = await this.findByControlRoot(await this.list(), controlRoot);
    if (duplicate && duplicate.projectKey !== current.projectKey) {
      throw new HarnessFailure(
        `Cannot relink: ${controlRoot} is already registered as project ${duplicate.projectKey}.`,
        "config",
        false,
      );
    }

    const identity = await inspectGitIdentity(controlRoot);
    await assertRelinkIdentity(current, identity);

    const now = (options.now ?? (() => new Date()))().toISOString();
    const updated: ProjectRegistration = {
      ...current,
      controlRoot: canonicalizeWorkspacePath(controlRoot),
      canonicalControlRoot: canonicalizeWorkspacePath(identity.canonicalRoot),
      ...(identity.gitCommonDir
        ? { gitCommonDir: canonicalizeWorkspacePath(identity.gitCommonDir) }
        : { gitCommonDir: undefined }),
      ...(identity.remoteFingerprint
        ? { remoteFingerprint: identity.remoteFingerprint }
        : {}),
      updatedAt: now,
    };

    // Drop optional undefined keys for stable JSON.
    if (!identity.gitCommonDir) delete (updated as { gitCommonDir?: string }).gitCommonDir;

    const paths = resolveProjectPaths({
      projectKey: updated.projectKey,
      controlRoot,
      home: this.home,
      worktreeRoot: updated.worktreeRoot,
    });
    await writeAtomicJson(paths.registrationPath, updated);
    await ensureWorktreeRootOwnership(paths);
    return this.toLookup(updated);
  }

  /**
   * Remove a registration only when no active runs / registered worktrees remain.
   * Never deletes or modifies the target repository.
   */
  async remove(projectKey: string, options: { force?: boolean } = {}): Promise<ProjectRegistration> {
    const lookup = await this.get(projectKey);
    const active = await listActiveRunIds(lookup.paths.runsRoot);
    if (active.length > 0 && !options.force) {
      throw new HarnessFailure(
        `Cannot remove project ${projectKey}: active or unsettled runs remain (${active.slice(0, 5).join(", ")}). ` +
          "Complete/cleanup runs first, or pass --force after reviewing storage usage.",
        "config",
        false,
      );
    }
    await rm(lookup.paths.projectStateRoot, { recursive: true, force: true });
    return lookup.registration;
  }

  async validate(projectKey: string): Promise<{
    ok: boolean;
    issues: string[];
    registration: ProjectRegistration;
  }> {
    const lookup = await this.get(projectKey);
    const issues: string[] = [];
    try {
      await assertDirectory(lookup.paths.controlRoot);
    } catch {
      issues.push(`Control root missing or not a directory: ${lookup.paths.controlRoot}`);
    }

    if (issues.length === 0) {
      const identity = await inspectGitIdentity(lookup.paths.controlRoot);
      if (
        lookup.registration.gitCommonDir &&
        identity.gitCommonDir &&
        !pathsEqual(lookup.registration.gitCommonDir, identity.gitCommonDir)
      ) {
        issues.push(
          `Git common directory mismatch (registered ${lookup.registration.gitCommonDir}, current ${identity.gitCommonDir}). Use project relink after verifying identity.`,
        );
      }
      if (
        lookup.registration.remoteFingerprint &&
        identity.remoteFingerprint &&
        lookup.registration.remoteFingerprint !== identity.remoteFingerprint
      ) {
        issues.push(
          "Remote fingerprint mismatch. Use project relink after confirming this is the intended clone.",
        );
      }
      if (!pathsEqual(lookup.registration.canonicalControlRoot, identity.canonicalRoot)) {
        issues.push(
          `Canonical control root moved (registered ${lookup.registration.canonicalControlRoot}, current ${identity.canonicalRoot}). Use: agent-harness project relink --project ${projectKey} --repository "${lookup.paths.controlRoot}"`,
        );
      }
    }

    return { ok: issues.length === 0, issues, registration: lookup.registration };
  }

  private toLookup(registration: ProjectRegistration): ProjectLookupResult {
    const paths = resolveProjectPaths({
      projectKey: registration.projectKey,
      controlRoot: registration.controlRoot,
      home: this.home,
      worktreeRoot: registration.worktreeRoot,
    });
    return { registration, paths, home: this.home };
  }

  private async findByControlRoot(
    registrations: ProjectRegistration[],
    controlRoot: string,
  ): Promise<ProjectRegistration | undefined> {
    const resolved = path.resolve(controlRoot);
    const canonical = canonicalizeWorkspacePath(resolved);
    for (const registration of registrations) {
      if (
        pathsEqual(registration.controlRoot, resolved) ||
        pathsEqual(registration.canonicalControlRoot, resolved) ||
        pathsEqual(registration.controlRoot, canonical) ||
        pathsEqual(registration.canonicalControlRoot, canonical)
      ) {
        return registration;
      }
    }
    // Also match when cwd is inside a registered repo (resolve git toplevel first in discover).
    return undefined;
  }
}

async function ensureWorktreeRootOwnership(paths: ProjectPaths): Promise<void> {
  await mkdir(paths.worktreeRoot, { recursive: true });
  const markerPath = path.join(paths.worktreeRoot, WORKTREE_ROOT_OWNERSHIP_FILE);
  const ownership: WorktreeRootOwnership = {
    version: 1,
    projectKey: paths.projectKey,
    controlRoot: canonicalizeWorkspacePath(paths.controlRoot),
    createdAt: new Date().toISOString(),
  };
  try {
    const existingRaw: unknown = JSON.parse(await readFile(markerPath, "utf8"));
    const existing = existingRaw as WorktreeRootOwnership;
    if (
      existing.projectKey &&
      existing.projectKey !== paths.projectKey &&
      !pathsEqual(existing.controlRoot ?? "", paths.controlRoot)
    ) {
      throw new HarnessFailure(
        `Worktree root ${paths.worktreeRoot} is already owned by project ${existing.projectKey}.`,
        "workspace",
        false,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) {
      if (error instanceof HarnessFailure) throw error;
    }
  }
  await writeAtomicJson(markerPath, ownership);
}

async function assertDirectory(directory: string): Promise<void> {
  let info;
  try {
    info = await stat(directory);
  } catch {
    throw new HarnessFailure(`${directory} does not exist`, "config", false);
  }
  if (!info.isDirectory()) {
    throw new HarnessFailure(`${directory} is not a directory`, "config", false);
  }
}

async function assertRelinkIdentity(
  current: ProjectRegistration,
  identity: Awaited<ReturnType<typeof inspectGitIdentity>>,
): Promise<void> {
  if (
    current.gitCommonDir &&
    identity.gitCommonDir &&
    !pathsEqual(current.gitCommonDir, identity.gitCommonDir) &&
    current.remoteFingerprint &&
    identity.remoteFingerprint &&
    current.remoteFingerprint !== identity.remoteFingerprint
  ) {
    throw new HarnessFailure(
      "Git identity mismatch on relink: both common dir and remote fingerprint differ. " +
        "Register a new project if this is a distinct clone.",
      "config",
      false,
    );
  }
}

async function listActiveRunIds(runsRoot: string): Promise<string[]> {
  const entries = await readdir(runsRoot, { withFileTypes: true }).catch(() => []);
  const active: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const stateRaw: unknown = JSON.parse(
        await readFile(path.join(runsRoot, entry.name, "state.json"), "utf8"),
      );
      const phase =
        typeof stateRaw === "object" &&
        stateRaw !== null &&
        "phase" in stateRaw &&
        typeof (stateRaw as { phase: unknown }).phase === "string"
          ? (stateRaw as { phase: string }).phase
          : undefined;
      if (phase && phase !== "completed" && phase !== "cancelled") {
        active.push(entry.name);
      }
    } catch {
      // Missing/corrupt state still blocks removal conservatively.
      active.push(entry.name);
    }
  }
  return active;
}

type GitIdentity = {
  canonicalRoot: string;
  gitCommonDir?: string;
  remoteFingerprint?: string;
};

async function inspectGitIdentity(controlRoot: string): Promise<GitIdentity> {
  const toplevel = await resolveGitToplevel(controlRoot);
  const canonicalRoot = toplevel ?? controlRoot;
  const gitCommonDir = await gitRevParse(controlRoot, "--git-common-dir");
  const remoteUrl = await gitConfig(controlRoot, "remote.origin.url");
  return {
    canonicalRoot: path.resolve(canonicalRoot),
    ...(gitCommonDir
      ? { gitCommonDir: path.resolve(controlRoot, gitCommonDir) }
      : {}),
    ...(remoteFingerprintFromUrl(remoteUrl)
      ? { remoteFingerprint: remoteFingerprintFromUrl(remoteUrl) }
      : {}),
  };
}

async function resolveGitToplevel(cwd: string): Promise<string | undefined> {
  const value = await gitRevParse(cwd, "--show-toplevel");
  return value ? path.resolve(value) : undefined;
}

async function gitRevParse(cwd: string, flag: string): Promise<string | undefined> {
  const result = await runGit(cwd, ["rev-parse", flag]);
  if (result.exitCode !== 0) return undefined;
  const trimmed = result.stdout.trim();
  return trimmed || undefined;
}

async function gitConfig(cwd: string, key: string): Promise<string | undefined> {
  const result = await runGit(cwd, ["config", "--get", key]);
  if (result.exitCode !== 0) return undefined;
  const trimmed = result.stdout.trim();
  return trimmed || undefined;
}

function runGit(
  cwd: string,
  args: string[],
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
    child.once("error", reject);
    child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}

async function writeAtomicJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, filePath);
}
