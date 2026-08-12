import { writeRunWorkspace } from "../config.js";
import {
  MessageOutputSchema,
  REVIEW_EXPECTED_OUTPUT,
  ReviewOutputSchema,
  WorkerOutputSchema,
  assertCanMarkTaskDone,
  includesSourcePath,
  isTestPath,
  proposeDeliveryBranchName,
  reviewRepairRoute,
  slugifyFeatureTitle,
  type BuildTask,
  type MessageOutput,
  type RunState,
  isTerminalPhase,
} from "../domain.js";
const terminal = isTerminalPhase;
import { CONFIG_FAILURE_PATTERN, HarnessFailure, RunCancelledError } from "../errors.js";
import { commandEvidence, recentEvidenceOutput } from "../commands.js";
import { compactDomainSeed } from "../knowledge.js";
import { prepareGraphifyForRun } from "../graphify.js";
import { taskFrontier } from "../tracker.js";
import type { ApplicationContext } from "./application-context.js";
import type { InvocationKind } from "./agent-activity.js";
import {
  evaluateRepairProgress,
  evidenceFingerprint,
  failingTestIdsFromEvidence,
  failureCategoryFromEvidence,
  repairEdgeKey,
} from "./evidence-fingerprint.js";
import { taskForPacket, unique } from "./helpers.js";
import { updateRunConfig } from "./update-run-config.js";

export class TaskExecutionService {
  constructor(private readonly ctx: ApplicationContext) {}

  async execute(state: RunState): Promise<RunState> {
    const failed = state.tasks.find((task) => task.status === "failed");
    if (failed) {
      const detail = failed.failure ?? "unknown failure";
      const kind = CONFIG_FAILURE_PATTERN.test(detail) ? "config" : "contract";
      throw new HarnessFailure(`Task ${failed.id} failed: ${detail}`, kind, false);
    }
    const active = state.tasks.find((task) => task.status === "active");
    if (!active) {
      if (state.tasks.every((item) => item.status === "done")) {
        return this.ctx.store.record(
          { ...state, phase: "scenario_testing" },
          "implementation.completed",
        );
      }
      if (await this.ctx.isStopRequested(state.runId, state)) {
        const stopped = await this.ctx.store.record(
          {
            ...state,
            stopAfterTask: false,
            stoppedAfterTaskAt: new Date().toISOString(),
          },
          "run.stopped_after_task",
        );
        await this.ctx.clearStopRequest(state.runId);
        return stopped;
      }
      if (state.stoppedAfterTaskAt) {
        return state;
      }
    }
    const task = active ?? taskFrontier(state.tasks)[0];
    if (!task) {
      throw new HarnessFailure(
        "Build frontier is empty while pending tasks remain",
        "internal",
        false,
      );
    }
    return this.executeTaskStep(state, task);
  }

  async executeTaskStep(state: RunState, task: BuildTask): Promise<RunState> {
    switch (task.step) {
      case "pending": {
        const next = {
          ...task,
          status: "active" as const,
          step: "implementing" as const,
        };
        return this.updateTask(state, next, "task.started");
      }
      case "writing_tests":
      case "red":
        throw new HarnessFailure(
          `Task ${task.id} uses legacy TDD step "${task.step}"; pre-redesign runs cannot be resumed`,
          "contract",
          false,
        );
      case "implementing":
        return this.implementTask(state, task);
      case "verifying":
        return this.verifyTask(state, task);
      case "reviewing":
        return this.reviewTask(state, task);
      case "committing":
        return this.commitTask(state, task);
      case "done":
      case "failed":
        return state;
    }
  }

