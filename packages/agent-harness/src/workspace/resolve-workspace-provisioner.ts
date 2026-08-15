import type { HarnessConfig } from "../config/schema.js";
import type { RunRepository } from "../application/run-repository.js";
import type { HarnessPaths } from "../application/paths.js";
import { HostWorktreeProvisioner } from "./host-worktree-provisioner.js";
import type { WorkspaceProvisioner } from "./types.js";

export type ResolveWorkspaceProvisionerOptions = {
  paths: HarnessPaths;
  store: RunRepository;
  worktreeRoot?: string;
};

/**
 * Compose the sole production workspace provider: a host-owned Git worktree.
 */
export function resolveWorkspaceProvisioner(
  _config: HarnessConfig,
  options: ResolveWorkspaceProvisionerOptions,
): WorkspaceProvisioner {
  return new HostWorktreeProvisioner({
    paths: options.paths,
    store: options.store,
    worktreeRoot: options.worktreeRoot,
  });
}
