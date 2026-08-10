import path from "node:path";
import type { HarnessConfig } from "../config/schema.js";
import type { RunWorkspace } from "../domain/workspace.js";

/** Runtime filesystem roots for control-plane state vs run-scoped execution. */
export type HarnessPaths = {
  controlRoot: string;
  stateRoot: string;
  workspaceRoot: string;
};

/**
 * Derive harness roots from project/run config and optional workspace metadata.
 * `git-worktree` runs execute in the recorded worktree; legacy/git-disabled stay
 * on the control root.
 */
export function resolveHarnessPaths(
  config: HarnessConfig,
  workspace?: RunWorkspace | null,
): HarnessPaths {
  const controlRoot = path.resolve(config.repositoryRoot);
  const stateRoot = path.resolve(controlRoot, config.stateDirectory);
  const workspaceRoot =
    workspace?.kind === "git-worktree" && workspace.worktreePath
      ? path.resolve(workspace.worktreePath)
      : controlRoot;
  return {
    controlRoot,
    stateRoot,
    workspaceRoot,
  };
}

/** Mutate an existing paths object so services holding the reference see updates. */
export function applyWorkspaceToPaths(paths: HarnessPaths, workspace: RunWorkspace): void {
  paths.workspaceRoot =
    workspace.kind === "git-worktree" && workspace.worktreePath
      ? path.resolve(workspace.worktreePath)
      : paths.controlRoot;
}