  async implementTask(state: RunState, task: BuildTask): Promise<RunState> {
    const latestEvidence = task.evidence.at(-1);
    const category = failureCategoryFromEvidence(latestEvidence, "verification");
    if (task.attempts.implementation > 0 || task.reviewSummary) {
      const gate = await this.progressGate(task, "implementer", "implementer", latestEvidence);
      if (!gate.allowed) {
        return this.blockNoProgress(state, task, gate.fingerprint, gate.summary);
      }
    }

    const invocationKind: InvocationKind =
      task.attempts.implementation > 0 || task.reviewSummary
        ? "implementation-repair"
        : "initial";
    const fullImplementerInput = {
      task: taskForPacket(task),
      verifiedCommandOutput: recentEvidenceOutput(task.evidence),
      reviewFeedback: task.reviewSummary,
      verificationCommands: this.ctx.config.commands.verification.map(
        (command) => command.command,
      ),
    };
    const continuationInput =
      task.attempts.implementation > 0 || task.reviewSummary
        ? {
            verifiedCommandOutput: recentEvidenceOutput(task.evidence),
            reviewFeedback: task.reviewSummary,
            instruction: "Continue from the latest verified command output and review feedback.",
          }
        : undefined;

    state = await this.ctx.store.record(state, "task.implementation_requested", {
      taskId: task.id,
      invocationKind,
    });

    const invocation = await this.ctx.agents.invokeInEpisode({
      runId: state.runId,
      role: "implementer",
      mode: "agent",
      objective: `Implement or repair the behavior in “${task.title}”`,
      input: fullImplementerInput,
      continuationInput,
      expectedOutput: "{summary,changedFiles}",
      schema: WorkerOutputSchema,
      constraints: [
        "Do not commit",
        "Do not write or edit tests",
        "Stop after this one task",
      ],
      knowledgeQuery: [task.title, task.description, ...task.acceptanceCriteria].join(" "),
      knowledgeFallbackQuery: compactDomainSeed(
        state.idea,
        state.reflectBrief?.confirmed,
        task.title,
        task.description,
      ),
      signal: this.ctx.signalFor(state.runId),
      causal: {
        taskId: task.id,
        phase: state.phase,
        taskStep: task.step,
        invocationKind,
        trigger: {
          event:
            task.attempts.implementation > 0 || task.reviewSummary
              ? "task.implementation_repair_needed"
              : "task.implementing",
          classification: category,
          summary:
            task.attempts.implementation > 0 || task.reviewSummary
              ? "implementation repair from verification evidence"
              : "initial implementation",
          evidenceFingerprint: task.evidenceFingerprint,
        },
      },
    });
    const workerResult = invocation.value as { summary: string; changedFiles: string[] };

    const testPatterns = this.ctx.config.workflow.testPathPatterns;
    const testEdits = workerResult.changedFiles.filter((file) => isTestPath(file, testPatterns));
    if (testEdits.length > 0) {
      throw new HarnessFailure(
        `Implementer must not write tests during executing; test paths: ${testEdits.join(", ")}`,
        "contract",
        true,
      );
    }

    const evidence = await this.runTaskVerification(state.runId, "test");
    const attempts = {
      ...task.attempts,
      implementation: task.attempts.implementation + 1,
    };
    if (evidence.passed) {
      const updated: BuildTask = {
        ...task,
        attempts,
        changedFiles: unique([...task.changedFiles, ...workerResult.changedFiles]),
        evidence: [...task.evidence, evidence],
        step: "verifying",
        status: "active",
        failure: undefined,
        reviewSummary: undefined,
      };
      return this.updateTask(
        await this.ctx.withTreeFingerprint(state),
        updated,
        "task.implementation_verified",
      );
    }

    const fingerprint = await this.fingerprintFor(task, evidence, "verification");
    const exhausted = attempts.implementation >= this.ctx.config.workflow.maxImplementationAttempts;
    const edge = repairEdgeKey(fingerprint, "implementer", "implementer");
    const updated: BuildTask = {
      ...task,
      attempts,
      changedFiles: unique([...task.changedFiles, ...workerResult.changedFiles]),
      evidence: [...task.evidence, evidence],
      evidenceFingerprint: fingerprint,
      seenEvidenceFingerprints: unique([...task.seenEvidenceFingerprints, fingerprint]),
      seenRepairEdges: unique([...task.seenRepairEdges, edge]),
      step: exhausted ? "failed" : "implementing",
      status: exhausted ? "failed" : "active",
      failure: exhausted
        ? `Targeted test failed after ${attempts.implementation} implementation attempts`
        : undefined,
    };
    return this.updateTask(
      await this.ctx.withTreeFingerprint(state),
      updated,
      exhausted ? "task.implementation_exhausted" : "task.implementation_repair_needed",
      { evidenceFingerprint: fingerprint },
    );
  }

  async verifyTask(state: RunState, task: BuildTask): Promise<RunState> {
    const evidence = [];
    for (const verification of this.ctx.config.commands.verification) {
      const result = await this.ctx.deps.commands.run(verification.command, {
        cwd: this.ctx.paths.workspaceRoot,
        timeoutMs: verification.timeoutMs,
        signal: this.ctx.signalFor(state.runId),
        ...this.ctx.commandEnvironmentOptions(),
      });
      if (result.cancelled) {
        throw new RunCancelledError(`Verification ${verification.id} cancelled`);
      }
      evidence.push(commandEvidence(`verification:${verification.id}`, result));
    }
    const passed = evidence.every((item) => item.passed);
    const maxAttempts = this.ctx.config.workflow.maxImplementationAttempts;
    const canRepair = task.attempts.implementation < maxAttempts;
    const updated: BuildTask = {
      ...task,
      evidence: [...task.evidence, ...evidence],
      step: passed ? "reviewing" : canRepair ? "implementing" : "failed",
      status: passed || canRepair ? "active" : "failed",
      failure:
        !passed && !canRepair
          ? "Command gates failed and implementation repair budget is exhausted"
          : undefined,
    };
    return this.updateTask(
      await this.ctx.withTreeFingerprint(state),
      updated,
      passed ? "task.gates_passed" : "task.gates_failed",
    );
  }

