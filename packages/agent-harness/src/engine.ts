import type { HarnessConfig, PreflightCommitOrder } from "./config.js";
import type { ReflectOutput, RunState } from "./domain.js";
import { isTestPath, reconcileUnknowns } from "./domain.js";
import { ApplicationContext } from "./application/application-context.js";
import type { HarnessDependencies } from "./application/dependencies.js";
import { runCancellationRegistry } from "./application/cancellation-registry.js";
import {
  pendingGrillReady,
  taskForPacket,
  type CancelResult,
} from "./application/helpers.js";
import { InterviewService } from "./application/interview-service.js";
import { PlanningService } from "./application/planning-service.js";
import { RecoveryService } from "./application/recovery-service.js";
import { RunAdvancer } from "./application/run-advancer.js";
import { RunLifecycleService } from "./application/run-lifecycle-service.js";
import { TaskExecutionService } from "./application/task-execution-service.js";

export type { HarnessDependencies } from "./application/dependencies.js";
export type { CancelResult } from "./application/helpers.js";
export { pendingGrillReady, taskForPacket } from "./application/helpers.js";
export { isTestPath, reconcileUnknowns };

/**
 * Compatibility facade: dependency composition and public method forwarding only.
 */
export class HarnessEngine {
  readonly store;
  readonly knowledge;
  readonly tracker;
  readonly git;
  readonly agents;

  private readonly lifecycle: RunLifecycleService;
  private readonly interview: InterviewService;
  private readonly planning: PlanningService;
  private readonly execution: TaskExecutionService;
  private readonly recovery: RecoveryService;
  private readonly advancer: RunAdvancer;

  constructor(
    readonly config: HarnessConfig,
    dependencies: HarnessDependencies,
  ) {
    const ctx = new ApplicationContext(config, dependencies, runCancellationRegistry);
    this.store = ctx.store;
    this.knowledge = ctx.knowledge;
    this.tracker = ctx.tracker;
    this.git = ctx.git;
    this.agents = ctx.agents;

    this.interview = new InterviewService(ctx);
    this.planning = new PlanningService(ctx);
    this.execution = new TaskExecutionService(ctx);
    this.recovery = new RecoveryService(ctx, this.interview);
    this.lifecycle = new RunLifecycleService(ctx, this.recovery);
    this.advancer = new RunAdvancer(
      ctx,
      this.interview,
      this.planning,
      this.execution,
      this.recovery,
    );
    ctx.setPhaseStepper((state) => this.advancer.advanceOne(state));
  }

  start(
    idea: string,
    runId?: string,
    refreshKnowledge?: boolean,
    prepareGraphify?: boolean,
  ): Promise<RunState> {
    return this.lifecycle.start(idea, runId, refreshKnowledge, prepareGraphify);
  }

  status(runId: string): Promise<RunState> {
    return this.lifecycle.status(runId);
  }

  advance(runId: string, maxSteps?: number): Promise<RunState> {
    return this.advancer.advance(runId, maxSteps);
  }

  answer(
    runId: string,
    questionId: string,
    answer: string,
    structured?: ReflectOutput,
  ): Promise<RunState> {
    return this.interview.answer(runId, questionId, answer, structured);
  }

  answerMany(
    runId: string,
    answers?: Array<{
      questionId: string;
      answer: string;
      optionId?: string;
      structured?: ReflectOutput;
    }>,
    parkedQuestionIds?: string[],
    clarifications?: Array<{ questionId: string; text: string }>,
  ): Promise<RunState> {
    return this.interview.answerMany(runId, answers, parkedQuestionIds, clarifications);
  }

  addNote(runId: string, text: string, asUnknown?: boolean): Promise<RunState> {
    return this.interview.addNote(runId, text, asUnknown);
  }

  confirmGrill(runId: string, options?: { feedback?: string }): Promise<RunState> {
    return this.interview.confirmGrill(runId, options);
  }

  retry(
    runId: string,
    options?: { force?: boolean; maxRunTokens?: number; maxRunCostUsd?: number },
  ): Promise<RunState> {
    return this.recovery.retry(runId, options);
  }

  acceptTree(runId: string, options?: { reportPaths?: string[] }): Promise<RunState> {
    return this.recovery.acceptTree(runId, options);
  }

  commitPreflight(
    runId: string,
    options?: { order?: PreflightCommitOrder; message?: string },
  ): Promise<RunState> {
    return this.recovery.commitPreflight(runId, options);
  }

  cancel(runId: string): Promise<CancelResult> {
    return this.recovery.cancel(runId);
  }

  requestStop(runId: string): Promise<RunState> {
    return this.recovery.requestStop(runId);
  }

  resolveInstalls(
    runId: string,
    decisions: { accepted?: string[]; denied?: string[] },
  ): Promise<RunState> {
    return this.recovery.resolveInstalls(runId, decisions);
  }

  proposeFix(runId: string, guidance: string): Promise<RunState> {
    return this.recovery.proposeFix(runId, guidance);
  }

  applyApprovedFix(runId: string): Promise<RunState> {
    return this.recovery.applyApprovedFix(runId);
  }

  setTdd(runId: string, tdd: boolean, taskId?: string): Promise<RunState> {
    return this.execution.setTdd(runId, tdd, taskId);
  }
}
