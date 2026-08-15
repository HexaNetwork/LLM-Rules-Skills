import type { RunWorkspace } from "../domain/workspace.js";
import { HarnessFailure } from "../errors.js";
import { assertCloneReopenInvariants } from "../git/bundle-transport.js";
import { WORKER_WORKSPACE_PATH } from "../application/paths.js";
import type {
  WorkspaceCleanupInspection,
  WorkspaceInspection,
  WorkspaceProvisioner,
} from "./types.js";

export type WorkerWorkspaceProvisionerOptions = {
  /** Clone root as the worker sees it (the mounted workspace volume). */
  workspacePath?: string;
};

/**
 * In-container provisioner. The worker already holds the clone at its workspace
 * mount and has no Docker CLI, so reopen validates clone identity locally
 * instead of inspecting host volumes. Provisioning and removal stay host-owned.
 */
export class WorkerWorkspaceProvisioner implements WorkspaceProvisioner {
  constructor(private readonly options: WorkerWorkspaceProvisionerOptions = {}) {}

  async create(): Promise<RunWorkspace> {
    throw hostOnly("Creating a run workspace");
  }

  async open(workspace: RunWorkspace): Promise<RunWorkspace> {
    await this.cloneFacts(workspace);
    return workspace;
  }

  async inspect(workspace: RunWorkspace): Promise<WorkspaceInspection> {
    const facts = await this.cloneFacts(workspace);
    const workspacePath = this.workspacePath();
    return {
      path: workspacePath,
      toplevel: workspacePath,
      headSha: facts.headSha,
      gitCommonDir: `${workspacePath}/.git`,
      detached: true,
      registered: true,
    };
  }

  async inspectCleanupTarget(): Promise<WorkspaceCleanupInspection> {
    throw hostOnly("Inspecting a workspace for cleanup");
  }

  async remove(): Promise<void> {
    throw hostOnly("Removing a run workspace");
  }

  private workspacePath(): string {
    return this.options.workspacePath ?? WORKER_WORKSPACE_PATH;
  }

  private async cloneFacts(
    workspace: RunWorkspace,
  ): Promise<{ headSha: string; dirty: boolean }> {
    if (workspace.kind !== "docker-clone") {
      throw new HarnessFailure(
        `Worker requires a docker-clone workspace; received ${workspace.kind}`,
        "workspace",
        false,
      );
    }
    return assertCloneReopenInvariants({
      workspacePath: this.workspacePath(),
      expected: {
        baseSha: workspace.baseSha,
        seedBundleHash: workspace.seedBundleHash,
        generation: workspace.generation,
      },
    });
  }
}

function hostOnly(action: string): HarnessFailure {
  return new HarnessFailure(
    `${action} is host-owned; the worker cannot manage Docker workspaces.`,
    "workspace",
    false,
  );
}