  async reviewTask(state: RunState, task: BuildTask): Promise<RunState> {
    const reviewBaseSha =
      this.ctx.config.git.enabled ? this.ctx.workspace.baseSha : undefined;
    const changedFiles = !this.ctx.config.git.enabled
      ? task.changedFiles
      : reviewBaseSha
        ? await this.ctx.git.changedFilesVersusRef(reviewBaseSha)
        : await this.ctx.git.changedFiles();
    const diffResult =
      this.ctx.config.git.enabled && changedFiles.length > 0
        ? await this.ctx.git.diffForPaths(
            changedFiles,
            this.ctx.config.workflow.reviewDiffCharacters,
            reviewBaseSha ? { baseRef: reviewBaseSha } : undefined,
          )
        : { diff: "", omittedFiles: [] as string[], truncated: false };
    const review = await this.ctx.agents.invoke({
      runId: state.runId,
      role: "reviewer",
      objective: `Independently review “${task.title}” against its acceptance criteria`,
      input: {
        task: taskForPacket(task),
        changedFiles,
        commandEvidence: recentEvidenceOutput(task.evidence),
        diff: diffResult.diff,
        diffOmittedFiles: diffResult.omittedFiles,
        reviewDiffBase: reviewBaseSha,
      },
      expectedOutput: REVIEW_EXPECTED_OUTPUT,
      schema: ReviewOutputSchema,
      knowledgeQuery: [task.title, task.description, ...task.acceptanceCriteria].join(" "),
      signal: this.ctx.signalFor(state.runId),
      knowledgeFallbackQuery: compactDomainSeed(
        state.idea,
        state.reflectBrief?.confirmed,
        task.title,
        task.description,
      ),
    });
    const blocking = review.findings.filter((finding) => finding.severity === "blocking");
    const approved = review.approved && blocking.length === 0;
    const attempts = { ...task.attempts, review: task.attempts.review + 1 };
    const reviewBudget = attempts.review < this.ctx.config.workflow.maxReviewAttempts;
    const maxAttempts = this.ctx.config.workflow.maxImplementationAttempts;
    const route = reviewRepairRoute(review.findings);
    const reviewSummary = [
      review.summary,
      ...review.findings.map(
        (finding) => `${finding.severity}/${finding.kind}: ${finding.message}`,
      ),
    ].join("\n");

    let step: BuildTask["step"] = "failed";
    let status: BuildTask["status"] = "failed";
    let failure: string | undefined =
      "Review failed and repair budget is exhausted";

    if (approved) {
      step = "committing";
      status = "active";
      failure = undefined;
    } else if (route === "production" || route === "none") {
      const canRepair = reviewBudget && task.attempts.implementation < maxAttempts;
      if (canRepair) {
        step = "implementing";
        status = "active";
        failure = undefined;
      }
    } else if (route === "test-coverage") {
      // No task-level test writer yet; record for final review and continue if only advisory-blocking.
      // Blocking test-coverage without a production finding is advisory at task level.
      if (reviewBudget && task.attempts.implementation < maxAttempts) {
        step = "implementing";
        status = "active";
        failure = undefined;
      }
    }

    const updated: BuildTask = {
      ...task,
      attempts,
      reviewSummary,
      step,
      status,
      failure,
    };
    return this.updateTask(
      await this.ctx.withTreeFingerprint(state),
      updated,
      approved ? "task.review_passed" : "task.review_failed",
      approved ? {} : { reviewRepairRoute: route },
    );
  }

