import path from "node:path";
import type { HarnessConfig } from "../config/schema.js";
import type { RunWorkspace } from "../domain/workspace.js";
import type { ProjectPaths } from "./harness-home.js";

/**
 * Worker-visible workspace root inside a Docker run container.
 */
export const WORKER_WORKSPACE_PATH = "/workspace" as const;

/** Runtime filesystem roots for control-plane state vs run-scoped execution. */
export type HarnessPaths = {
  controlRoot: string;
  stateRoot: string;
  workspaceRoot: string;
};

/**
 * Derive harness roots from project/run config and optional workspace metadata.
 * Host worktrees use the host path; git-disabled stays on the control root.
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
  const workspaceRoot = resolveExecutionWorkspaceRoot(workspace, controlRoot);
  return {
    controlRoot,
    stateRoot,
    workspaceRoot,
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
 * Host worktrees use the host path so the host can commit; sandboxes still
 * see `/workspace`. Git-disabled uses the control root.
 */
export function resolveExecutionWorkspaceRoot(
  workspace: RunWorkspace | null | undefined,
  controlRootFallback: string,
): string {
  if (workspace?.kind === "host-worktree") {
    return path.resolve(workspace.worktreePath);
  }
  return path.resolve(controlRootFallback);
}

