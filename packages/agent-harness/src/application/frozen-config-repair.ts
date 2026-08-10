import {
  HarnessConfigSchema,
  configurationHash,
  configurationPolicyDiff,
  normalizeFrozenRunConfig,
  ProjectSettingsPatchSchema,
  type ProjectSettingsPatch,
} from "../config.js";
import type { RunState } from "../domain.js";
import type { ApplicationContext } from "./application-context.js";
import { indexOfTaskForReportedPaths, unique } from "./helpers.js";

export type ApplyFrozenConfigRepairOptions = {
  persistedProjectDefaults?: boolean;
  reportPaths?: string[];
  /** When true, a no-op patch is allowed (returns state unchanged aside from audit skip). */
  allowNoChange?: boolean;
};

/**
 * Apply a validated settings patch to the run's frozen config.json and keep the
 * in-process engine config aligned. Caller must hold the run lock.
 */
export async function applyFrozenConfigRepair(
  ctx: ApplicationContext,
  state: RunState,
  patch: ProjectSettingsPatch,
  options: ApplyFrozenConfigRepairOptions = {},
): Promise<RunState> {
  const parsedPatch = ProjectSettingsPatchSchema.parse(patch);
  const raw = (await ctx.store.readJson(state.runId, "config.json")) as Record<string, unknown>;
  const frozen = normalizeFrozenRunConfig(raw);
  const repaired = HarnessConfigSchema.parse({
    ...frozen,
    ...(parsedPatch.workflow
      ? { workflow: { ...frozen.workflow, ...parsedPatch.workflow } }
      : {}),
    ...(parsedPatch.commands
      ? { commands: { ...frozen.commands, ...parsedPatch.commands } }
      : {}),
    ...(parsedPatch.git ? { git: { ...frozen.git, ...parsedPatch.git } } : {}),
  });
  const changedPaths = configurationPolicyDiff(frozen, repaired);
  if (changedPaths.length === 0) {
    if (options.allowNoChange) return state;
    throw new Error("The recommended configuration repair does not change this run's policy");
  }
  // Keep the in-process engine config aligned with the repaired snapshot so a
  // same-engine advance (or test-writer legality check) sees the new policy.
  ctx.config.workflow = repaired.workflow;
  ctx.config.commands = repaired.commands;
  ctx.config.git = repaired.git;
  const previousHash = state.configurationHash;
  await ctx.store.writeJson(state.runId, "config.json", {
    ...repaired,
    configVersion: state.configVersion,
  });
  let nextState = state;
  const reportPaths = unique(
    (options.reportPaths ?? []).map((file) => file.replaceAll("\\", "/")),
  );
  if (reportPaths.length > 0) {
    const targetIndex = indexOfTaskForReportedPaths(nextState);
    if (targetIndex >= 0) {
      nextState = {
        ...nextState,
        tasks: nextState.tasks.map((task, index) =>
          index === targetIndex
            ? { ...task, changedFiles: unique([...task.changedFiles, ...reportPaths]) }
            : task,
        ),
      };
    }
  }
  const nextHash = configurationHash(repaired);
  return ctx.store.record(
    { ...nextState, configurationHash: nextHash },
    "run.config_repaired",
    {
      previousHash,
      nextHash,
      changedPaths,
      persistedProjectDefaults: Boolean(options.persistedProjectDefaults),
      reportPaths,
    },
  );
}
