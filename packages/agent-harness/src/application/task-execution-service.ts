import {
  HarnessConfigSchema,
  configurationHash,
} from "../config.js";
import {
  MessageOutputSchema,
  ReviewOutputSchema,
  WorkerOutputSchema,
  assertCanMarkTaskDone,
  canToggleTaskTdd,
  includesSourcePath,
  isTestPath,
  type BuildTask,
  type MessageOutput,
  type RunState,
  isTerminalPhase,
} from "../domain.js";

const terminal = isTerminalPhase;
import { HarnessFailure, RunCancelledError } from "../errors.js";
import { commandEvidence, recentEvidenceOutput } from "../commands.js";
import { compactDomainSeed } from "../knowledge.js";
import { taskFrontier } from "../tracker.js";
import type { ApplicationContext } from "./application-context.js";
import { normalizePathKey, taskForPacket, unique } from "./helpers.js";

export class TaskExecutionService {
  constructor(private readonly ctx: ApplicationContext) {}

  async execute(state: RunState): Promise<RunState> {
    const failed = state.tasks.find((task) => task.status === "failed");
    if (failed) {
      throw new HarnessFailure(
        `Task ${failed.id} failed: ${failed.failure ?? "unknown failure"}`,
        "contract",
        false,
      );
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
        return this.updateTask(
          state,
          { ...task, step: "implementing" },
          "task.red_confirmed",
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

  async writeTests(state: RunState, task: BuildTask): Promise<RunState> {
    // A config repair can intentionally leave its project-settings file dirty.
    // Capture that known baseline before the writer runs so the test-only guard
    // attributes only paths introduced by this invocation to the test writer.
    const knownPaths = this.ctx.config.git.enabled
      ? new Set(await this.ctx.git.changedFiles())
      : undefined;
    const result = await this.ctx.agents.invoke({
      runId: state.runId,
      role: "test-writer",
      objective: `Write the next failing behavioral test for “${task.title}”`,
      input: {
        task: taskForPacket(task),
        priorCommandOutput: recentEvidenceOutput(task.evidence),
      },
      expectedOutput: "{summary,changedFiles}",
      schema: WorkerOutputSchema,
      constraints: ["Change tests only", "Do not implement production code"],
      knowledgeQuery: [task.title, task.description, ...task.acceptanceCriteria].join(" "),
      knowledgeFallbackQuery: compactDomainSeed(
        state.idea,
        state.reflectBrief?.confirmed,
        task.title,
        task.description,
      ),
      signal: this.ctx.signalFor(state.runId),
    });
    const observedPaths = this.ctx.config.git.enabled
      ? (await this.ctx.git.changedFiles()).filter((file) => !knownPaths!.has(file))
      : result.changedFiles;
    const testPatterns = this.ctx.config.workflow.testPathPatterns;
    const illegal = observedPaths.filter((file) => !isTestPath(file, testPatterns));
    if (illegal.length > 0) {
      throw new HarnessFailure(
        `Test writer changed non-test paths: ${illegal.join(", ")}`,
        "config",
        false,
      );
    }
    const evidence = await this.runTargetedTest(state.runId, task, "tdd:red");
    const attempts = { ...task.attempts, tests: task.attempts.tests + 1 };
    const meaningfulRed =
      evidence.exitCode !== 0 &&
      evidence.exitCode !== 124 &&
      !/no tests found|no test files found|command not found|not recognized/i.test(
        `${evidence.stdout}\n${evidence.stderr}`,
      );
    const exhausted = !meaningfulRed && attempts.tests >= this.ctx.config.workflow.maxTestAttempts;
    const updated: BuildTask = {
      ...task,
      attempts,
      testPaths: unique([
        ...task.testPaths,
        ...observedPaths.filter((file) => isTestPath(file, testPatterns)),
      ]),
      changedFiles: unique([...task.changedFiles, ...result.changedFiles]),
      evidence: [...task.evidence, evidence],
      step: meaningfulRed ? "red" : exhausted ? "failed" : "writing_tests",
      status: exhausted ? "failed" : "active",
      failure: exhausted ? "Test writer could not produce a meaningful RED run" : undefined,
    };
    return this.updateTask(
      await this.ctx.withTreeFingerprint(state),
      updated,
      meaningfulRed ? "task.red_observed" : "task.red_rejected",
    );
  }

  async implementTask(state: RunState, task: BuildTask): Promise<RunState> {
    if (task.tdd && task.attempts.implementation > 0) {
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
    const episode = task.implementerSession;
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
      providerSessionId: episode?.providerSessionId,
      previousGuidanceFingerprint: episode?.guidanceFingerprint,
      signal: this.ctx.signalFor(state.runId),
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
    const evidence = await this.runTargetedTest(state.runId, task, task.tdd ? "tdd:green" : "test");
    const attempts = {
      ...task.attempts,
      implementation: task.attempts.implementation + 1,
    };
    const observedPaths = this.ctx.config.git.enabled
      ? await this.ctx.git.changedFiles()
      : result.changedFiles;
    const touchedTests = observedPaths.filter((file) =>
      task.testPaths.some((testPath) => normalizePathKey(testPath) === normalizePathKey(file)),
    );
    if (touchedTests.length > 0) {
      const exhausted = attempts.implementation >= this.ctx.config.workflow.maxImplementationAttempts;
      const failure = `Implementer modified recorded test files: ${touchedTests.join(", ")}`;
      const updated: BuildTask = {
        ...task,
        attempts,
        changedFiles: unique([...task.changedFiles, ...result.changedFiles]),
        evidence: [
          ...task.evidence,
          evidence,
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
      return this.updateTask(await this.ctx.withTreeFingerprint(state), updated, "task.implementation_test_tamper", {
        passed: evidence.passed,
      });
    }
    const exhausted =
      !evidence.passed && attempts.implementation >= this.ctx.config.workflow.maxImplementationAttempts;
    const updated: BuildTask = {
      ...task,
      attempts,
      changedFiles: unique([...task.changedFiles, ...result.changedFiles]),
      evidence: [...task.evidence, evidence],
      step: evidence.passed ? "verifying" : exhausted ? "failed" : "implementing",
      status: exhausted ? "failed" : "active",
      failure: exhausted
        ? `Targeted test failed after ${attempts.implementation} implementation attempts`
        : undefined,
    };
    return this.updateTask(
      await this.ctx.withTreeFingerprint(state),
      updated,
      evidence.passed ? "task.green_observed" : "task.implementation_repair_needed",
    );
  }

  async verifyTask(state: RunState, task: BuildTask): Promise<RunState> {
    const evidence = [];
    for (const gate of this.ctx.config.commands.gates) {
      const result = await this.ctx.deps.commands.run(gate.command, {
        cwd: this.ctx.config.repositoryRoot,
        timeoutMs: gate.timeoutMs,
        signal: this.ctx.signalFor(state.runId),
        ...this.ctx.commandEnvironmentOptions(),
      });
      if (result.cancelled) {
        throw new RunCancelledError(`Gate ${gate.id} cancelled`);
      }
      evidence.push(commandEvidence(`gate:${gate.id}`, result));
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
    const pullRequestUrl = state.branchName
      ? await this.ctx.git.publish(state.branchName, message)
      : undefined;
    return this.ctx.store.record(
      { ...state, phase: "completed", pullRequestUrl },
      "run.completed",
      { pullRequestUrl },
    );
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
    const command = task.testCommand ?? this.ctx.config.commands.test;
    const gate = this.ctx.config.commands.gates.find((item) => item.command === command);
    const result = await this.ctx.deps.commands.run(command, {
      cwd: this.ctx.config.repositoryRoot,
      timeoutMs: gate?.timeoutMs ?? 10 * 60 * 1000,
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

      this.ctx.config.workflow.tdd = tdd;
      const parsed = HarnessConfigSchema.parse(this.ctx.config);
      this.ctx.config.workflow.tdd = parsed.workflow.tdd;
      const raw = (await this.ctx.store.readJson(state.runId, "config.json")) as Record<string, unknown>;
      const frozenVersion =
        typeof raw.configVersion === "number" ? raw.configVersion : state.configVersion;
      const frozenWorkflow =
        typeof raw.workflow === "object" && raw.workflow !== null && !Array.isArray(raw.workflow)
          ? (raw.workflow as Record<string, unknown>)
          : {};
      // Persist intentional mutation onto the frozen snapshot — do not dump live overlays.
      await this.ctx.store.writeJson(state.runId, "config.json", {
        ...raw,
        workflow: { ...frozenWorkflow, tdd: parsed.workflow.tdd },
        configVersion: frozenVersion,
      });
      const nextHash = configurationHash(this.ctx.config);
      const previous = state.tasks;
      const tasks = previous.map((task) => (canToggleTaskTdd(task) ? { ...task, tdd } : task));
      const tasksUpdated = tasks.filter((task, index) => task.tdd !== previous[index]?.tdd).length;
      state = await this.ctx.store.record(
        { ...state, tasks, configurationHash: nextHash },
        "run.tdd_updated",
        { tdd, tasksUpdated },
      );
      await this.ctx.syncArtifacts(state);
      return state;
    });
  }
}
