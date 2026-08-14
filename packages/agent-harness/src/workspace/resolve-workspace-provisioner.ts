import type { HarnessConfig } from "../config/schema.js";
import type { RunRepository } from "../application/run-repository.js";
import type { HarnessPaths } from "../application/paths.js";
import type { DockerClient } from "../infrastructure/container/types.js";
import { createDockerClient } from "../infrastructure/container/docker-client.js";
import { DockerCloneProvisioner } from "./docker-clone-provisioner.js";
import type { WorkspaceProvisioner } from "./types.js";

export type ResolveWorkspaceProvisionerOptions = {
  paths: HarnessPaths;
  store: RunRepository;
  docker?: DockerClient;
  projectKey?: string;
  /** Test seam for DockerCloneProvisioner host-side materialization. */
  hostMaterializeRoot?: string;
};

/**
 * Compose the sole production workspace provider: a seed-bundle Docker clone.
 */
export function resolveWorkspaceProvisioner(
  config: HarnessConfig,
  options: ResolveWorkspaceProvisionerOptions,
): WorkspaceProvisioner {
  const docker = options.docker ?? createDockerClient();
  return new DockerCloneProvisioner({
    config,
    paths: options.paths,
    store: options.store,
    docker,
    projectKey: options.projectKey,
    hostMaterializeRoot: options.hostMaterializeRoot,
  });
}
