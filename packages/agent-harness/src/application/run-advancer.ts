import {
  CONFIG_VERSION,
  configurationHash,
  configurationPolicyDiff,
  loadRunWorkspace,
  normalizeFrozenRunConfig,
} from "../config.js";
import { isTerminalPhase, type RunState } from "../domain.js";
import { classifyFailure, HarnessFailure, RunCancelledError } from "../errors.js";
import { WorktreeManager } from "../git/worktree-manager.js";
import type { ApplicationContext } from "./application-context.js";
import type { InterviewService } from "./interview-service.js";
import type { PlanningService } from "./planning-service.js";
import type { RecoveryService } from "./recovery-service.js";
import type { TaskExecutionService } from "./task-execution-service.js";
import { CANCEL_LOCK_WAIT_MS, PROVIDER_RETRY_BACKOFF_MS } from "./helpers.js";
import { accrueRunUsage } from "./usage-ledger.js";

const terminal = isTerminalPhase;

/** Fixed ceiling so a stuck phase cannot spin forever; throws internal, does not yield. */
const ADVANCE_SAFETY_ITERATION_CAP = 10_000;

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
    phaseStepper?: (state: RunState) => Promise<RunState>,
  ): Promise<RunState> {
    if (phaseStepper) this.ctx.setPhaseStepper(phaseStepper);
    this.ctx.cancellation.register(runId);
    let state: RunState;
    try {
      // Legacy-shared: repository → run. Worktree/git-disabled: run lock only.
      state = await this.ctx.withMutatingRunLock(runId, "advance", async () => {
        const loaded = await this.ctx.store.load(runId);
        return this.runAdvanceLoop(runId, loaded);
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

  async runAdvanceLoop(runId: string, state: RunState): Promise<RunState> {
    try {
      state = await this.ensureCompatibleConfiguration(state);
      await this.ensureWorkspaceBound(runId);
      if (!(terminal(state.phase) || state.phase === "awaiting_input")) {
        if (await this.ctx.isCancelRequested(runId)) {
          state = await this.recovery.completeCancellation(state);
        } else {
          // Clear legacy yieldedAt (old state.json) and operator stop markers on resume.
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
          let iterations = 0;
          while (iterations < ADVANCE_SAFETY_ITERATION_CAP) {
            iterations += 1;
            if (await this.ctx.isCancelRequested(runId)) {
              state = await this.recovery.completeCancellation(state);
              break;
            }
            // Enforce spend ceilings between steps only — never abort mid-step.
            state = await this.accrueUsage(state);
            this.assertWithinBudget(state);
            state = await this.advanceOneWithProviderRetry(state);
            await this.ctx.syncArtifacts(state);
            state = await this.accrueUsage(state);
            if (await this.ctx.isCancelRequested(runId)) {
              state = await this.recovery.completeCancellation(state);
              break;
            }
            if (
              terminal(state.phase) ||
              state.phase === "awaiting_input" ||
              state.stoppedAfterTaskAt
            ) {
              break;
            }
          }
          if (
            iterations >= ADVANCE_SAFETY_ITERATION_CAP &&
            !terminal(state.phase) &&
            state.phase !== "awaiting_input" &&
            !state.stoppedAfterTaskAt &&
            !(await this.ctx.isCancelRequested(runId))
          ) {
            throw new HarnessFailure(
              `Advance exceeded safety iteration cap (${ADVANCE_SAFETY_ITERATION_CAP})`,
              "internal",
              false,
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
    // post-step check (awaiting_input / terminal / stop) so cancel.request cannot
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
    return accrueRunUsage(this.ctx, state);
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

  /**
   * Rebind execution roots from durable workspace.json and validate worktree identity.
   * Missing/moved worktrees fail with a retriable workspace error (recorded as blocked).
   */
  async ensureWorkspaceBound(runId: string): Promise<void> {
    const workspace = await loadRunWorkspace(this.ctx.config, runId);
    this.ctx.bindWorkspace(workspace);
    if (workspace.kind !== "git-worktree") return;
    const manager = new WorktreeManager({
      controlRoot: this.ctx.paths.controlRoot,
      stateRoot: this.ctx.paths.stateRoot,
      worktreeRoot: this.ctx.paths.worktreeRoot,
      store: this.ctx.store,
    });
    await manager.open(workspace);
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
    const currentHash = configurationHash(this.ctx.config);
    if (currentHash !== state.configurationHash) {
      let detail = "";
      try {
        const raw = await this.ctx.store.readJson(state.runId, "config.json");
        const frozen = normalizeFrozenRunConfig(raw);
        const diffs = configurationPolicyDiff(this.ctx.config, frozen);
        if (diffs.length === 0) {
          // The policy that governs this run is still identical to its durable
          // snapshot. A stale state stamp must not strand the run.
          return this.ctx.store.record(
            { ...state, configurationHash: currentHash },
            "run.config_restamped",
            { previousHash: state.configurationHash },
          );
        }
        detail = ` Differing hashed policy vs frozen snapshot: ${diffs.slice(0, 8).join(", ")}.`;
      } catch {
        // Frozen snapshot may be unreadable; the base message is still actionable.
      }
      throw new HarnessFailure(
        `Run configuration changed; resume with the persisted run config.${detail}`,
        "config",
        false,
      );
    }
    return state;
  }

  /** Single-question path; delegates to the batch-aware answerMany. */

  async advanceOneWithProviderRetry(state: RunState): Promise<RunState> {
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
  async advanceOne(state: RunState): Promise<RunState> {
    switch (state.phase) {
      case "new":
      case "reflecting":
        return this.interview.reflect(state);
      case "grilling":
        return this.interview.grill(state);
      case "planning":
        return this.planning.plan(state);
      case "executing":
        return this.execution.execute(state);
      case "publishing":
        return this.execution.publish(state);
      case "awaiting_input":
      case "completed":
      case "blocked":
      case "cancelled":
        return state;
    }
  }
}
