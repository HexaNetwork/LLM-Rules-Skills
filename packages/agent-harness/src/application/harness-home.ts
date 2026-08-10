import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalizeWorkspacePath, isWorktreePathContained } from "../domain/workspace.js";
import { HarnessFailure } from "../errors.js";

export const HARNESS_HOME_ENV = "AGENT_HARNESS_HOME";
export const WORKTREE_ROOT_OWNERSHIP_FILE = ".agent-harness-worktree-root.json";

/** Platform-appropriate harness home layout (control plane, not execution data). */
export type HarnessHomePaths = {
  homeRoot: string;
  projectsRoot: string;
  sharedGuidanceRoot: string;
  workflowsRoot: string;
  agentsRoot: string;
};

/** Per-registered-project roots derived from harness home + control root. */
export type ProjectPaths = {
  projectKey: string;
  controlRoot: string;
  worktreeRoot: string;
  projectStateRoot: string;
  projectKnowledgeRoot: string;
  projectLocksRoot: string;
  projectConfigPath: string;
  projectGuidanceRoot: string;
  registrationPath: string;
  runsRoot: string;
};

export type ResolveHarnessHomeOptions = {
  /** Explicit home root override (CLI/config). Absolute or relative to cwd. */
  homeRoot?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: () => string;
  cwd?: string;
};

export type DeriveProjectPathsOptions = {
  projectKey: string;
  controlRoot: string;
  home?: HarnessHomePaths;
  /** Explicit worktree root override; otherwise sibling `<name>-worktrees`. */
  worktreeRoot?: string;
};

export type WorktreeRootOwnership = {
  version: 1;
  projectKey: string;
  controlRoot: string;
  createdAt: string;
};

/**
 * Resolve the durable harness home. Never defaults to cwd, the target repo,
 * or a relative stateDirectory.
 */
export function resolveHarnessHome(options: ResolveHarnessHomeOptions = {}): HarnessHomePaths {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homedir = options.homedir ?? os.homedir;
  const cwd = options.cwd ?? process.cwd();

  let homeRoot: string;
  if (options.homeRoot?.trim()) {
    homeRoot = path.resolve(cwd, options.homeRoot.trim());
  } else if (env[HARNESS_HOME_ENV]?.trim()) {
    homeRoot = path.resolve(cwd, env[HARNESS_HOME_ENV]!.trim());
  } else {
    homeRoot = defaultHarnessHomeRoot(platform, homedir, env);
  }

  const resolved = path.resolve(homeRoot);
  return {
    homeRoot: resolved,
    projectsRoot: path.join(resolved, "projects"),
    sharedGuidanceRoot: path.join(resolved, "guidance"),
    workflowsRoot: path.join(resolved, "workflows"),
    agentsRoot: path.join(resolved, "agents"),
  };
}

/** Platform default home root (no env/CLI override). */
export function defaultHarnessHomeRoot(
  platform: NodeJS.Platform = process.platform,
  homedir: () => string = os.homedir,
  env: NodeJS.ProcessEnv = process.env,
): string {
  // Use the target platform's path grammar so convention tests stay accurate when
  // the host OS differs from the simulated platform (e.g. Linux defaults on Windows CI).
  if (platform === "win32") {
    const win = path.win32;
    const localAppData =
      env.LOCALAPPDATA?.trim() || win.join(homedir(), "AppData", "Local");
    return win.join(localAppData, "agent-harness");
  }
  const posix = path.posix;
  if (platform === "darwin") {
    return posix.join(homedir(), "Library", "Application Support", "agent-harness");
  }
  const xdgState = env.XDG_STATE_HOME?.trim();
  if (xdgState) {
    const root = posix.isAbsolute(xdgState) ? xdgState : posix.join(homedir(), xdgState);
    return posix.join(root, "agent-harness");
  }
  return posix.join(homedir(), ".local", "state", "agent-harness");
}

/** Derive sibling worktree root: `<parent>/<basename>-worktrees`. */
export function deriveSiblingWorktreeRoot(controlRoot: string): string {
  const resolved = path.resolve(controlRoot);
  const parent = path.dirname(resolved);
  const name = path.basename(resolved);
  if (!name || name === path.sep || name === ".") {
    throw new HarnessFailure(
      `Cannot derive sibling worktree root from control root ${resolved}`,
      "workspace",
      false,
    );
  }
  return path.join(parent, `${name}-worktrees`);
}