  async commitTask(state: RunState, task: BuildTask): Promise<RunState> {
    const fallback: MessageOutput = {
      subject: `feat: ${task.title}`.slice(0, 100),
      body: task.description,
    };
    const message = this.ctx.config.workflow.generateCommitMessages
      ? await this.message(
          state.runId,
          `Write the commit message for completed task “${task.title}”`,
          { task: taskForPacket(task), changedFiles: task.changedFiles, review: task.reviewSummary },
          fallback,
        )
      : MessageOutputSchema.parse(fallback);
    assertCanMarkTaskDone(task);
    const commitSha = await this.ctx.git.commitTask(task.id, message, task.changedFiles);
    const graphifyUpdated = includesSourcePath(
      task.changedFiles,
      this.ctx.config.knowledge.graphify.sourceExtensions,
    )
      ? await this.ctx.knowledge.rebuildRepositoryGraph()
      : false;
    return this.updateTask(
      await this.ctx.withTreeFingerprint(state),
      { ...task, status: "done", step: "done", commitSha },
      "task.committed",
      { commitSha, graphifyUpdated },
    );
  }

  async publish(state: RunState): Promise<RunState> {
    const fallback: MessageOutput = {
      subject: `feat: ${state.idea}`.slice(0, 100),
      body: state.tasks.map((task) => `- ${task.title}`).join("\n"),
    };
    const message = await this.message(
      state.runId,
      "Write the pull-request title and body for this verified feature",
      {
        brief: state.reflectBrief?.confirmed,
        resolutions: state.grillResolutions,
        tasks: state.tasks.map(({ title, reviewSummary, commitSha }) => ({
          title,
          reviewSummary,
          commitSha,
        })),
      },
      fallback,
    );
    let working = state;
    if (this.ctx.config.git.enabled) {
      working = await this.ensureDeliveryBranchForPublish(working);
    }
    const pullRequestUrl =
      working.branchName && this.ctx.config.git.push
        ? await this.ctx.git.publish(working.branchName, message)
        : undefined;
    return this.ctx.store.record(
      { ...working, phase: "completed", pullRequestUrl },
      "run.completed",
      { pullRequestUrl },
    );
  }

  /**
   * Create the delivery branch immediately before push/PR (or at publication when push is off).
   * Retains explicit/legacy branch names; freezes the late-created name against later title edits.
   */
  private async ensureDeliveryBranchForPublish(state: RunState): Promise<RunState> {
    const existing = this.ctx.workspace.branchName ?? state.branchName;
    const title =
      state.reflectBrief?.confirmedStructured?.proposedTitle ??
      state.reflectBrief?.structured?.proposedTitle ??
      state.idea;
    const titleSlug = slugifyFeatureTitle(title);
    const branchName =
      existing ??
      proposeDeliveryBranchName({
        branchPrefix: this.ctx.config.git.branchPrefix,
        title,
        runId: state.runId,
      });

    const ensured = await this.ctx.store.withWorkspaceAdminLock(
      { runId: state.runId, action: "create-delivery-branch" },
      () => this.ctx.git.ensureDeliveryBranch(branchName),
    );

    const workspace = {
      ...this.ctx.workspace,
      branchName: ensured.branchName,
    };
    await writeRunWorkspace(this.ctx.config, state.runId, workspace);
    this.ctx.bindWorkspace(workspace);

    let next: RunState = { ...state, branchName: ensured.branchName };
    if (!existing || ensured.created) {
      next = await this.ctx.store.record(next, "run.branch_created", {
        titleSlug,
        branchName: ensured.branchName,
        headSha: ensured.headSha,
        created: ensured.created,
        retainedExisting: Boolean(existing),
      });
    }
    return next;
  }

  async message(
    runId: string,
    objective: string,
    input: unknown,
    fallback: MessageOutput,
  ): Promise<MessageOutput> {
    try {
      return await this.ctx.agents.invoke({
        runId,
        role: "message-writer",
        objective,
        input,
        expectedOutput: "{subject,body}",
        schema: MessageOutputSchema,
        buildPrompt: false,
        retrieval: false,
        signal: this.ctx.signalFor(runId),
      });
    } catch (error) {
      if (error instanceof RunCancelledError || this.ctx.signalFor(runId)?.aborted) throw error;
      return MessageOutputSchema.parse(fallback);
    }
  }

  async runTaskVerification(runId: string, purpose: string) {
    const primary = this.ctx.config.commands.verification[0]!;
    const result = await this.ctx.deps.commands.run(primary.command, {
      cwd: this.ctx.paths.workspaceRoot,
      timeoutMs: primary.timeoutMs,
      signal: this.ctx.signalFor(runId),
      ...this.ctx.commandEnvironmentOptions(),
    });
    if (result.cancelled) {
      throw new RunCancelledError(`Command cancelled: ${purpose}`);
    }
    return commandEvidence(purpose, result);
  }

