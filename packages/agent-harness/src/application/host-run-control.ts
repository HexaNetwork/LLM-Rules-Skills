import type { HarnessConfig } from "../config/schema.js";
import type { RunState } from "../domain.js";
import { ApplicationContext } from "./application-context.js";
import { runCancellationRegistry } from "./cancellation-registry.js";
import type { HarnessDependencies } from "./dependencies.js";
import type { CancelResult, CleanupResult } from "./helpers.js";
import { InterviewService } from "./interview-service.js";
import { RecoveryService } from "./recovery-service.js";
import { RunAnalysisService } from "./run-analysis-service.js";
import { TaskExecutionService } from "./task-execution-service.js";

/**
 * Host-owned reopen surface for durable cancel/stop, cleanup, status, and
 * post-run analysis. Does not construct WorkerHarnessRuntime or RunAdvancer.
 */
export class HostRunControl {
  readonly ctx: ApplicationContext;
  readonly config: HarnessConfig;
  private readonly recovery: RecoveryService;
  private readonly analysis: RunAnalysisService;
  private readonly execution: TaskExecutionService;

  constructor(config: HarnessConfig, dependencies: HarnessDependencies) {
    this.config = config;
    this.ctx = new ApplicationContext(config, dependencies, runCancellationRegistry);
    const interview = new InterviewService(this.ctx);
    this.recovery = new RecoveryService(this.ctx, interview);
    this.analysis = new RunAnalysisService(this.ctx);
    this.execution = new TaskExecutionService(this.ctx);
  }

  get store() {
    return this.ctx.store;
  }

  get paths() {
    return this.ctx.paths;
  }

  get workspace() {
    return this.ctx.workspace;
  }

  status(runId: string): Promise<RunState> {
    return this.ctx.store.load(runId);
  }

  writeCancelRequest(runId: string): Promise<void> {
    return this.ctx.writeCancelRequest(runId);
  }

  cancel(runId: string): Promise<CancelResult> {
    return this.recovery.cancel(runId);
  }

  requestStop(runId: string): Promise<RunState> {
    return this.recovery.requestStop(runId);
  }

  cleanup(runId: string, options?: { discard?: boolean }): Promise<CleanupResult> {
    return this.recovery.cleanup(runId, options);
  }

  generateRunAnalysisPrompt(runId: string) {
    return this.analysis.generatePrompt(runId);
  }

  setIgnoredArtifactPatterns(runId: string, patterns: string[]): Promise<RunState> {
    return this.execution.setIgnoredArtifactPatterns(runId, patterns);
  }
}
