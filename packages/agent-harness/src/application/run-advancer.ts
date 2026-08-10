import {
  CONFIG_VERSION,
  configurationHash,
  configurationPolicyDiff,
  normalizeFrozenRunConfig,
} from "../config.js";
import { isTerminalPhase, type RunState } from "../domain.js";
import { classifyFailure, HarnessFailure, RunCancelledError } from "../errors.js";
import { reportedTotal } from "../agent.js";
import type { ApplicationContext } from "./application-context.js";
import type { InterviewService } from "./interview-service.js";
import type { PlanningService } from "./planning-service.js";
import type { RecoveryService } from "./recovery-service.js";
import type { TaskExecutionService } from "./task-execution-service.js";
import {
  CANCEL_LOCK_WAIT_MS,
  PROVIDER_RETRY_BACKOFF_MS,
  type StepResult,
} from "./helpers.js";

const terminal = isTerminalPhase;

export class RunAdvancer {
  constructor(
    private readonly ctx: ApplicationContext,
    private readonly interview: InterviewService,
    private readonly planning: PlanningService,
    private readonly execution: TaskExecutionService,
    private readonly recovery: RecoveryService,
  ) {}

  async advance(
    runId: string,
    maxSteps?: number,
    phaseStepper?: (state: RunState) => Promise<StepResult>,
  ): Promise<RunState> {
    const stepBudget = maxSteps ?? this.ctx.config.workflow.maxStepsPerRun;
    if (phaseStepper) this.ctx.setPhaseStepper(phaseStepper);
    this.ctx.cancellation.register(runId);
    let state: RunState;
    try {
      // Lock ordering: repository → run, always (avoid deadlock with paths that take both).
      state = await this.ctx.store.withRepositoryLock({ runId, action: "advance" }, async () => {
        return this.ctx.store.withLock(runId, async () => {
          const loaded = await this.ctx.store.load(runId);
          return this.runAdvanceLoop(runId, loaded, stepBudget);
        });
      });
    } finally {
      this.ctx.cancellation.release(runId);
    }
    // Cancel may race in after the in-lock drain but before activeRuns was cleared
    // (cancel short-circuits to pending while a controller exists). Finish it now.
    if (await this.ctx.cancelRequestPresent(runId)) {
      const locked = await this.ctx.store.tryWithLock(runId, CANCEL_LOCK_WAIT_MS, async () => {
        const current = await this.ctx.store.load(runId);
        return this.recovery.completeCancellation(current);
      });
      if (locked.acquired) {
        state = locked.value;
      }
    }
    return state;
  }

  /**
   * In-lock advance body: step loop, usage accrual ordering, failure → blocked,
   * and cancel drain before the run lock is released.
   */

  async runAdvanceLoop(
    runId: string,
    state: RunState,
    maxSteps: number,
  ): Promise<RunState> {
    try {
      state = await this.ensureCompatibleConfiguration(state);
      if (!(terminal(state.phase) || state.phase === "awaiting_input")) {
        if (await this.ctx.isCancelRequested(runId)) {
          state = await this.recovery.completeCancellation(state);
        } else {
          if (state.yieldedAt || state.stoppedAfterTaskAt) {
            state = await this.ctx.store.record(
              {
                ...state,
                yieldedAt: undefined,
                stoppedAfterTaskAt: undefined,
              },
              "run.resumed",
            );
            await this.ctx.clearStopRequest(runId);
          }
          await this.ctx.assertTreeFingerprint(state);
          let remaining = maxSteps;
          let iterations = 0;
          const maxIterations = Math.max(maxSteps * 8, 40);
          while (remaining > 0 && iterations < maxIterations) {
            iterations += 1;
            if (await this.ctx.isCancelRequested(runId)) {
              state = await this.recovery.completeCancellation(state);
              break;
            }
            // Enforce spend ceilings between steps only — never abort mid-step.
            state = await this.accrueUsage(state);
            this.assertWithinBudget(state);
            const step = await this.advanceOneWithProviderRetry(state);
            state = step.state;
            await this.ctx.syncArtifacts(state);
            if (step.consumedBudget) {
              remaining -= 1;
              state = await this.accrueUsage(state);
            }
            if (await this.ctx.isCancelRequested(runId)) {
              state = await this.recovery.completeCancellation(state);
              break;
            }
            if (
              terminal(state.phase) ||
              state.phase === "awaiting_input" ||
              state.stoppedAfterTaskAt
            ) {
              state = await this.accrueUsage(state);
              break;
            }
          }
          // Step budget exhausted — yield only when cancel has not already won.
          if (
            !terminal(state.phase) &&
            state.phase !== "awaiting_input" &&
            !state.stoppedAfterTaskAt &&
            !(await this.ctx.isCancelRequested(runId))
          ) {
            state = await this.accrueUsage(state);
            state = await this.ctx.store.record(
              { ...state, yieldedAt: new Date().toISOString() },
              "run.yielded",
              { maxSteps },
            );
          }
        }
      }
    } catch (error) {
      state = await this.ctx.store.load(runId).catch(() => state);
      if (error instanceof RunCancelledError || (await this.ctx.isCancelRequested(runId))) {
        state = await this.recovery.completeCancellation(state);
        await this.ctx.syncArtifacts(state);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        const classified = classifyFailure(error);
        // Keep the latest accrued usage on the blocked snapshot when available.
        state = await this.accrueUsage(state).catch(() => state);
        const blockedFrom =
          state.phase === "blocked" ? (state.blockedFrom ?? state.phase) : state.phase;
        state = await this.ctx.store.record(
          {
            ...state,
            phase: "blocked",
            blockedFrom,
            failure: message,
            blockedKind: classified.kind,
            blockedRetriable: classified.retriable,
          },
          "run.blocked",
          {
            blockedFrom,
            error: message,
            blockedKind: classified.kind,
            blockedRetriable: classified.retriable,
          },
        );
        await this.ctx.syncArtifacts(state);
      }
    }
    // Drain cancel before releasing the run lock. Covers cancel after the last
    // post-step check (yield / awaiting_input / terminal) so cancel.request cannot
    // outlive the advancing process while the UI stays on "Cancelling…".
    if (await this.ctx.isCancelRequested(runId)) {
      state = await this.recovery.completeCancellation(state);
    }
    return state;
  }