  async updateTask(
    state: RunState,
    task: BuildTask,
    event: string,
    detail: Record<string, unknown> = {},
  ): Promise<RunState> {
    const next =
      task.status === "done" || task.status === "failed"
        ? await this.ctx.releaseTaskWorkerSessions(task)
        : task;
    return this.ctx.store.record(
      { ...state, tasks: state.tasks.map((item) => (item.id === next.id ? next : item)) },
      event,
      { taskId: next.id, step: next.step, ...detail },
    );
  }

  async setRag(runId: string, rag: boolean): Promise<RunState> {
    return this.ctx.store.withLock(runId, async () => {
      let state = await this.ctx.store.load(runId);
      if (terminal(state.phase)) {
        throw new Error(`Run ${runId} is already ${state.phase}`);
      }
      if (this.ctx.config.workflow.rag === rag) {
        return state;
      }
      const result = await updateRunConfig(
        this.ctx,
        state.runId,
        state.configRevision ?? 0,
        { workflow: { rag } },
        { reason: "rag", detail: { rag } },
        { alreadyLocked: true },
      );
      state = result.state;
      await this.ctx.syncArtifacts(state);
      return state;
    });
  }

  async setGraphify(runId: string, enabled: boolean): Promise<RunState> {
    return this.ctx.store.withLock(runId, async () => {
      let state = await this.ctx.store.load(runId);
      if (terminal(state.phase)) {
        throw new Error(`Run ${runId} is already ${state.phase}`);
      }
      if (this.ctx.config.knowledge.graphify.enabled === enabled) {
        return state;
      }
      const result = await updateRunConfig(
        this.ctx,
        state.runId,
        state.configRevision ?? 0,
        { knowledge: { graphify: { enabled } } },
        { reason: "graphify", detail: { enabled } },
        { alreadyLocked: true },
      );
      state = result.state;
      if (enabled) {
        await prepareGraphifyForRun(this.ctx.config, this.ctx.graphifyRunner, this.ctx.paths);
      }
      await this.ctx.syncArtifacts(state);
      return state;
    });
  }

  async setIgnoredArtifactPatterns(runId: string, patterns: string[]): Promise<RunState> {
    return this.ctx.store.withLock(runId, async () => {
      const state = await this.ctx.store.load(runId);
      if (state.phase === "completed" || state.phase === "cancelled") {
        throw new Error(`Run ${runId} is already ${state.phase}`);
      }
      const result = await updateRunConfig(
        this.ctx,
        state.runId,
        state.configRevision ?? 0,
        { git: { ignoredArtifactPatterns: unique(patterns) } },
        { reason: "ignored-artifacts", detail: { count: unique(patterns).length } },
        { alreadyLocked: true, allowNoChange: true },
      );
      await this.ctx.syncArtifacts(result.state);
      return result.state;
    });
  }

  private async fingerprintFor(
    task: BuildTask,
    evidence: BuildTask["evidence"][number] | undefined,
    fallbackCategory: string,
  ): Promise<string> {
    const gitEnabled = this.ctx.config.git.enabled;
    const sourceTreeState = gitEnabled ? await this.ctx.git.treeFingerprint() : "git-disabled";
    return evidenceFingerprint({
      taskId: task.id,
      step: task.step,
      sourceTreeState,
      failingTestIds: failingTestIdsFromEvidence(evidence),
      failureCategory:
        fallbackCategory === "test-issue"
          ? "test-issue"
          : failureCategoryFromEvidence(evidence, fallbackCategory),
      reviewFinding: task.reviewSummary,
      frozenConfigHash: this.ctx.config.workflow.maxImplementationAttempts.toString(),
    });
  }

  private async progressGate(
    task: BuildTask,
    fromRole: string,
    toRole: string,
    evidence: BuildTask["evidence"][number] | undefined,
  ) {
    const fingerprint = await this.fingerprintFor(task, evidence, "verification");
    return evaluateRepairProgress({
      fingerprint,
      lastFingerprint: task.evidenceFingerprint,
      seenFingerprints: task.seenEvidenceFingerprints,
      seenEdges: task.seenRepairEdges,
      fromRole,
      toRole,
    });
  }

  private async blockNoProgress(
    state: RunState,
    task: BuildTask,
    fingerprint: string,
    summary: string,
  ): Promise<RunState> {
    const released = await this.ctx.releaseTaskWorkerSessions(task);
    const updated: BuildTask = {
      ...released,
      evidenceFingerprint: fingerprint,
      seenEvidenceFingerprints: unique([...released.seenEvidenceFingerprints, fingerprint]),
      step: "failed",
      status: "failed",
      failure: summary,
    };
    return this.updateTask(await this.ctx.withTreeFingerprint(state), updated, "task.no_progress", {
      evidenceFingerprint: fingerprint,
      kind: "no_progress",
    });
  }
}
