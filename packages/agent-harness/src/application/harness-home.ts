import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { canonicalizeWorkspacePath } from "../domain/workspace.js";

export const HARNESS_HOME_ENV = "AGENT_HARNESS_HOME";

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

export function resolveProjectPaths(options: DeriveProjectPathsOptions): ProjectPaths {
  const home = options.home ?? resolveHarnessHome();
  const controlRoot = path.resolve(options.controlRoot);
  const projectRoot = path.join(home.projectsRoot, options.projectKey);
  return {
    projectKey: options.projectKey,
    controlRoot,
    projectStateRoot: projectRoot,
    projectKnowledgeRoot: path.join(projectRoot, "knowledge"),
    projectLocksRoot: path.join(projectRoot, "locks"),
    projectConfigPath: path.join(projectRoot, "config.yaml"),
    projectGuidanceRoot: path.join(projectRoot, "guidance"),
    registrationPath: path.join(projectRoot, "registration.json"),
    runsRoot: path.join(projectRoot, "runs"),
  };
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