  /**
   * Recompute run usage from sessions/*.json and replace state.usage.
   * Idempotent: reading the same files twice yields the same totals.
   */

  async accrueUsage(state: RunState): Promise<RunState> {
    const files = (await this.ctx.store.listFiles(state.runId, "sessions")).filter((file) =>
      file.endsWith(".json"),
    );
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let totalTokens = 0;
    let costUsd = 0;
    let costIsLowerBound = false;
    let sessionsRead = 0;
    let invocations = 0;

    for (const file of files) {
      let session: {
        model?: string;
        usage?: {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
          totalTokens?: number;
        };
      };
      try {
        session = (await this.ctx.store.readJson(state.runId, file)) as typeof session;
      } catch {
        // Concurrently-written or partial files must not fail accrual.
        continue;
      }
      sessionsRead += 1;
      invocations += 1;
      const usage = session.usage ?? {};
      const input = Number(usage.inputTokens ?? 0);
      const output = Number(usage.outputTokens ?? 0);
      const cacheRead = Number(usage.cacheReadTokens ?? 0);
      const cacheWrite = Number(usage.cacheWriteTokens ?? 0);
      const total = reportedTotal(usage) ?? 0;
      inputTokens += input;
      outputTokens += output;
      cacheReadTokens += cacheRead;
      cacheWriteTokens += cacheWrite;
      totalTokens += total;

      const model = typeof session.model === "string" ? session.model : "";
      const pricing = model ? this.ctx.config.models.pricing[model] : undefined;
      if (!pricing) {
        if (input > 0 || output > 0 || total > 0) costIsLowerBound = true;
        continue;
      }
      costUsd +=
        (input / 1_000_000) * pricing.inputPerMillion +
        (output / 1_000_000) * pricing.outputPerMillion +
        (cacheRead / 1_000_000) * pricing.cacheReadPerMillion +
        (cacheWrite / 1_000_000) * pricing.cacheWritePerMillion;
    }

    const nextUsage = {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens,
      costUsd,
      costIsLowerBound,
      invocations,
      sessionsRead,
    };
    if (
      state.usage.inputTokens === nextUsage.inputTokens &&
      state.usage.outputTokens === nextUsage.outputTokens &&
      state.usage.cacheReadTokens === nextUsage.cacheReadTokens &&
      state.usage.cacheWriteTokens === nextUsage.cacheWriteTokens &&
      state.usage.totalTokens === nextUsage.totalTokens &&
      state.usage.costUsd === nextUsage.costUsd &&
      state.usage.costIsLowerBound === nextUsage.costIsLowerBound &&
      state.usage.invocations === nextUsage.invocations &&
      state.usage.sessionsRead === nextUsage.sessionsRead
    ) {
      return state;
    }
    return this.ctx.store.writeState({ ...state, usage: nextUsage });
  }

  /** Throw a non-retriable budget failure when a configured ceiling is exceeded. */

  assertWithinBudget(state: RunState): void {
    const { maxRunTokens, maxRunCostUsd } = this.ctx.config.workflow;
    if (maxRunTokens > 0 && state.usage.totalTokens > maxRunTokens) {
      throw new HarnessFailure(
        `Run exceeded maxRunTokens: observed ${state.usage.totalTokens} > limit ${maxRunTokens}`,
        "budget",
        false,
      );
    }
    if (maxRunCostUsd > 0 && state.usage.costUsd > maxRunCostUsd) {
      throw new HarnessFailure(
        `Run exceeded maxRunCostUsd: observed ${state.usage.costUsd} > limit ${maxRunCostUsd}`,
        "budget",
        false,
      );
    }
  }

