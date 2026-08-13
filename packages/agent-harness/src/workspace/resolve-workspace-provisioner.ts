import type { HarnessConfig } from "../config/schema.js";
import type { RunStore } from "../store.js";
import type { HarnessPaths } from "../application/paths.js";
import type { DockerClient } from "../infrastructure/container/types.js";
import { createDockerClient } from "../infrastructure/container/docker-client.js";
import { DockerCloneProvisioner } from "./docker-clone-provisioner.js";
import { LocalWorktreeProvisioner } from "./local-worktree-provisioner.js";
import type { WorkspaceProvisioner } from "./types.js";

export type ResolveWorkspaceProvisionerOptions = {
  paths: HarnessPaths;
  store: RunStore;
  docker?: DockerClient;
  projectKey?: string;
  /** Test seam for DockerCloneProvisioner host-side materialization. */
  hostMaterializeRoot?: string;
};

/**
 * Select a workspace provisioner from frozen/project execution policy.
 * Docker mode uses seed-bundle clones (ADR 0015); local mode uses linked worktrees.
 */
export function resolveWorkspaceProvisioner(
  config: HarnessConfig,
  options: ResolveWorkspaceProvisionerOptions,
): WorkspaceProvisioner {
  const runtime = config.execution?.runtime ?? "local";
  if (runtime === "docker") {
    return new DockerCloneProvisioner({
      config,
      paths: options.paths,
      store: options.store,
      docker: options.docker ?? createDockerClient(),
      projectKey: options.projectKey,
      hostMaterializeRoot: options.hostMaterializeRoot,
    });
  }
  return new LocalWorktreeProvisioner({
    controlRoot: options.paths.controlRoot,
    stateRoot: options.paths.stateRoot,
    worktreeRoot: options.paths.worktreeRoot,
    store: options.store,
  });
}
