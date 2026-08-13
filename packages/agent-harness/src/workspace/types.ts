import type { RunWorkspace } from "../domain/workspace.js";
import type {
  CreateWorktreeInput,
  WorktreeInspection,
} from "../git/worktree-manager.js";

/** Facts gathered for conservative workspace cleanup without mutation. */
export type WorkspaceCleanupInspection = {
  pathValid: boolean;
  registered: boolean;
  gitCommonDirMatches: boolean;
  dirty: boolean;
  headSha: string | undefined;
  commitsReachableFromRetainedRef: boolean;
};

export type WorkspaceRemoveOptions = {
  /** Docker: also remove the named workspace volume (only after cleanup decision). */
  removeVolume?: boolean;
};

export type CreateWorkspaceInput = CreateWorktreeInput;

/**
 * Port for creating, reopening, inspecting, and removing run execution workspaces.
 * Local mode wraps WorktreeManager; Docker mode uses seed-bundle clones (ADR 0015).
 */
export type WorkspaceProvisioner = {
  readonly runtime: "local" | "docker";
  create(input: CreateWorkspaceInput): Promise<RunWorkspace>;
  open(workspace: RunWorkspace): Promise<RunWorkspace>;
  inspect(workspace: RunWorkspace): Promise<WorktreeInspection>;
  inspectCleanupTarget(workspace: RunWorkspace): Promise<WorkspaceCleanupInspection>;
  remove(workspace: RunWorkspace, runId: string, options?: WorkspaceRemoveOptions): Promise<void>;
};
