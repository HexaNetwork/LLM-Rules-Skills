import {
  WorktreeManager,
  type WorktreeManagerOptions,
} from "../git/worktree-manager.js";
import type { RunWorkspace } from "../domain/workspace.js";
import type {
  CreateWorkspaceInput,
  WorkspaceCleanupInspection,
  WorkspaceProvisioner,
} from "./types.js";

/**
 * Local execution runtime: linked Git worktrees via WorktreeManager (ADR 0010).
 */
export class LocalWorktreeProvisioner implements WorkspaceProvisioner {
  readonly runtime = "local" as const;
  private readonly manager: WorktreeManager;

  constructor(options: WorktreeManagerOptions) {
    this.manager = new WorktreeManager(options);
  }

  create(input: CreateWorkspaceInput): Promise<RunWorkspace> {
    return this.manager.create(input);
  }

  open(workspace: RunWorkspace): Promise<RunWorkspace> {
    return this.manager.open(workspace);
  }

  inspect(workspace: RunWorkspace) {
    return this.manager.inspect(workspace);
  }

  inspectCleanupTarget(workspace: RunWorkspace): Promise<WorkspaceCleanupInspection> {
    return this.manager.inspectCleanupTarget(workspace);
  }

  remove(workspace: RunWorkspace, runId: string): Promise<void> {
    return this.manager.removeRegisteredWorktree(workspace, runId);
  }
}