  async ensureCompatibleConfiguration(state: RunState): Promise<RunState> {
    if (state.configVersion < CONFIG_VERSION) {
      // Re-stamp the hash before any comparison so additive config defaults
      // from a CONFIG_VERSION bump do not permanently block existing runs.
      return this.ctx.store.record(
        {
          ...state,
          configVersion: CONFIG_VERSION,
          configurationHash: configurationHash(this.ctx.config),
        },
        "run.config_migrated",
        { from: state.configVersion, to: CONFIG_VERSION },
      );
    }
    if (state.configVersion > CONFIG_VERSION) {
      throw new HarnessFailure(
        `Run configVersion ${state.configVersion} is newer than harness ${CONFIG_VERSION}`,
        "config",
        false,
      );
    }
    if (configurationHash(this.ctx.config) !== state.configurationHash) {
      let detail = "";
      try {
        const raw = await this.ctx.store.readJson(state.runId, "config.json");
        const frozen = normalizeFrozenRunConfig(raw);
        const diffs = configurationPolicyDiff(this.ctx.config, frozen);
        detail = diffs.length
          ? ` Differing hashed policy vs frozen snapshot: ${diffs.slice(0, 8).join(", ")}.`
          : " Engine hashed policy matches the frozen snapshot; the run state's configurationHash stamp is stale.";
      } catch {
        // Frozen snapshot may be unreadable; the base message is still actionable.
      }
      throw new HarnessFailure(
        `Run configuration changed; resume with the persisted run config.${detail} Test path patterns and ignored artifact patterns are live and do not cause this block.`,
        "config",
        false,
      );
    }
    return state;
  }

  /** Single-question path; delegates to the batch-aware answerMany. */

  async advanceOneWithProviderRetry(state: RunState): Promise<StepResult> {
    const maxRetries = this.ctx.config.workflow.maxProviderRetries;
    let attempt = 0;
    for (;;) {
      try {
        return await (this.ctx.phaseStepper ?? ((next) => this.advanceOne(next)))(state);
      } catch (error) {
        if (error instanceof RunCancelledError || (await this.ctx.isCancelRequested(state.runId))) {
          throw error instanceof RunCancelledError
            ? error
            : new RunCancelledError("Run cancelled");
        }
        const classified = classifyFailure(error);
        if (classified.kind !== "provider" || !classified.retriable || attempt >= maxRetries) {
          throw error;
        }
        attempt += 1;
        const message = error instanceof Error ? error.message : String(error);
        // Reload before recording — advanceOne may have persisted mid-step progress.
        state = await this.ctx.store.load(state.runId);
        state = await this.ctx.store.record(state, "run.provider_retry", {
          attempt,
          error: message,
        });
        const delay =
          PROVIDER_RETRY_BACKOFF_MS[attempt - 1] ??
          PROVIDER_RETRY_BACKOFF_MS[PROVIDER_RETRY_BACKOFF_MS.length - 1]!;
        await this.sleepProviderBackoff(delay, state.runId);
      }
    }
  }

  /**
   * Chunk backoff so `<runDir>/cancel.request` and the in-process AbortSignal
   * can short-circuit without waiting the full delay.
   */

  async sleepProviderBackoff(ms: number, runId: string): Promise<void> {
    const chunkMs = 100;
    let remaining = ms;
    while (remaining > 0) {
      await this.throwIfCancelRequested(runId);
      const slice = Math.min(chunkMs, remaining);
      await this.ctx.sleep(slice);
      remaining -= slice;
    }
    await this.throwIfCancelRequested(runId);
  }

  async throwIfCancelRequested(runId: string): Promise<void> {
    if (await this.ctx.isCancelRequested(runId)) {
      throw new RunCancelledError("Run cancellation requested during provider retry backoff");
    }
  }

  /**
   * Phase dispatch only — no phase-specific implementation beyond routing.
   * RunAdvancer is the public advance entry; this remains the in-process stepper.
   */

  /** Phase dispatch only — no phase-specific implementation. */
  async advanceOne(state: RunState): Promise<StepResult> {
    switch (state.phase) {
      case "new":
      case "reflecting":
        return { state: await this.interview.reflect(state), consumedBudget: true };
      case "grilling":
        return { state: await this.interview.grill(state), consumedBudget: true };
      case "planning":
        return { state: await this.planning.plan(state), consumedBudget: true };
      case "executing":
        return this.execution.execute(state);
      case "publishing":
        return { state: await this.execution.publish(state), consumedBudget: true };
      case "awaiting_input":
      case "completed":
      case "blocked":
      case "cancelled":
        return { state, consumedBudget: false };
    }
  }
}
