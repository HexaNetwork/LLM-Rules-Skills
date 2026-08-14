import { loadRunConfig, loadRunWorkspace } from "../config/io.js";
import type { HarnessConfig } from "../config/schema.js";
import type { RunWorkspace } from "../domain/workspace.js";
import { HarnessFailure } from "../errors.js";
import { WorkerHarnessRuntime } from "./harness-engine.js";
import { RunStore } from "../store.js";
import { resolveWorkspaceProvisioner } from "../workspace/index.js";
import type { HarnessDependencies } from "./dependencies.js";
import { resolveHarnessPaths, type HarnessPaths } from "./paths.js";

export type OpenedRunHarness = {
  engine: WorkerHarnessRuntime;
  config: HarnessConfig;
  paths: HarnessPaths;
  workspace: RunWorkspace;
};

export type OpenRunHarnessOptions = {
  /** When false, skip worktree registration checks (status/cancel/unlock). Default true. */
  validateWorktree?: boolean;
  /**
   * When true, missing workspace.json yields a provisional engine (no provisioner.open).
   * Used for host recovery and cancel/retry before the Docker clone exists.
   */
  allowMissingWorkspace?: boolean;
};

/**
 * Recompose a run engine from project defaults + frozen run config + workspace metadata.
 * Validates registered worktrees before returning unless `validateWorktree` is false.
 */
export async function openRunHarness(
  projectConfig: HarnessConfig,
  runId: string,
  dependencies: HarnessDependencies,
  options: OpenRunHarnessOptions = {},
): Promise<OpenedRunHarness> {
  // Prefer the caller's store run directory so Docker workers / external homes
  // still resolve artifacts when projectConfig.stateDirectory is a host path.
  const runDirectory = dependencies.store?.runDirectory(runId);
  const artifactOptions = runDirectory ? { runDirectory } : undefined;
  const config = await loadRunConfig(projectConfig, runId, artifactOptions);
  let workspace: RunWorkspace | undefined;
  try {
    workspace = await loadRunWorkspace(projectConfig, runId, artifactOptions);
  } catch (error) {
    const missing =
      error instanceof HarnessFailure && /workspace metadata is missing/i.test(error.message);
    if (!missing || options.allowMissingWorkspace !== true) throw error;
  }
  const paths = resolveHarnessPaths(config, workspace ?? null);

  const store = dependencies.store ?? new RunStore(config, paths.stateRoot);
  const workspaceProvisioner =
    dependencies.workspaceProvisioner ??
    resolveWorkspaceProvisioner(config, {
      paths,
      store,
      docker: dependencies.docker,
    });

  if (
    workspace &&
    (workspace.kind === "git-worktree" || workspace.kind === "docker-clone") &&
    options.validateWorktree !== false
  ) {
    await workspaceProvisioner.open(workspace);
  }

  const engine = new WorkerHarnessRuntime(config, {
    ...dependencies,
    paths,
    store,
    workspaceProvisioner,
  });
  if (workspace) engine.bindWorkspace(workspace);
  return { engine, config, paths, workspace: workspace ?? engine.workspace };
}
