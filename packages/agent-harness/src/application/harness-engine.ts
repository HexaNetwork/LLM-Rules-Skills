import type { PreflightCommitOrder } from "../config/schema.js";
import type { HarnessConfig } from "../config/schema.js";
import type { ReflectOutput, RunState, RunWorkspace, VerificationSettingsPatch, HighLevelPlan } from "../domain.js";
import { ApplicationContext } from "./application-context.js";
import type { HarnessDependencies } from "./dependencies.js";
import { runCancellationRegistry } from "./cancellation-registry.js";
import type { CancelResult, CleanupResult } from "./helpers.js";
import { InterviewService } from "./interview-service.js";
import { PlanningService } from "./planning-service.js";
import { RecoveryService } from "./recovery-service.js";
import { RunAdvancer } from "./run-advancer.js";
import { RunLifecycleService } from "./run-lifecycle-service.js";
import { TaskExecutionService } from "./task-execution-service.js";
import { ScenarioTestingService } from "./scenario-testing-service.js";
import { CrystallizingService } from "./crystallizing-service.js";
import { FinalReviewService } from "./final-review-service.js";

/**
 * Application composition root: wires services and forwards the public run API.
 * Prefer openRunHarness() when reopening an existing run.
 */
export class HarnessEngine {
  private readonly ctx: ApplicationContext;
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
    this.ctx = ctx;
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
    const scenarioTesting = new ScenarioTestingService(ctx);
    const crystallizing = new CrystallizingService(ctx);
    const finalReview = new FinalReviewService(ctx);
    this.advancer = new RunAdvancer(
      ctx,
      this.interview,
      this.planning,
      this.execution,
      this.recovery,
      scenarioTesting,
      crystallizing,
      finalReview,
    );
    ctx.setPhaseStepper((state) => this.advancer.advanceOne(state));
  }

  bindWorkspace(workspace: RunWorkspace): void {
    this.ctx.bindWorkspace(workspace);
  }

  get workspace(): RunWorkspace {
    return this.ctx.workspace;
  }

  get paths() {
    return this.ctx.paths;
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

  advance(runId: string): Promise<RunState> {
    return this.advancer.advance(runId);
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

  confirmPlan(
    runId: string,
    options?: { feedback?: string; plan?: HighLevelPlan },
  ): Promise<RunState> {
    return this.planning.confirmPlan(runId, options);
  }

  confirmVerification(
    runId: string,
    options?: {
      patch?: VerificationSettingsPatch;
      keepCurrent?: boolean;
      persistProjectDefaults?: boolean;
      configPath?: string;
    },
  ): Promise<RunState> {
    return this.planning.confirmVerification(runId, options);
  }

  retryVerificationBaseline(
    runId: string,
    options?: {
      verificationCommand?: string;
      persistProjectDefaults?: boolean;
      configPath?: string;
    },
  ): Promise<RunState> {
    return this.planning.retryVerificationBaseline(runId, options);
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

  cleanup(runId: string, options?: { discard?: boolean }): Promise<CleanupResult> {
    return this.recovery.cleanup(runId, options);
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

  applyApprovedFix(
    runId: string,
    options?: {
      persistedProjectDefaults?: boolean;
      reportPaths?: string[];
    },
  ): Promise<RunState> {
    return this.recovery.applyApprovedFix(runId, options);
  }

  setRag(runId: string, rag: boolean): Promise<RunState> {
    return this.execution.setRag(runId, rag);
  }

  setGraphify(runId: string, enabled: boolean): Promise<RunState> {
    return this.execution.setGraphify(runId, enabled);
  }

  setIgnoredArtifactPatterns(runId: string, patterns: string[]): Promise<RunState> {
    return this.execution.setIgnoredArtifactPatterns(runId, patterns);
  }
}
