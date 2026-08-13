import { HarnessConfigSchema, RunPolicyPatchSchema, configurationHash, configurationPolicyDiff } from "../config/schema.js";
import type { HarnessConfig, RunPolicyPatch } from "../config/schema.js";
import { normalizeFrozenRunConfig } from "../config/migrations.js";
import type { RunState } from "../domain.js";
import type { ApplicationContext } from "./application-context.js";

export type RunConfigUpdateAudit = {
  reason: string;
  detail?: Record<string, unknown>;
};

export type UpdateRunConfigOptions = {
  allowNoChange?: boolean;
  /** Merge additional state fields into the same journaled transition. */
  transformState?: (state: RunState) => RunState;
  /**
   * When true, the caller already holds the per-run lock.
   * Nested withLock is not reentrant, so locked call sites must pass this.
   */
  alreadyLocked?: boolean;
};

export type RunConfigUpdate = {
  state: RunState;
  config: HarnessConfig;
  previousHash: string;
  nextHash: string;
  changedPaths: string[];
  revision: number;
};

/**
 * Single validated mutation path for frozen run policy (`config.json`).
 * Journals config + matching state hash/revision, then updates in-process
 * context only after durable persistence succeeds.
 */
export async function updateRunConfig(
  ctx: ApplicationContext,
  runId: string,
  expectedRevision: number,
  patch: RunPolicyPatch,
  audit: RunConfigUpdateAudit,
  options: UpdateRunConfigOptions = {},
): Promise<RunConfigUpdate> {
  if (options.alreadyLocked) {
    return applyUpdateRunConfig(ctx, runId, expectedRevision, patch, audit, options);
  }
  return ctx.store.withLock(runId, () =>
    applyUpdateRunConfig(ctx, runId, expectedRevision, patch, audit, options),
  );
}

async function applyUpdateRunConfig(
  ctx: ApplicationContext,
  runId: string,
  expectedRevision: number,
  patch: RunPolicyPatch,
  audit: RunConfigUpdateAudit,
  options: UpdateRunConfigOptions,
): Promise<RunConfigUpdate> {
  const parsedPatch = RunPolicyPatchSchema.parse(patch);
  let state = await ctx.store.load(runId);
  const currentRevision = state.configRevision ?? 0;
  if (currentRevision !== expectedRevision) {
    throw new Error(
      `Run ${runId} configRevision mismatch: expected ${expectedRevision}, found ${currentRevision}`,
    );
  }

  const raw = (await ctx.store.readJson(runId, "config.json")) as Record<string, unknown>;
  const frozen = normalizeFrozenRunConfig(raw);
  const frozenVersion =
    typeof raw.configVersion === "number" ? raw.configVersion : state.configVersion;
  const nextConfig = HarnessConfigSchema.parse({
    ...frozen,
    ...(parsedPatch.workflow
      ? { workflow: { ...frozen.workflow, ...parsedPatch.workflow } }
      : {}),
    ...(parsedPatch.commands
      ? { commands: { ...frozen.commands, ...parsedPatch.commands } }
      : {}),
    ...(parsedPatch.git ? { git: { ...frozen.git, ...parsedPatch.git } } : {}),
    ...(parsedPatch.knowledge
      ? {
          knowledge: {
            ...frozen.knowledge,
            ...parsedPatch.knowledge,
            ...(parsedPatch.knowledge.codegraph
              ? {
                  codegraph: {
                    ...frozen.knowledge.codegraph,
                    ...parsedPatch.knowledge.codegraph,
                  },
                }
              : {}),
          },
        }
      : {}),
  });
  const changedPaths = configurationPolicyDiff(frozen, nextConfig);
  if (changedPaths.length === 0) {
    if (options.allowNoChange) {
      return {
        state,
        config: frozen,
        previousHash: state.configurationHash,
        nextHash: state.configurationHash,
        changedPaths: [],
        revision: currentRevision,
      };
    }
    throw new Error("The configuration patch does not change this run's policy");
  }

  const previousHash = state.configurationHash;
  const nextHash = configurationHash(nextConfig);
  const nextRevision = currentRevision + 1;
  const snapshot = {
    ...nextConfig,
    configVersion: frozenVersion,
  };

  let nextState: RunState = {
    ...state,
    configurationHash: nextHash,
    configRevision: nextRevision,
  };
  if (options.transformState) {
    nextState = options.transformState(nextState);
  }

  const persisted = await ctx.store.record(
    nextState,
    "run.config_updated",
    {
      revision: nextRevision,
      previousHash,
      nextHash,
      changedPaths,
      reason: audit.reason,
      ...(audit.detail ?? {}),
    },
    { config: snapshot },
  );

  // In-process context follows durable persistence only.
  ctx.config.workflow = nextConfig.workflow;
  ctx.config.commands = nextConfig.commands;
  ctx.config.git = nextConfig.git;
  ctx.config.knowledge = nextConfig.knowledge;

  return {
    state: persisted,
    config: nextConfig,
    previousHash,
    nextHash,
    changedPaths,
    revision: nextRevision,
  };
}
