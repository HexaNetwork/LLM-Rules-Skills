import { writeRunWorkspace } from "../config.js";
import {
  MessageOutputSchema,
  ReviewOutputSchema,
  WorkerOutputSchema,
  assertCanMarkTaskDone,
  canToggleTaskTdd,
  includesSourcePath,
  isTestPath,
  proposeDeliveryBranchName,
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
  classifyRunnableRed,
  repairEdgeKey,
} from "./evidence-fingerprint.js";
import { normalizePathKey, taskForPacket, unique } from "./helpers.js";
import { updateRunConfig } from "./update-run-config.js";

function isAffectedPath(filePath: string, affectedPaths: readonly string[]): boolean {
  const key = normalizePathKey(filePath);
  return affectedPaths.some((allowed) => normalizePathKey(allowed) === key);
}

function isRedWriterAllowedPath(
  filePath: string,
  testPatterns: readonly string[],
  affectedPaths: readonly string[],
): boolean {
  return isTestPath(filePath, testPatterns) || isAffectedPath(filePath, affectedPaths);
}

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
        return this.ctx.store.record({ ...state, phase: "publishing" }, "implementation.completed");
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
          step: task.tdd ? ("writing_tests" as const) : ("implementing" as const),
        };
        return this.updateTask(state, next, "task.started");
      }
      case "writing_tests":
        return this.writeTests(state, task);
      case "red":
        return this.confirmRed(state, task);
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

  async writeTests(state: RunState, task: BuildTask): Promise<RunState> {
    // A config repair can intentionally leave its project-settings file dirty.
    // Capture that known baseline before the writer runs so the path allowlist
    // attributes only paths introduced by this invocation to the writer.
    const knownPaths = this.ctx.config.git.enabled
      ? new Set(await this.ctx.git.changedFiles())
      : undefined;
    const isRepair = Boolean(task.redCheckpointSha) && task.attempts.implementation > 0;
    const role = isRepair ? "test-writer" : "red-writer";
    const result = await this.ctx.agents.invoke({
      runId: state.runId,
      role,
      objective: isRepair
        ? `Repair the failing behavioral tests for “${task.title}” without weakening acceptance criteria`
        : `Establish runnable failing behavioral coverage for “${task.title}” (tests may include minimal compile scaffolds)`,
      input: {
        task: taskForPacket(task),
        priorCommandOutput: recentEvidenceOutput(task.evidence),
        ...(isRepair
          ? {
              redCheckpointSha: task.redCheckpointSha,
              redBaseSha: task.redBaseSha,
              repairMode: true,
            }
          : {
              allowScaffoldsOnAffectedPaths: true,
              affectedPaths: task.affectedPaths,
            }),
      },
      expectedOutput: "{summary,changedFiles}",
      schema: WorkerOutputSchema,
      constraints: isRepair
        ? ["Change tests only", "Do not implement production code", "Do not add production scaffolds"]
        : [
            "Reach a runnable RED (tests execute and fail on assertions)",
            "Minimal compile scaffolds on declared affectedPaths are allowed",
            "Do not implement real behavior or make tests green",
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
        invocationKind: isRepair ? "test-repair" : task.attempts.tests > 0 ? "continuation" : "initial",
        trigger: {
          event: isRepair ? "task.test_repair" : "task.writing_tests",
          classification: isRepair ? "test-repair" : "initial",
          summary: isRepair
            ? "bounded test-writer repair from diagnostic evidence"
            : "initial red-writer for runnable RED",
          evidenceFingerprint: task.evidenceFingerprint,
        },
      },
    });
    const observedPaths = this.ctx.config.git.enabled
      ? (await this.ctx.git.changedFiles()).filter((file) => !knownPaths!.has(file))
      : result.changedFiles;
    const testPatterns = this.ctx.config.workflow.testPathPatterns;
    const illegal = isRepair
      ? observedPaths.filter((file) => !isTestPath(file, testPatterns))
      : observedPaths.filter(
          (file) => !isRedWriterAllowedPath(file, testPatterns, task.affectedPaths),
        );
    if (illegal.length > 0) {
      throw new HarnessFailure(
        isRepair
          ? `Test writer changed non-test paths: ${illegal.join(", ")}`
          : `Red writer changed paths outside tests and affectedPaths: ${illegal.join(", ")}`,
        "config",
        false,
      );
    }
    const testPaths = unique([
      ...task.testPaths,
      ...observedPaths.filter((file) => isTestPath(file, testPatterns)),
    ]);
    const scaffoldPaths = isRepair
      ? []
      : observedPaths.filter(
          (file) =>
            !isTestPath(file, testPatterns) && isAffectedPath(file, task.affectedPaths),
        );
    const checkpointCandidatePaths = unique([...observedPaths.filter((file) =>
      isRepair
        ? isTestPath(file, testPatterns)
        : isRedWriterAllowedPath(file, testPatterns, task.affectedPaths),
    )]);
    const evidence = await this.runTargetedTest(state.runId, task, "tdd:red");
    const attempts = { ...task.attempts, tests: task.attempts.tests + 1 };
    const commandOutput = `${evidence.stdout}\n${evidence.stderr}`;
    const commandNotLaunched = /command not found|not recognized/i.test(commandOutput);
    const runnable = classifyRunnableRed(evidence);
    const meaningfulRed =
      evidence.exitCode !== 0 &&
      evidence.exitCode !== 124 &&
      !/no tests found|no test files found/i.test(commandOutput) &&
      !commandNotLaunched;
    // Initial / continuation RED requires runnable red; repair keeps meaningful RED.
    const acceptedRed = isRepair ? meaningfulRed : runnable.runnable;
    if (isRepair && meaningfulRed) {
      return this.acceptTestRepairCheckpoint(state, task, {
        attempts,
        testPaths,
        changedFiles: unique([...task.changedFiles, ...result.changedFiles]),
        evidence: [...task.evidence, evidence],
        observedPaths,
      });
    }
    const exhausted = !acceptedRed && attempts.tests >= this.ctx.config.workflow.maxTestAttempts;
    const redFailure = exhausted
      ? commandNotLaunched
        ? formatCommandNotLaunchedFailure(evidence.command, evidence.stderr, evidence.stdout)
        : isRepair
          ? "Test writer could not produce a meaningful RED run"
          : `Red writer could not reach runnable RED${
              !runnable.runnable ? ` (${runnable.reason})` : ""
            }`
      : undefined;
    let updated: BuildTask = {
      ...task,
      attempts,
      testPaths,
      changedFiles: unique([...task.changedFiles, ...result.changedFiles, ...scaffoldPaths]),
      evidence: [...task.evidence, evidence],
      step: acceptedRed ? "red" : exhausted ? "failed" : "writing_tests",
      status: exhausted ? "failed" : "active",
      failure: redFailure,
    };
    if (acceptedRed) {
      updated = await this.establishRedCheckpoint(updated, checkpointCandidatePaths);
    }
    return this.updateTask(
      await this.ctx.withTreeFingerprint(state),
      updated,
      acceptedRed ? "task.red_observed" : "task.red_rejected",
      acceptedRed
        ? {
            redCheckpointSha: updated.redCheckpointSha,
            redBaseSha: updated.redBaseSha,
          }
        : !runnable.runnable && !isRepair
          ? { runnableRedReason: runnable.reason }
          : {},
    );
  }

  async confirmRed(state: RunState, task: BuildTask): Promise<RunState> {
    let next = task;
    if (this.ctx.config.git.enabled && !next.redCheckpointSha) {
      const recovered = await this.ctx.git.findRedCheckpoint(next.id);
      if (recovered) {
        next = {
          ...next,
          redBaseSha: recovered.baseSha,
          redCheckpointSha: recovered.sha,
          redCheckpointNumber: (next.redCheckpointNumber ?? 0) + 1,
          redCheckpointPaths: recovered.paths.length > 0 ? recovered.paths : next.testPaths,
          redCheckpointHistory: unique([...next.redCheckpointHistory, recovered.sha]),
        };
        state = await this.updateTask(state, next, "task.red_checkpoint_recovered", {
          redCheckpointSha: recovered.sha,
          redBaseSha: recovered.baseSha,
        });
      } else if (next.testPaths.length > 0) {
        next = await this.establishRedCheckpoint(next, next.testPaths);
        state = await this.updateTask(state, next, "task.red_checkpoint_committed", {
          redCheckpointSha: next.redCheckpointSha,
          redBaseSha: next.redBaseSha,
        });
      }
    }
    return this.updateTask(
      state,
      { ...next, step: "implementing" },
      "task.red_confirmed",
    );
  }

  async implementTask(state: RunState, task: BuildTask): Promise<RunState> {
    const latestBeforeResume = task.evidence.at(-1);
    if (
      task.tdd &&
      task.attempts.implementation > 0 &&
      !latestBeforeResume?.purpose.startsWith("verification:")
    ) {
      const recovery = await this.runTargetedTest(state.runId, task, "tdd:resume-check");
      if (recovery.passed) {
        return this.updateTask(
          await this.ctx.withTreeFingerprint(state),
          { ...task, evidence: [...task.evidence, recovery], step: "verifying" },
          "task.recovered_green",
        );
      }
      task = { ...task, evidence: [...task.evidence, recovery] };
      state = await this.updateTask(await this.ctx.withTreeFingerprint(state), task, "task.resume_check_failed");
    }

    const latestEvidence = task.evidence.at(-1);
    const category = failureCategoryFromEvidence(latestEvidence, "verification");
    // First implement after RED: missing production symbols are the implementer's job.
    if (
      category === "test-repair" &&
      task.tdd &&
      task.redCheckpointSha &&
      task.attempts.implementation > 0
    ) {
      return this.routeToTestRepair(state, task, latestEvidence);
    }

    const skipProgressGate =
      latestEvidence?.purpose === "tdd:resume-check" ||
      latestEvidence?.purpose === "guard:test-integrity";
    if (!skipProgressGate && (task.attempts.implementation > 0 || task.reviewSummary)) {
      const gate = await this.progressGate(task, "implementer", "implementer", latestEvidence);
      if (!gate.allowed) {
        return this.blockNoProgress(state, task, gate.fingerprint, gate.summary);
      }
    }

    let episode = task.implementerSession;
    const maxContextTurns = this.ctx.config.workflow.maxContextTurns;
    if (
      episode?.providerSessionId &&
      maxContextTurns > 0 &&
      (episode.turns ?? 0) >= maxContextTurns
    ) {
      await this.ctx.agents.releaseProviderSession(episode.providerSessionId);
      state = await this.ctx.store.record(
        {
          ...state,
          tasks: state.tasks.map((item) =>
            item.id === task.id ? { ...item, implementerSession: undefined } : item,
          ),
        },
        "circuit_breaker.context_turns",
        {
          taskId: task.id,
          maxContextTurns,
          turns: episode.turns,
        },
      );
      task = { ...task, implementerSession: undefined };
      episode = undefined;
    }
    const reuseContext =
      Boolean(episode?.providerSessionId) && (task.integrityViolationCount ?? 0) === 0;
    const invocationKind: InvocationKind =
      task.attempts.implementation > 0 || task.reviewSummary
        ? "implementation-repair"
        : episode?.providerSessionId
          ? "continuation"
          : "initial";
    const invocation = await this.ctx.agents.invokeInEpisode({
      runId: state.runId,
      role: "implementer",
      mode: "agent",
      objective: `Implement or repair the behavior in “${task.title}”`,
      input: {
        task: taskForPacket(task),
        verifiedCommandOutput: recentEvidenceOutput(task.evidence),
        reviewFeedback: task.reviewSummary,
      },
      expectedOutput: "{summary,changedFiles}",
      schema: WorkerOutputSchema,
      constraints: ["Do not commit", "Do not weaken tests", "Stop after this one task"],
      knowledgeQuery: [task.title, task.description, ...task.acceptanceCriteria].join(" "),
      knowledgeFallbackQuery: compactDomainSeed(
        state.idea,
        state.reflectBrief?.confirmed,
        task.title,
        task.description,
      ),
      providerSessionId: reuseContext ? episode?.providerSessionId : undefined,
      previousGuidanceFingerprint: reuseContext ? episode?.guidanceFingerprint : undefined,
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
    const result = invocation.value;
    task = {
      ...task,
      implementerSession: {
        providerSessionId: invocation.providerSessionId,
        guidanceFingerprint: invocation.guidanceFingerprint ?? episode?.guidanceFingerprint,
        turns: (episode?.turns ?? 0) + 1,
      },
    };

    const integrity = await this.enforceTestIntegrity(state, task, result.changedFiles);
    state = integrity.state;
    task = integrity.task;
    if (integrity.restoredOnly) {
      return state;
    }

    const evidence = await this.runTargetedTest(state.runId, task, task.tdd ? "tdd:green" : "test");
    const attempts = {
      ...task.attempts,
      implementation: task.attempts.implementation + 1,
    };
    if (evidence.passed) {
      const updated: BuildTask = {
        ...task,
        attempts,
        changedFiles: unique([...task.changedFiles, ...result.changedFiles]),
        evidence: [...task.evidence, evidence],
        step: "verifying",
        status: "active",
        failure: undefined,
        reviewSummary: undefined,
      };
      return this.updateTask(
        await this.ctx.withTreeFingerprint(state),
        updated,
        "task.green_observed",
      );
    }

    const fingerprint = await this.fingerprintFor(task, evidence, "verification");
    const exhausted = attempts.implementation >= this.ctx.config.workflow.maxImplementationAttempts;
    const edge = repairEdgeKey(fingerprint, "implementer", "implementer");
    const updated: BuildTask = {
      ...task,
      attempts,
      changedFiles: unique([...task.changedFiles, ...result.changedFiles]),
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
    const canRepair = task.attempts.implementation < this.ctx.config.workflow.maxImplementationAttempts;
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
    const changedFiles = this.ctx.config.git.enabled ? await this.ctx.git.changedFiles() : task.changedFiles;
    const diffResult =
      this.ctx.config.git.enabled && changedFiles.length > 0
        ? await this.ctx.git.diffForPaths(changedFiles, this.ctx.config.workflow.reviewDiffCharacters)
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
      },
      expectedOutput: "{approved,summary,findings:[{severity,message}]}",
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
    const canRepair =
      attempts.review < this.ctx.config.workflow.maxReviewAttempts &&
      task.attempts.implementation < this.ctx.config.workflow.maxImplementationAttempts;
    const updated: BuildTask = {
      ...task,
      attempts,
      reviewSummary: [
        review.summary,
        ...review.findings.map((finding) => `${finding.severity}: ${finding.message}`),
      ].join("\n"),
      step: approved ? "committing" : canRepair ? "implementing" : "failed",
      status: approved || canRepair ? "active" : "failed",
      failure: !approved && !canRepair ? "Review failed and repair budget is exhausted" : undefined,
    };
    // diffForPaths may run `git add --intent-to-add`, which changes porcelain; re-stamp so the
    // next advance does not false-block on workspace divergence.
    return this.updateTask(
      await this.ctx.withTreeFingerprint(state),
      updated,
      approved ? "task.review_passed" : "task.review_failed",
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
    const checkpointShas = unique([
      ...task.redCheckpointHistory,
      ...(task.redCheckpointSha ? [task.redCheckpointSha] : []),
    ]);
    const commitSha =
      checkpointShas.length > 0
        ? await this.ctx.git.squashCheckpointsIntoTaskCommit({
            taskId: task.id,
            message,
            reportedPaths: task.changedFiles,
            redCheckpointShas: checkpointShas,
            expectedBranch: state.branchName,
            baseSha: this.ctx.workspace.baseSha,
          })
        : await this.ctx.git.commitTask(task.id, message, task.changedFiles, {
            redCheckpointShas: checkpointShas,
          });
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
      { commitSha, graphifyUpdated, redCheckpointShas: checkpointShas },
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
    // Audit when we first register a delivery branch for this run (create or attach).
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

  async runTargetedTest(runId: string, task: BuildTask, purpose: string) {
    const primary = this.ctx.config.commands.verification[0]!;
    let command = primary.command;
    if (task.testFilter) {
      const template = this.ctx.config.commands.testTargetTemplate;
      if (!template || !template.includes("{filter}")) {
        throw new HarnessFailure(
          `Task ${task.id} requires test filter ${task.testFilter}, but commands.testTargetTemplate is not configured`,
          "config",
          false,
        );
      }
      if (!/^[A-Za-z0-9_.$*?/:\\[\]{}-]+$/.test(task.testFilter)) {
        throw new HarnessFailure(
          `Task ${task.id} has an unsafe test filter`,
          "config",
          false,
        );
      }
      command = template.replaceAll("{filter}", task.testFilter);
    }
    const result = await this.ctx.deps.commands.run(command, {
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
        ? await this.ctx.releaseImplementerSession(task)
        : task;
    return this.ctx.store.record(
      { ...state, tasks: state.tasks.map((item) => (item.id === next.id ? next : item)) },
      event,
      { taskId: next.id, step: next.step, ...detail },
    );
  }

  async setTdd(runId: string, tdd: boolean, taskId?: string): Promise<RunState> {
    return this.ctx.store.withLock(runId, async () => {
      let state = await this.ctx.store.load(runId);
      if (terminal(state.phase)) {
        throw new Error(`Run ${runId} is already ${state.phase}`);
      }

      if (taskId) {
        const task = state.tasks.find((item) => item.id === taskId);
        if (!task) throw new Error(`Unknown task id: ${taskId}`);
        if (!canToggleTaskTdd(task)) {
          throw new Error(
            `Cannot change TDD for task ${taskId} once past pending (step=${task.step})`,
          );
        }
        state = await this.updateTask(
          state,
          { ...task, tdd },
          "task.tdd_updated",
          { tdd },
        );
        await this.ctx.syncArtifacts(state);
        return state;
      }

      const previous = state.tasks;
      const tasks = previous.map((task) => (canToggleTaskTdd(task) ? { ...task, tdd } : task));
      const tasksUpdated = tasks.filter((task, index) => task.tdd !== previous[index]?.tdd).length;
      if (this.ctx.config.workflow.tdd === tdd) {
        state = await this.ctx.store.record(
          { ...state, tasks },
          "run.tdd_updated",
          { tdd, tasksUpdated },
        );
      } else {
        const result = await updateRunConfig(
          this.ctx,
          state.runId,
          state.configRevision ?? 0,
          { workflow: { tdd } },
          { reason: "tdd", detail: { tdd, tasksUpdated } },
          {
            alreadyLocked: true,
            transformState: (next) => ({ ...next, tasks }),
          },
        );
        state = result.state;
      }
      await this.ctx.syncArtifacts(state);
      return state;
    });
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

  private async establishRedCheckpoint(
    task: BuildTask,
    candidatePaths: string[],
  ): Promise<BuildTask> {
    if (!this.ctx.config.git.enabled) {
      return {
        ...task,
        redCheckpointPaths: unique([...task.redCheckpointPaths, ...candidatePaths]),
      };
    }
    const existing = await this.ctx.git.findRedCheckpoint(task.id);
    const testPatterns = this.ctx.config.workflow.testPathPatterns;
    const allowed = unique(
      (candidatePaths.length > 0 ? candidatePaths : task.testPaths).filter((file) =>
        isRedWriterAllowedPath(file, testPatterns, task.affectedPaths),
      ),
    );
    if (existing && task.redCheckpointSha === existing.sha) {
      // Allow a new checkpoint when dirty allowed paths advanced past the current HEAD checkpoint.
      const dirty = new Set(await this.ctx.git.changedFiles());
      const dirtyAllowed = allowed.filter((file) => dirty.has(file));
      if (dirtyAllowed.length === 0) {
        return task;
      }
    }
    if (existing && !task.redCheckpointSha) {
      return {
        ...task,
        redBaseSha: existing.baseSha,
        redCheckpointSha: existing.sha,
        redCheckpointNumber: (task.redCheckpointNumber ?? 0) + 1,
        redCheckpointPaths: existing.paths.length > 0 ? existing.paths : allowed,
        redCheckpointHistory: unique([...task.redCheckpointHistory, existing.sha]),
      };
    }
    const committed = await this.ctx.git.commitRedCheckpoint({
      taskId: task.id,
      taskTitle: task.title,
      paths: allowed.length > 0 ? allowed : task.testPaths,
    });
    if (!committed) return task;
    return {
      ...task,
      redBaseSha: committed.baseSha,
      redCheckpointSha: committed.sha,
      redCheckpointNumber: (task.redCheckpointNumber ?? 0) + 1,
      redCheckpointPaths: committed.paths,
      redCheckpointHistory: unique([...task.redCheckpointHistory, committed.sha]),
      changedFiles: unique([...task.changedFiles, ...committed.paths]),
      testPaths: unique([
        ...task.testPaths,
        ...committed.paths.filter((file) => isTestPath(file, testPatterns)),
      ]),
    };
  }

  private async enforceTestIntegrity(
    state: RunState,
    task: BuildTask,
    reportedChangedFiles: string[],
  ): Promise<{ state: RunState; task: BuildTask; restoredOnly: boolean }> {
    const testPatterns = this.ctx.config.workflow.testPathPatterns;
    // Integrity protects recorded test paths only — scaffolds may be replaced by the implementer.
    const recordedAll =
      task.redCheckpointPaths.length > 0 ? task.redCheckpointPaths : task.testPaths;
    const recorded = recordedAll.filter((file) => isTestPath(file, testPatterns));
    if (recorded.length === 0) {
      return { state, task, restoredOnly: false };
    }
    if (!this.ctx.config.git.enabled || !task.redCheckpointSha) {
      // Legacy / git-disabled fallback: detect reported or porcelain test edits.
      const observedPaths = this.ctx.config.git.enabled
        ? await this.ctx.git.changedFiles()
        : reportedChangedFiles;
      const touchedTests = observedPaths.filter((file) =>
        recorded.some((testPath) => normalizePathKey(testPath) === normalizePathKey(file)),
      );
      if (touchedTests.length === 0) {
        return { state, task, restoredOnly: false };
      }
      const attempts = {
        ...task.attempts,
        implementation: task.attempts.implementation + 1,
      };
      const exhausted = attempts.implementation >= this.ctx.config.workflow.maxImplementationAttempts;
      const failure = `Implementer modified recorded test files: ${touchedTests.join(", ")}`;
      const updated: BuildTask = {
        ...task,
        attempts,
        changedFiles: unique([...task.changedFiles, ...reportedChangedFiles]),
        evidence: [
          ...task.evidence,
          {
            purpose: "guard:test-tamper",
            command: "deterministic-test-path-guard",
            exitCode: 1,
            passed: false,
            stdout: "",
            stderr: failure,
            durationMs: 0,
            at: new Date().toISOString(),
          },
        ],
        step: exhausted ? "failed" : "implementing",
        status: exhausted ? "failed" : "active",
        failure: exhausted ? failure : undefined,
        reviewSummary: failure,
      };
      const nextState = await this.updateTask(
        await this.ctx.withTreeFingerprint(state),
        updated,
        "task.implementation_test_tamper",
        { passed: false },
      );
      return { state: nextState, task: updated, restoredOnly: true };
    }
    const touched = await this.ctx.git.pathsChangedVersusSha(task.redCheckpointSha, recorded);
    if (touched.length === 0) {
      return { state, task, restoredOnly: false };
    }
    await this.ctx.git.restorePathsFromSha(task.redCheckpointSha, touched);
    const dirtyAfter = await this.ctx.git.changedFiles();
    const productionDirty = dirtyAfter.filter(
      (file) =>
        !recorded.some((testPath) => normalizePathKey(testPath) === normalizePathKey(file)),
    );
    const violationCount = (task.integrityViolationCount ?? 0) + 1;
    const releaseContext = violationCount >= 2;
    if (releaseContext && task.implementerSession?.providerSessionId) {
      await this.ctx.agents.releaseProviderSession(task.implementerSession.providerSessionId);
    }
    const failIntegrity = violationCount >= 3 && productionDirty.length === 0;
    const updated: BuildTask = {
      ...task,
      integrityViolationCount: violationCount,
      implementerSession: releaseContext || failIntegrity ? undefined : task.implementerSession,
      changedFiles: unique([...task.changedFiles, ...reportedChangedFiles, ...productionDirty]),
      evidence: [
        ...task.evidence,
        {
          purpose: "guard:test-integrity",
          command: "restore-from-red-checkpoint",
          exitCode: failIntegrity ? 1 : 0,
          passed: !failIntegrity,
          stdout: `Restored ${touched.join(", ")} from ${task.redCheckpointSha}`,
          stderr: failIntegrity ? "Repeated test integrity violations without production progress" : "",
          durationMs: 0,
          at: new Date().toISOString(),
        },
      ],
      reviewSummary: `Restored recorded tests from RED checkpoint: ${touched.join(", ")}`,
      step: failIntegrity ? "failed" : "implementing",
      status: failIntegrity ? "failed" : "active",
      failure: failIntegrity
        ? "Repeated test integrity violations without production progress"
        : undefined,
    };
    // Restoration alone does not consume an implementation attempt.
    const nextState = await this.updateTask(
      await this.ctx.withTreeFingerprint(state),
      updated,
      failIntegrity ? "task.test_integrity_exhausted" : "test_integrity.restored",
      {
        restoredPaths: touched,
        redCheckpointSha: task.redCheckpointSha,
        consumedImplementationAttempt: false,
        releasedProviderContext: releaseContext,
        kind: "test_integrity",
      },
    );
    return {
      state: nextState,
      task: updated,
      restoredOnly: failIntegrity || productionDirty.length === 0,
    };
  }

  private async fingerprintFor(
    task: BuildTask,
    evidence: BuildTask["evidence"][number] | undefined,
    fallbackCategory: string,
  ): Promise<string> {
    const sourceTreeState = this.ctx.config.git.enabled
      ? await this.ctx.git.treeFingerprint()
      : "git-disabled";
    return evidenceFingerprint({
      taskId: task.id,
      step: task.step,
      sourceTreeState,
      redCheckpointSha: task.redCheckpointSha,
      failingTestIds: failingTestIdsFromEvidence(evidence),
      failureCategory: failureCategoryFromEvidence(evidence, fallbackCategory),
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
    if (task.implementerSession?.providerSessionId) {
      await this.ctx.agents.releaseProviderSession(task.implementerSession.providerSessionId);
    }
    const updated: BuildTask = {
      ...task,
      implementerSession: undefined,
      evidenceFingerprint: fingerprint,
      seenEvidenceFingerprints: unique([...task.seenEvidenceFingerprints, fingerprint]),
      step: "failed",
      status: "failed",
      failure: summary,
    };
    return this.updateTask(await this.ctx.withTreeFingerprint(state), updated, "task.no_progress", {
      evidenceFingerprint: fingerprint,
      kind: "no_progress",
    });
  }

  private async routeToTestRepair(
    state: RunState,
    task: BuildTask,
    evidence: BuildTask["evidence"][number] | undefined,
  ): Promise<RunState> {
    const fingerprint = await this.fingerprintFor(task, evidence, "test-repair");
    if (task.acceptedTestRepairFingerprints.includes(fingerprint)) {
      return this.blockNoProgress(
        state,
        task,
        fingerprint,
        "Test-repair already accepted for this implementation-failure fingerprint",
      );
    }
    const gate = evaluateRepairProgress({
      fingerprint,
      lastFingerprint: task.evidenceFingerprint,
      seenFingerprints: task.seenEvidenceFingerprints,
      seenEdges: task.seenRepairEdges,
      fromRole: "implementer",
      toRole: "test-writer",
    });
    if (!gate.allowed) {
      return this.blockNoProgress(state, task, gate.fingerprint, gate.summary);
    }
    const edge = repairEdgeKey(fingerprint, "implementer", "test-writer");
    const updated: BuildTask = {
      ...task,
      evidenceFingerprint: fingerprint,
      seenEvidenceFingerprints: unique([...task.seenEvidenceFingerprints, fingerprint]),
      seenRepairEdges: unique([...task.seenRepairEdges, edge]),
      step: "writing_tests",
      status: "active",
      reviewSummary: "Routed to test-writer after test-repair candidate classification",
    };
    return this.updateTask(
      await this.ctx.withTreeFingerprint(state),
      updated,
      "task.test_repair_routed",
      { evidenceFingerprint: fingerprint },
    );
  }

  private async acceptTestRepairCheckpoint(
    state: RunState,
    task: BuildTask,
    args: {
      attempts: BuildTask["attempts"];
      testPaths: string[];
      changedFiles: string[];
      evidence: BuildTask["evidence"];
      observedPaths: string[];
    },
  ): Promise<RunState> {
    const fingerprint = task.evidenceFingerprint ?? (await this.fingerprintFor(task, args.evidence.at(-1), "test-repair"));
    // Counterfactual RED: candidate tests must still fail against production at redBaseSha.
    if (this.ctx.config.git.enabled && task.redBaseSha) {
      const counterfactual = await this.counterfactualRedAccepted(task, args.observedPaths);
      if (!counterfactual.accepted) {
        if (task.redCheckpointSha) {
          await this.ctx.git.restorePathsFromSha(task.redCheckpointSha, args.testPaths);
        }
        return this.blockNoProgress(
          state,
          {
            ...task,
            attempts: args.attempts,
            evidence: args.evidence,
          },
          fingerprint,
          counterfactual.reason,
        );
      }
    }
    const withCheckpoint = await this.establishRedCheckpoint(
      {
        ...task,
        attempts: args.attempts,
        testPaths: args.testPaths,
        changedFiles: args.changedFiles,
        evidence: args.evidence,
      },
      args.observedPaths,
    );
    const updated: BuildTask = {
      ...withCheckpoint,
      acceptedTestRepairFingerprints: unique([
        ...withCheckpoint.acceptedTestRepairFingerprints,
        fingerprint,
      ]),
      evidenceFingerprint: undefined,
      step: "implementing",
      status: "active",
      failure: undefined,
      reviewSummary: "Accepted repaired RED checkpoint after counterfactual verification",
    };
    return this.updateTask(
      await this.ctx.withTreeFingerprint(state),
      updated,
      "task.test_repair_accepted",
      {
        redCheckpointSha: updated.redCheckpointSha,
        evidenceFingerprint: fingerprint,
      },
    );
  }

  private async counterfactualRedAccepted(
    task: BuildTask,
    candidatePaths: string[],
  ): Promise<{ accepted: boolean; reason: string }> {
    if (!task.redBaseSha || candidatePaths.length === 0) {
      return { accepted: true, reason: "no counterfactual baseline" };
    }
    // Soft counterfactual: stash production dirty state is not required because
    // we only need tests to remain meaningful RED in the current workspace after
    // the repair writer ran (production code is still the post-implement tree).
    // Stronger isolation would use a temporary worktree; for harness runs we
    // validate meaningful RED against the current production tree and reject
    // infrastructure / empty failures.
    const evidence = task.evidence.at(-1);
    if (!evidence || evidence.passed) {
      return { accepted: false, reason: "Candidate test repair did not remain RED" };
    }
    const output = `${evidence.stdout}\n${evidence.stderr}`;
    if (/command not found|not recognized|no tests found|no test files found/i.test(output)) {
      return { accepted: false, reason: "Candidate test repair failed for infrastructure reasons" };
    }
    return { accepted: true, reason: "meaningful RED" };
  }
}

function formatCommandNotLaunchedFailure(command: string, stderr: string, stdout: string): string {
  const detail = (stderr.trim() || stdout.trim()).slice(0, 500);
  return detail
    ? `Test command could not be launched: ${command}\n${detail}`
    : `Test command could not be launched: ${command}`;
}
