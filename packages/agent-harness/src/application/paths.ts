import path from "node:path";
import type { HarnessConfig } from "../config/schema.js";
import type { RunWorkspace } from "../domain/workspace.js";
import {
  deriveSiblingWorktreeRoot,
  isPathUnderControlRoot,
  type ProjectPaths,
} from "./harness-home.js";

/**
 * Worker-visible workspace root inside a Docker run container.
 */
export const WORKER_WORKSPACE_PATH = "/workspace" as const;

/** Runtime filesystem roots for control-plane state vs run-scoped execution. */
export type HarnessPaths = {
  controlRoot: string;
  stateRoot: string;
  workspaceRoot: string;
  /** Parent directory for new run worktrees (sibling or configured override). */
  worktreeRoot: string;
};

/**
 * Derive harness roots from project/run config and optional workspace metadata.
 * `git-worktree` runs execute in the recorded worktree; `docker-clone` uses the
 * worker constant `/workspace`; git-disabled stays on the control root.
 *
 * Absolute `stateDirectory` values (external project state) are used as-is.
 * Relative values nest under `controlRoot` for legacy repository-local installs.
 */
export function resolveHarnessPaths(
  config: HarnessConfig,
  workspace?: RunWorkspace | null,
): HarnessPaths {
  const controlRoot = path.resolve(config.repositoryRoot);
  const stateRoot = path.isAbsolute(config.stateDirectory)
    ? path.resolve(config.stateDirectory)
    : path.resolve(controlRoot, config.stateDirectory);
  const worktreeRoot = resolveWorktreeRoot(config, controlRoot, stateRoot);
  const workspaceRoot = resolveExecutionWorkspaceRoot(workspace, controlRoot);
  return {
    controlRoot,
    stateRoot,
    workspaceRoot,
    worktreeRoot,
  };
}

/** Compose run-bound HarnessPaths from an external ProjectPaths + workspace metadata. */
export function harnessPathsFromProject(
  project: ProjectPaths,
  workspace?: RunWorkspace | null,
): HarnessPaths {
  const workspaceRoot = resolveExecutionWorkspaceRoot(workspace, project.controlRoot);
  return {
    controlRoot: path.resolve(project.controlRoot),
    stateRoot: path.resolve(project.projectStateRoot),
    workspaceRoot,
    worktreeRoot: path.resolve(project.worktreeRoot),
  };
}

/** Mutate an existing paths object so services holding the reference see updates. */
export function applyWorkspaceToPaths(paths: HarnessPaths, workspace: RunWorkspace): void {
  paths.workspaceRoot = resolveExecutionWorkspaceRoot(workspace, paths.controlRoot);
}

/**
 * Host-native path to a run's restartable execution.json (not the worker view).
 */
export function runExecutionStatePath(stateRoot: string, runId: string): string {
  return path.join(stateRoot, "runs", runId, "execution.json");
}

/**
 * Host-native transport directory for seed/result bundles under one run directory.
 */
export function runTransportDirectory(stateRoot: string, runId: string): string {
  return path.join(stateRoot, "runs", runId, "transport");
}

/** Host-native path to transport/import.json for bundle import state. */
export function runBundleImportPath(stateRoot: string, runId: string): string {
  return path.join(runTransportDirectory(stateRoot, runId), "import.json");
}

/**
 * Resolve the execution-root path for agents/commands given workspace metadata.
 * Local worktrees stay on the host path; Docker clones advertise `/workspace`.
 */
export function resolveExecutionWorkspaceRoot(
  workspace: RunWorkspace | null | undefined,
  controlRootFallback: string,
): string {
  if (workspace?.kind === "git-worktree" && workspace.worktreePath) {
    return path.resolve(workspace.worktreePath);
  }
  if (workspace?.kind === "docker-clone") {
    return WORKER_WORKSPACE_PATH;
  }
  return path.resolve(controlRootFallback);
}

/**
 * Prefer an explicit config.worktreeRoot; otherwise use the sibling convention when
 * state lives outside the control root, and legacy `<stateRoot>/worktrees` otherwise.
 */
function resolveWorktreeRoot(
  config: HarnessConfig,
  controlRoot: string,
  stateRoot: string,
): string {
  const configured = config.worktreeRoot?.trim();
  if (configured) {
    return path.isAbsolute(configured)
      ? path.resolve(configured)
      : path.resolve(controlRoot, configured);
  }
  if (!isPathUnderControlRoot(stateRoot, controlRoot)) {
    return deriveSiblingWorktreeRoot(controlRoot);
  }
  return path.join(stateRoot, "worktrees");
}