export function resolveProjectPaths(options: DeriveProjectPathsOptions): ProjectPaths {
  const home = options.home ?? resolveHarnessHome();
  const controlRoot = path.resolve(options.controlRoot);
  const projectRoot = path.join(home.projectsRoot, options.projectKey);
  const worktreeRoot = path.resolve(
    options.worktreeRoot?.trim() ? options.worktreeRoot : deriveSiblingWorktreeRoot(controlRoot),
  );

  assertWorktreeRootOutsideControlRoot(worktreeRoot, controlRoot);

  return {
    projectKey: options.projectKey,
    controlRoot,
    worktreeRoot,
    projectStateRoot: projectRoot,
    projectKnowledgeRoot: path.join(projectRoot, "knowledge"),
    projectLocksRoot: path.join(projectRoot, "locks"),
    projectConfigPath: path.join(projectRoot, "config.yaml"),
    projectGuidanceRoot: path.join(projectRoot, "guidance"),
    registrationPath: path.join(projectRoot, "registration.json"),
    runsRoot: path.join(projectRoot, "runs"),
  };
}

/** True when `candidate` is exactly controlRoot or a path beneath it. */
export function isPathUnderControlRoot(candidate: string, controlRoot: string): boolean {
  return isWorktreePathContained(candidate, controlRoot);
}

export function assertWorktreeRootOutsideControlRoot(
  worktreeRoot: string,
  controlRoot: string,
): void {
  if (isPathUnderControlRoot(worktreeRoot, controlRoot)) {
    throw new HarnessFailure(
      `Worktree root must be outside the target repository (${canonicalizeWorkspacePath(controlRoot)}): ${canonicalizeWorkspacePath(worktreeRoot)}`,
      "workspace",
      false,
    );
  }
}

/**
 * Validate a worktree root before create/remove: outside control root, expected
 * sibling or explicit override, and no symlink/junction escape into the repo.
 */
export function validateWorktreeRootPlacement(options: {
  worktreeRoot: string;
  controlRoot: string;
  /** When true, require exact sibling `<name>-worktrees` (no override). */
  requireDerivedSibling?: boolean;
  /** Optional configured override that is permitted instead of the sibling. */
  configuredOverride?: string;
}): { canonicalWorktreeRoot: string; derivedSibling: string } {
  const controlRoot = path.resolve(options.controlRoot);
  const worktreeRoot = path.resolve(options.worktreeRoot);
  const derivedSibling = deriveSiblingWorktreeRoot(controlRoot);
  const override = options.configuredOverride?.trim()
    ? path.resolve(options.configuredOverride)
    : undefined;

  assertWorktreeRootOutsideControlRoot(worktreeRoot, controlRoot);

  const canonicalWorktreeRoot = canonicalizeExistingPath(worktreeRoot);
  const canonicalControl = canonicalizeExistingPath(controlRoot);
  assertWorktreeRootOutsideControlRoot(canonicalWorktreeRoot, canonicalControl);

  const matchesSibling = pathsEqual(canonicalWorktreeRoot, canonicalizeExistingPath(derivedSibling));
  const matchesOverride =
    override != null && pathsEqual(canonicalWorktreeRoot, canonicalizeExistingPath(override));

  if (options.requireDerivedSibling && !matchesSibling) {
    throw new HarnessFailure(
      `Worktree root must be the derived sibling path ${canonicalizeWorkspacePath(derivedSibling)}`,
      "workspace",
      false,
    );
  }
  if (!matchesSibling && !matchesOverride) {
    throw new HarnessFailure(
      `Worktree root ${canonicalizeWorkspacePath(worktreeRoot)} is neither the derived sibling ` +
        `${canonicalizeWorkspacePath(derivedSibling)}` +
        (override ? ` nor the configured override ${canonicalizeWorkspacePath(override)}` : "") +
        ".",
      "workspace",
      false,
    );
  }

  return { canonicalWorktreeRoot, derivedSibling };
}

export function generateProjectKey(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

/** Stable fingerprint for discovery evidence (not the sole project identifier). */
export function remoteFingerprintFromUrl(remoteUrl: string | undefined): string | undefined {
  const trimmed = remoteUrl?.trim();
  if (!trimmed) return undefined;
  return createHash("sha256").update(trimmed).digest("hex").slice(0, 16);
}

export function pathsEqual(left: string, right: string): boolean {
  const a = canonicalizeWorkspacePath(left);
  const b = canonicalizeWorkspacePath(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function canonicalizeExistingPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return path.resolve(realpathSync(resolved));
  } catch {
    return resolved;
  }
}
