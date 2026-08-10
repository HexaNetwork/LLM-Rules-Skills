import { loadRunConfig, loadRunWorkspace } from "../config.js";
import type { HarnessConfig } from "../config.js";
import type { RunWorkspace } from "../domain/workspace.js";
import { HarnessEngine } from "../engine.js";
import { WorktreeManager } from "../git/worktree-manager.js";
import { RunStore } from "../store.js";
import type { HarnessDependencies } from "./dependencies.js";
import { resolveHarnessPaths, type HarnessPaths } from "./paths.js";

export type OpenedRunHarness = {
  engine: HarnessEngine;
  config: HarnessConfig;
  paths: HarnessPaths;
  workspace: RunWorkspace;
};

export type OpenRunHarnessOptions = {
  /** When false, skip worktree registration checks (status/cancel/unlock). Default true. */
  validateWorktree?: boolean;
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
  const config = await loadRunConfig(projectConfig, runId);
  const workspace = await loadRunWorkspace(projectConfig, runId);
  const paths = resolveHarnessPaths(config, workspace);

  if (workspace.kind === "git-worktree" && options.validateWorktree !== false) {
    const store = dependencies.store ?? new RunStore(config, paths.stateRoot);
    const manager = new WorktreeManager({
      controlRoot: paths.controlRoot,
      stateRoot: paths.stateRoot,
      store,
    });
    await manager.open(workspace);
  }

  const engine = new HarnessEngine(config, {
    ...dependencies,
    paths,
  });
  engine.bindWorkspace(workspace);
  return { engine, config, paths, workspace };
}
