import { loadRunConfig, loadRunWorkspace } from "../config/io.js";
import type { HarnessConfig } from "../config/schema.js";
import type { RunWorkspace } from "../domain/workspace.js";
import { HarnessFailure } from "../errors.js";
import { WorkerHarnessRuntime } from "./harness-engine.js";
import { HostRunControl } from "./host-run-control.js";
import { RunStore } from "../store.js";
import { resolveWorkspaceProvisioner } from "../workspace/index.js";
import type { HarnessDependencies } from "./dependencies.js";
import { resolveHarnessPaths, type HarnessPaths } from "./paths.js";

export type OpenedHostRunControl = {
  control: HostRunControl;
  config: HarnessConfig;
  paths: HarnessPaths;
  workspace: RunWorkspace;
};

export type OpenedRunHarness = {
  engine: WorkerHarnessRuntime;
  config: HarnessConfig;
  paths: HarnessPaths;
  workspace: RunWorkspace;
};

export type OpenRunHarnessOptions = {
  /** When false, skip Docker workspace identity checks. Default true. */
  validateWorkspace?: boolean;
  /**
   * When true, missing workspace.json yields a provisional control surface
   * (no provisioner.open). Used for host recovery and cancel/retry before the
   * Docker clone exists.
   */
  allowMissingWorkspace?: boolean;
};

type ResolvedRunArtifacts = {
  config: HarnessConfig;
  paths: HarnessPaths;
  workspace: RunWorkspace | undefined;
  store: NonNullable<HarnessDependencies["store"]> | RunStore;
  workspaceProvisioner: ReturnType<typeof resolveWorkspaceProvisioner>;
  dependencies: HarnessDependencies;
};

async function resolveRunArtifacts(
  projectConfig: HarnessConfig,
  runId: string,
  dependencies: HarnessDependencies,
  options: OpenRunHarnessOptions = {},
): Promise<ResolvedRunArtifacts> {
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
    });

  if (
    workspace &&
    workspace.kind === "host-worktree" &&
    options.validateWorkspace !== false
  ) {
    await workspaceProvisioner.open(workspace);
  }

  return {
    config,
    paths,
    workspace,
    store,
    workspaceProvisioner,
    dependencies: {
      ...dependencies,
      paths,
      store,
      workspaceProvisioner,
    },
  };
}

/**
 * Host reopen factory: durable cancel/stop/cleanup/status/analysis without a
 * worker workflow runtime.
 */
export async function openHostRunControl(
  projectConfig: HarnessConfig,
  runId: string,
  dependencies: HarnessDependencies,
  options: OpenRunHarnessOptions = {},
): Promise<OpenedHostRunControl> {
  const resolved = await resolveRunArtifacts(projectConfig, runId, dependencies, options);
  const control = new HostRunControl(resolved.config, {
    ...resolved.dependencies,
    workspace: resolved.workspace,
  });
  if (resolved.workspace) control.ctx.bindWorkspace(resolved.workspace);
  return {
    control,
    config: resolved.config,
    paths: resolved.paths,
    workspace: resolved.workspace ?? control.workspace,
  };
}

/**
 * Worker-focused reopen factory used by worker tests and explicit worker tooling.
 * Production host paths must use openHostRunControl or worker-control RPC.
 */
export async function openWorkerRunRuntime(
  projectConfig: HarnessConfig,
  runId: string,
  dependencies: HarnessDependencies,
  options: OpenRunHarnessOptions = {},
): Promise<OpenedRunHarness> {
  const resolved = await resolveRunArtifacts(projectConfig, runId, dependencies, options);
  const engine = new WorkerHarnessRuntime(resolved.config, {
    ...resolved.dependencies,
    workspace: resolved.workspace,
  });
  if (resolved.workspace) engine.bindWorkspace(resolved.workspace);
  return {
    engine,
    config: resolved.config,
    paths: resolved.paths,
    workspace: resolved.workspace ?? engine.workspace,
  };
}

