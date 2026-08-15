import type { RunWorkspace } from "../domain/workspace.js";

export type CreateWorkspaceInput = {
  runId: string;
  baseBranch: string;
  baseSha?: string;
  branchName?: string;
  createdAt?: string;
};

export type WorkspaceInspection = {
  path: string;
  toplevel: string;
  headSha: string;
  gitCommonDir: string;
  detached: boolean;
  registered: boolean;
};

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

/**
 * Port for creating, reopening, inspecting, and removing run execution workspaces.
 * Production implementations provision a seed-bundle clone in a Docker volume.
 */
export type WorkspaceProvisioner = {
  create(input: CreateWorkspaceInput): Promise<RunWorkspace>;
  open(workspace: RunWorkspace): Promise<RunWorkspace>;
  inspect(workspace: RunWorkspace): Promise<WorkspaceInspection>;
  inspectCleanupTarget(workspace: RunWorkspace): Promise<WorkspaceCleanupInspection>;
  remove(workspace: RunWorkspace, runId: string, options?: WorkspaceRemoveOptions): Promise<void>;
};
