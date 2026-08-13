import { ProjectSettingsPatchSchema } from "../config/schema.js";
import type { ProjectSettingsPatch } from "../config/schema.js";
import type { RunState } from "../domain.js";
import type { ApplicationContext } from "./application-context.js";
import { indexOfTaskForReportedPaths, unique } from "./helpers.js";
import { updateRunConfig } from "./update-run-config.js";

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
  const reportPaths = unique(
    (options.reportPaths ?? []).map((file) => file.replaceAll("\\", "/")),
  );

  const result = await updateRunConfig(
    ctx,
    state.runId,
    state.configRevision ?? 0,
    parsedPatch,
    {
      reason: "repair",
      detail: {
        persistedProjectDefaults: Boolean(options.persistedProjectDefaults),
        reportPaths,
      },
    },
    {
      allowNoChange: options.allowNoChange,
      alreadyLocked: true,
      transformState:
        reportPaths.length === 0
          ? undefined
          : (next) => {
              const targetIndex = indexOfTaskForReportedPaths(next);
              if (targetIndex < 0) return next;
              return {
                ...next,
                tasks: next.tasks.map((task, index) =>
                  index === targetIndex
                    ? { ...task, changedFiles: unique([...task.changedFiles, ...reportPaths]) }
                    : task,
                ),
              };
            },
    },
  );
  return result.state;
}
