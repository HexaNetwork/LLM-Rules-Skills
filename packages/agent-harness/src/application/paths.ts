import path from "node:path";
import type { HarnessConfig } from "../config/schema.js";
import type { RunWorkspace } from "../domain/workspace.js";
import {
  deriveSiblingWorktreeRoot,
  isPathUnderControlRoot,
  type ProjectPaths,
} from "./harness-home.js";

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
 * `git-worktree` runs execute in the recorded worktree; legacy/git-disabled stay
 * on the control root.
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
  const workspaceRoot =
    workspace?.kind === "git-worktree" && workspace.worktreePath
      ? path.resolve(workspace.worktreePath)
      : controlRoot;
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
  const workspaceRoot =
    workspace?.kind === "git-worktree" && workspace.worktreePath
      ? path.resolve(workspace.worktreePath)
      : project.controlRoot;
  return {
    controlRoot: path.resolve(project.controlRoot),
    stateRoot: path.resolve(project.projectStateRoot),
    workspaceRoot,
    worktreeRoot: path.resolve(project.worktreeRoot),
  };
}

/** Mutate an existing paths object so services holding the reference see updates. */
export function applyWorkspaceToPaths(paths: HarnessPaths, workspace: RunWorkspace): void {
  paths.workspaceRoot =
    workspace.kind === "git-worktree" && workspace.worktreePath
      ? path.resolve(workspace.worktreePath)
      : paths.controlRoot;
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
