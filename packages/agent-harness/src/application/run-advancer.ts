import { CONFIG_VERSION, configurationHash, configurationPolicyDiff } from "../config/schema.js";
import { normalizeFrozenRunConfig } from "../config/migrations.js";
import { isTerminalPhase, type RunState } from "../domain.js";
import { classifyFailure, HarnessFailure, RunCancelledError } from "../errors.js";
import type { ApplicationContext } from "./application-context.js";
import type { InterviewService } from "./interview-service.js";
import type { PlanningService } from "./planning-service.js";
import type { RecoveryService } from "./recovery-service.js";
import type { TaskExecutionService } from "./task-execution-service.js";
import type { ScenarioTestingService } from "./scenario-testing-service.js";
import type { CrystallizingService } from "./crystallizing-service.js";
import type { FinalReviewService } from "./final-review-service.js";
import { CANCEL_LOCK_WAIT_MS, PROVIDER_RETRY_BACKOFF_MS } from "./helpers.js";
import { accrueRunUsage } from "./usage-ledger.js";

const terminal = isTerminalPhase;

/** Last-resort ceiling in addition to the repeated-transition circuit breaker. */
const ADVANCE_SAFETY_ITERATION_CAP = 1_000;
const REPEATED_TRANSITION_LIMIT = 2;

export class RepeatedTransitionCircuitBreaker {
  private readonly counts = new Map<string, number>();

  constructor(private readonly limit = REPEATED_TRANSITION_LIMIT) {}

  observe(from: string, to: string, phase: RunState["phase"]): void {
    const transition = `${from} -> ${to}`;
    const repeated = (this.counts.get(transition) ?? 0) + 1;
    this.counts.set(transition, repeated);
    if (repeated >= this.limit) {
      throw new HarnessFailure(
        `Repeated workflow transition detected ${repeated} times: ${phase}`,
        "internal",
        false,
      );
    }
  }
}

function workflowSignature(state: RunState): string {
  const activeTask = state.tasks.find((task) => task.status === "active");
  return JSON.stringify({
    phase: state.phase,
    configRevision: state.configRevision,
    activeQuestionId: state.activeQuestionId,
    questionStates: state.questions.map(({ id, status }) => [id, status]),
    grillResolutions: state.grillResolutions.length,
    grillReady: Boolean(state.grillReady),
    planReady: Boolean(state.planReady),
    verificationReady: Boolean(state.verificationReady),
    verificationBaselineReady: Boolean(state.verificationBaselineReady),
    verificationConfirmed: Boolean(state.verificationConfirmedAt),
    verificationBaselinePassed: Boolean(state.verificationBaselinePassedAt),
    plan: Boolean(state.plan),
    prd: Boolean(state.prd),
    scenarios: state.scenarios.map(({ id, status, attempts, writerAttempts, repairAttempts }) => [
      id,
      status,
      attempts,
      writerAttempts,
      repairAttempts,
    ]),
    coverage: state.coverage
      ? {
          percentage: state.coverage.percentage,
          attempts: state.coverage.attempts,
          scope: state.coverage.scope,
        }
      : undefined,
    finalReviewAttempts: state.finalReviewAttempts,
    activeTask: activeTask
      ? {
          id: activeTask.id,
          status: activeTask.status,
          step: activeTask.step,
          attempts: activeTask.attempts,
          reviewSummary: activeTask.reviewSummary,
        }
      : undefined,
    taskStates: state.tasks.map(({ id, status, step }) => [id, status, step]),
  });
}

export class RunAdvancer {
  constructor(
    private readonly ctx: ApplicationContext,
    private readonly interview: InterviewService,
    private readonly planning: PlanningService,
    private readonly execution: TaskExecutionService,
    private readonly recovery: RecoveryService,
    private readonly scenarioTesting: ScenarioTestingService,
    private readonly crystallizing: CrystallizingService,
    private readonly finalReview: FinalReviewService,
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
          // Clear operator stop-after-task markers on resume.
          if (state.stoppedAfterTaskAt) {
            state = await this.ctx.store.record(
              {
                ...state,
                stoppedAfterTaskAt: undefined,
              },
              "run.resumed",
            );
            await this.ctx.clearStopRequest(runId);
          }
          await this.ctx.assertTreeFingerprint(state);
          let iterations = 0;
          const transitionCircuitBreaker = new RepeatedTransitionCircuitBreaker();
          while (iterations < ADVANCE_SAFETY_ITERATION_CAP) {
            iterations += 1;
            if (await this.ctx.isCancelRequested(runId)) {
              state = await this.recovery.completeCancellation(state);
              break;
            }
            // Enforce spend ceilings between steps only — never abort mid-step.
            state = await this.accrueUsage(state);
            this.assertWithinBudget(state);
            const transitionFrom = workflowSignature(state);
            state = await this.advanceOneWithProviderRetry(state);
            const transitionTo = workflowSignature(state);
            transitionCircuitBreaker.observe(transitionFrom, transitionTo, state.phase);
            await this.ctx.syncArtifacts(state);
            state = await this.accrueUsage(state);
            if (await this.ctx.isCancelRequested(runId)) {
              state = await this.recovery.completeCancellation(state);
              break;
            }
            // Docker: after prepare-export, yield to the host for quarantine import + push/PR.
            if (
              state.phase === "publishing" &&
              (this.ctx.config.execution?.runtime ?? "local") === "docker"
            ) {
              const { isDockerBundleExportReady } = await import("./docker-publish-service.js");
              const { loadBundleImportState } = await import("./bundle-import-io.js");
              const importState = await loadBundleImportState(this.ctx.config, runId).catch(
                () => undefined,
              );
              // Worker store may hold import.json even when host path helpers fail.
              let exportReady = isDockerBundleExportReady(importState);
              if (!exportReady) {
                try {
                  const raw = await this.ctx.store.readJson(runId, "transport/import.json");
                  const { BundleImportStateSchema } = await import("../domain/run-execution.js");
                  exportReady = isDockerBundleExportReady(
                    BundleImportStateSchema.parse(raw),
                  );
                } catch {
                  exportReady = false;
                }
              }
              if (exportReady) break;
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
    const workspace = await this.ctx.loadWorkspace(runId);
    this.ctx.bindWorkspace(workspace);
    if (workspace.kind !== "git-worktree") return;
    await this.ctx.workspaceProvisioner.open(workspace);
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
      case "scenario_testing":
        return this.scenarioTesting.advance(state);
      case "crystallizing":
        return this.crystallizing.advance(state);
      case "final_review":
        return this.finalReview.advance(state);
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
