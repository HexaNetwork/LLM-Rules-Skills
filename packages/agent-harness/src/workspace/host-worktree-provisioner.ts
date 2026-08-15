import path from "node:path";
import type { HarnessPaths } from "../application/paths.js";
import type { RunRepository } from "../application/run-repository.js";
import type { RunWorkspace } from "../domain/workspace.js";
import { WorktreeManager } from "../git/worktree-manager.js";
import type {
  CreateWorkspaceInput,
  WorkspaceCleanupInspection,
  WorkspaceInspection,
  WorkspaceProvisioner,
} from "./types.js";

export type HostWorktreeProvisionerOptions = {
  paths: HarnessPaths;
  store: RunRepository;
  worktreeRoot?: string;
};

/**
 * Canonical worker-visible workspace: a host Git worktree bind-mounted at `/workspace`.
 */
export class HostWorktreeProvisioner implements WorkspaceProvisioner {
  private readonly manager: WorktreeManager;

  constructor(options: HostWorktreeProvisionerOptions) {
    this.manager = new WorktreeManager({
      controlRoot: options.paths.controlRoot,
      stateRoot: options.paths.stateRoot,
      worktreeRoot: options.worktreeRoot ?? path.join(options.paths.stateRoot, "worktrees"),
      store: options.store,
    });
  }

  create(input: CreateWorkspaceInput): Promise<RunWorkspace> {
    return this.manager.create(input);
  }

  open(workspace: RunWorkspace): Promise<RunWorkspace> {
    if (workspace.kind === "git-disabled") return Promise.resolve(workspace);
    return this.manager.open(workspace);
  }

  inspect(workspace: RunWorkspace): Promise<WorkspaceInspection> {
    return this.manager.inspect(workspace);
  }

  inspectCleanupTarget(workspace: RunWorkspace): Promise<WorkspaceCleanupInspection> {
    return this.manager.inspectCleanupTarget(workspace);
  }

  async remove(workspace: RunWorkspace, runId: string): Promise<void> {
    if (workspace.kind !== "host-worktree") return;
    await this.manager.removeRegisteredWorktree(workspace, runId);
  }
}
