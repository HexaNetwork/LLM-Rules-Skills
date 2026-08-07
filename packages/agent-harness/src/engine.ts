import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { CONFIG_VERSION, type HarnessConfig } from "./config.js";
import {
  AgentCoordinator,
  type AgentBackend,
  type InvokeInput,
} from "./agent.js";
import { commandEvidence, recentEvidenceOutput, runCommand } from "./commands.js";
import {
  GRILL_EXPECTED_OUTPUT,
  GrillOutputSchema,
  MessageOutputSchema,
  REFLECT_EXPECTED_OUTPUT,
  ReflectOutputSchema,
  PlannerOutputSchema,
  ReviewOutputSchema,
  WorkerOutputSchema,
  createRunState,
  formatReflectRestatement,
  type BuildTask,
  type GrillEpisode,
  type GrillOutput,
  type GrillResolution,
  type HumanQuestionDraft,
  type MessageOutput,
  type QuestionPurpose,
  type RunPhase,
  type RunState,
} from "./domain.js";
import { GitService } from "./git.js";
import {
  GraphifyRepositoryLookup,
  prepareGraphifyForRun,
  runGraphify,
  type GraphifyRunner,
  type GraphifySetupRunner,
} from "./graphify.js";
import { LocalKnowledgeBase, compactDomainSeed } from "./knowledge.js";
import { RunStore } from "./store.js";
import { LocalTracker, assertAcyclic, taskFrontier, type TrackerPort } from "./tracker.js";

export type HarnessDependencies = {
  backend: AgentBackend;
  tracker?: TrackerPort;
  store?: RunStore;
  knowledge?: LocalKnowledgeBase;
  git?: GitService;
  graphifyRunner?: GraphifyRunner;
  graphifySetupRunner?: GraphifySetupRunner;
};

type StepResult = { state: RunState; consumedBudget: boolean };

export class HarnessEngine {
  readonly store: RunStore;
  readonly knowledge: LocalKnowledgeBase;
  readonly tracker: TrackerPort;
  readonly git: GitService;
  readonly agents: AgentCoordinator;
  private readonly graphifyRunner: GraphifyRunner;
  private readonly graphifySetupRunner?: GraphifySetupRunner;

  constructor(
    readonly config: HarnessConfig,
    dependencies: HarnessDependencies,
  ) {
    this.store = dependencies.store ?? new RunStore(config);
    this.graphifyRunner = dependencies.graphifyRunner ?? runGraphify;
    this.graphifySetupRunner = dependencies.graphifySetupRunner;
    this.knowledge =
      dependencies.knowledge ??
      new LocalKnowledgeBase(
        config,
        new GraphifyRepositoryLookup(config, this.graphifyRunner),
      );
    this.tracker = dependencies.tracker ?? new LocalTracker(this.store);
    this.git = dependencies.git ?? new GitService(config);
    this.agents = new AgentCoordinator(config, dependencies.backend, this.store, this.knowledge);
  }

  async start(
    idea: string,
    runId: string = randomUUID(),
    refreshKnowledge = true,
    prepareGraphify = true,
  ): Promise<RunState> {
    if (!idea.trim()) throw new Error("Idea cannot be empty");
    await this.store.initialize();
    let state = createRunState(
      runId,
      idea,
      new Date().toISOString(),
      configurationHash(this.config),
      CONFIG_VERSION,
    );
    await this.store.create(state);
    await this.store.writeJson(runId, "config.json", {
      ...this.config,
      configVersion: CONFIG_VERSION,
    });
    state = await this.store.record(state, "run.created", { idea: idea.trim() });
    try {
      if (prepareGraphify && this.config.knowledge.graphify.enabled) {
        if (this.graphifySetupRunner) {
          await prepareGraphifyForRun(
            this.config,
            this.graphifyRunner,
            this.graphifySetupRunner,
          );
        } else {
          await prepareGraphifyForRun(this.config, this.graphifyRunner);
        }
      }
      if (refreshKnowledge) await this.knowledge.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state = await this.store.record(
        { ...state, phase: "blocked", blockedFrom: "new", failure: message },
        "run.blocked",
        { blockedFrom: "new", error: message },
      );
      await this.syncArtifacts(state);
      return state;
    }
    await this.syncArtifacts(state);
    return state;
  }

  async advance(runId: string, maxSteps = this.config.workflow.maxStepsPerRun): Promise<RunState> {
    return this.store.withLock(runId, async () => {
      let state = await this.store.load(runId);
      try {
        state = await this.ensureCompatibleConfiguration(state);
        if (terminal(state.phase) || state.phase === "awaiting_input") return state;
        let remaining = maxSteps;
        let iterations = 0;
        const maxIterations = Math.max(maxSteps * 8, 40);
        while (remaining > 0 && iterations < maxIterations) {
          iterations += 1;
          const step = await this.advanceOne(state);
          state = step.state;
          await this.syncArtifacts(state);
          if (step.consumedBudget) remaining -= 1;
          if (terminal(state.phase) || state.phase === "awaiting_input") return state;
        }
        state = await this.store.record(state, "run.yielded", { maxSteps });
        return state;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        state = await this.store.load(runId).catch(() => state);
        const blockedFrom = state.phase;
        state = await this.store.record(
          { ...state, phase: "blocked", blockedFrom, failure: message },
          "run.blocked",
          { blockedFrom, error: message },
        );
        await this.syncArtifacts(state);
        return state;
      }
    });
  }

  private async ensureCompatibleConfiguration(state: RunState): Promise<RunState> {
    if (state.configVersion < CONFIG_VERSION) {
      return this.store.record(
        { ...state, configVersion: CONFIG_VERSION },
        "run.config_migrated",
        { from: state.configVersion, to: CONFIG_VERSION },
      );
    }
    if (state.configVersion > CONFIG_VERSION) {
      throw new Error(
        `Run configVersion ${state.configVersion} is newer than harness ${CONFIG_VERSION}`,
      );
    }
    if (configurationHash(this.config) !== state.configurationHash) {
      throw new Error("Run configuration changed; resume with the persisted run config");
    }
    return state;
  }

  async answer(runId: string, questionId: string, answer: string): Promise<RunState> {
    if (!answer.trim()) throw new Error("Answer cannot be empty");
    return this.store.withLock(runId, async () => {
      let state = await this.store.load(runId);
      const question = state.questions.find((item) => item.id === questionId);
      if (!question || question.status !== "open") throw new Error(`Question ${questionId} is not open`);
      const now = new Date().toISOString();
      const questions = state.questions.map((item) =>
        item.id === questionId
          ? { ...item, status: "answered" as const, answer: answer.trim(), answeredAt: now }
          : item,
      );

      if (question.purpose === "reflect") {
        state = await this.store.record(
          {
            ...state,
            questions,
            activeQuestionId: undefined,
            reflectBrief: {
              draft: state.reflectBrief?.draft ?? answer.trim(),
              confirmed: answer.trim(),
              confirmedAt: now,
            },
            phase: "grilling",
          },
          "reflect.confirmed",
          { questionId },
        );
        await this.syncArtifacts(state);
        return state;
      }

      const staleMs = this.config.workflow.staleAnswerMinutes * 60_000;
      const askedAt = Date.parse(question.askedAt);
      const stale = Number.isFinite(askedAt) && Date.parse(now) - askedAt > staleMs;

      state = await this.store.record(
        {
          ...state,
          questions,
          activeQuestionId: undefined,
          phase: "grilling",
        },
        "question.answered",
        { questionId, stale },
      );

      if (stale) {
        state = await this.closeGrillEpisode(state, "grill.episode_stale_reset");
      }

      await this.syncArtifacts(state);
      return state;
    });
  }

  async retry(runId: string): Promise<RunState> {
    return this.store.withLock(runId, async () => {
      let state = await this.store.load(runId);
      if (state.phase !== "blocked" || !state.blockedFrom) {
        throw new Error(`Run ${runId} is not resumably blocked`);
      }
      state = await this.store.record(
        { ...state, phase: state.blockedFrom, blockedFrom: undefined, failure: undefined },
        "run.retry_requested",
      );
      return state;
    });
  }

  async cancel(runId: string): Promise<RunState> {
    return this.store.withLock(runId, async () => {
      const state = await this.store.load(runId);
      if (terminal(state.phase)) return state;
      const cancelled = await this.closeGrillEpisode({ ...state, phase: "cancelled" });
      return this.store.record(cancelled, "run.cancelled");
    });
  }

  status(runId: string): Promise<RunState> {
    return this.store.load(runId);
  }

  private async advanceOne(state: RunState): Promise<StepResult> {
    switch (state.phase) {
      case "new":
      case "reflecting":
        return { state: await this.reflect(state), consumedBudget: true };
      case "grilling":
        return { state: await this.grill(state), consumedBudget: true };
      case "planning":
        return { state: await this.plan(state), consumedBudget: true };
      case "executing":
        return this.execute(state);
      case "publishing":
        return { state: await this.publish(state), consumedBudget: true };
      case "awaiting_input":
      case "completed":
      case "blocked":
      case "cancelled":
        return { state, consumedBudget: false };
    }
  }

  private async reflect(state: RunState): Promise<RunState> {
    if (state.phase !== "reflecting") {
      state = await this.store.record({ ...state, phase: "reflecting" }, "reflect.started");
    }
    const output = await this.agents.invoke({
      runId: state.runId,
      role: "reflector",
      objective: "Restate the feature idea so the operator can confirm shared understanding",
      input: { idea: state.idea },
      expectedOutput: REFLECT_EXPECTED_OUTPUT,
      schema: ReflectOutputSchema,
      knowledgeQuery: state.idea,
      knowledgeFallbackQuery: compactDomainSeed(state.idea),
      buildPrompt: false,
    });
    const draft = formatReflectRestatement(output);
    state = await this.store.record(
      {
        ...state,
        reflectBrief: { draft },
      },
      "reflect.drafted",
      { summary: output.summary },
    );
    return this.askQuestion(state, {
      purpose: "reflect",
      prompt: "Edit and confirm this restatement of the feature before grilling begins.",
      context:
        "Adjust anything that is wrong or incomplete. Confirming sends this exact text into the grill-me session.",
      draftAnswer: draft,
      options: [],
    });
  }

  private async grill(state: RunState): Promise<RunState> {
    const brief = state.reflectBrief?.confirmed;
    if (!brief) throw new Error("Cannot grill without a confirmed reflect brief");

    const pendingAnswer = [...state.questions]
      .reverse()
      .find(
        (question) =>
          question.purpose === "grill" &&
          question.status === "answered" &&
          !state.grillResolutions.some((item) => item.id === question.id),
      );
    const openGrill = state.questions.find(
      (question) => question.purpose === "grill" && question.status === "open",
    );
    if (openGrill) {
      return this.store.record(
        { ...state, activeQuestionId: openGrill.id, phase: "awaiting_input" },
        "question.reopened",
        { questionId: openGrill.id },
      );
    }

    const episodeLimit = this.config.workflow.maxGrillQuestionsPerEpisode;
    const episode = state.grillEpisode;
    if (episode && !episode.closedAt && episode.questionsAnswered >= episodeLimit) {
      state = await this.closeGrillEpisode(state, "grill.episode_rolled");
    }

    const coldStart = !state.grillEpisode || Boolean(state.grillEpisode.closedAt);
    const staleAnswer =
      Boolean(pendingAnswer?.answeredAt) &&
      Boolean(pendingAnswer?.askedAt) &&
      Date.parse(pendingAnswer!.answeredAt!) - Date.parse(pendingAnswer!.askedAt) >
        this.config.workflow.staleAnswerMinutes * 60_000;

    const questionPayload = pendingAnswer
      ? {
          question: {
            prompt: pendingAnswer.prompt,
            context: pendingAnswer.context,
            options: pendingAnswer.options,
            recommendation: pendingAnswer.recommendation,
          },
          answer: pendingAnswer.answer,
        }
      : {};

    const input =
      coldStart || staleAnswer
        ? {
            mode: staleAnswer && pendingAnswer ? "stale_answer" : "fresh_episode",
            confirmedBrief: brief,
            resolutions: state.grillResolutions,
            ...questionPayload,
          }
        : {
            mode: "continue",
            confirmedBrief: brief,
            resolutions: state.grillResolutions,
            ...questionPayload,
          };

    const invocation = await this.invokeGrill(state, {
      runId: state.runId,
      role: "griller",
      objective: pendingAnswer
        ? "Incorporate the human answer and either ask the next grill question or declare ready to plan"
        : "Begin grilling from the confirmed feature brief; ask the first decision-ready question",
      input,
      expectedOutput: GRILL_EXPECTED_OUTPUT,
      schema: GrillOutputSchema,
      knowledgeQuery: [brief, pendingAnswer?.prompt, pendingAnswer?.answer]
        .filter(Boolean)
        .join(" "),
      knowledgeFallbackQuery: compactDomainSeed(state.idea, brief),
      forceFresh: Boolean(coldStart || staleAnswer),
    });
    state = invocation.state;
    const output = invocation.output;

    if (pendingAnswer) {
      const resolution: GrillResolution = {
        id: pendingAnswer.id,
        question: pendingAnswer.prompt,
        answer: pendingAnswer.answer ?? "",
        summary: output.summary,
        resolvedAt: new Date().toISOString(),
      };
      const questionsAnswered = (state.grillEpisode?.questionsAnswered ?? 0) + 1;
      state = await this.store.record(
        {
          ...state,
          grillResolutions: mergeResolutions(state.grillResolutions, resolution),
          grillEpisode: state.grillEpisode
            ? {
                ...state.grillEpisode,
                questionsAnswered,
                updatedAt: new Date().toISOString(),
              }
            : state.grillEpisode,
        },
        "grill.answer_incorporated",
        { questionId: pendingAnswer.id, questionsAnswered },
      );
    }

    if (output.status === "ready_to_plan") {
      const now = new Date().toISOString();
      const fromOutput = output.resolutions.map((item) => ({
        ...item,
        resolvedAt: now,
      }));
      const closed = await this.closeGrillEpisode({
        ...state,
        grillResolutions: mergeResolutionLists(state.grillResolutions, fromOutput),
        phase: "planning",
      });
      return this.store.record(closed, "grill.completed", {
        resolutions: closed.grillResolutions.length,
      });
    }

    if (
      state.grillEpisode &&
      !state.grillEpisode.closedAt &&
      state.grillEpisode.questionsAnswered >= episodeLimit
    ) {
      state = await this.closeGrillEpisode(state, "grill.episode_rolled");
    }

    return this.askQuestion(state, {
      purpose: "grill",
      ...output.question,
    });
  }

  private async invokeGrill(
    state: RunState,
    input: InvokeInput<GrillOutput> & { forceFresh?: boolean },
  ): Promise<{ state: RunState; output: GrillOutput }> {
    let episode = state.grillEpisode;
    const now = new Date().toISOString();
    if (input.forceFresh || !episode || episode.closedAt) {
      if (episode && !episode.closedAt) {
        await this.agents.releaseProviderSession(episode.providerSessionId).catch(() => undefined);
      }
      const nextNumber = (episode?.number ?? 0) + 1;
      state = await this.store.record(
        {
          ...state,
          grillEpisode: {
            number: nextNumber,
            questionsAnswered: 0,
            startedAt: now,
            updatedAt: now,
          },
        },
        "grill.episode_started",
        { episode: nextNumber, forceFresh: Boolean(input.forceFresh) },
      );
      episode = state.grillEpisode;
    }

    const invocation = await this.agents.invokeInEpisode({
      ...input,
      buildPrompt: false,
      providerSessionId: episode?.providerSessionId,
      previousGuidanceFingerprint: episode?.guidanceFingerprint,
    });
    const updatedAt = new Date().toISOString();
    return {
      state: {
        ...state,
        grillEpisode: {
          number: episode?.number ?? 1,
          providerSessionId: invocation.providerSessionId,
          questionsAnswered: episode?.questionsAnswered ?? 0,
          guidanceFingerprint: invocation.guidanceFingerprint ?? episode?.guidanceFingerprint,
          startedAt: episode?.startedAt ?? updatedAt,
          updatedAt,
        },
      },
      output: invocation.value,
    };
  }

  private async closeGrillEpisode(
    state: RunState,
    event = "grill.episode_closed",
  ): Promise<RunState> {
    const episode = state.grillEpisode;
    if (!episode || episode.closedAt) return state;
    await this.agents.releaseProviderSession(episode.providerSessionId).catch(() => undefined);
    const now = new Date().toISOString();
    const closed: GrillEpisode = {
      ...episode,
      updatedAt: now,
      closedAt: now,
    };
    return this.store.record({ ...state, grillEpisode: closed }, event, {
      episode: episode.number,
      questionsAnswered: episode.questionsAnswered,
    });
  }

  private async askQuestion(
    state: RunState,
    details: {
      purpose: QuestionPurpose;
      prompt: string;
      context?: string;
      options?: HumanQuestionDraft["options"];
      recommendedOptionId?: string;
      recommendation?: string;
      draftAnswer?: string;
    },
  ): Promise<RunState> {
    const now = new Date().toISOString();
    const questionId = `q-${randomUUID()}`;
    return this.store.record(
      {
        ...state,
        questions: [
          ...state.questions,
          {
            id: questionId,
            purpose: details.purpose,
            prompt: details.prompt,
            context: details.context ?? "",
            options: details.options ?? [],
            recommendedOptionId: details.recommendedOptionId,
            recommendation: details.recommendation,
            draftAnswer: details.draftAnswer,
            status: "open",
            askedAt: now,
          },
        ],
        activeQuestionId: questionId,
        phase: "awaiting_input",
      },
      "question.asked",
      { questionId, purpose: details.purpose, prompt: details.prompt },
    );
  }

  private async plan(state: RunState): Promise<RunState> {
    const output = await this.agents.invoke({
      runId: state.runId,
      role: "planner",
      objective:
        "Turn the confirmed brief and grill resolutions into dependency-ordered tracer-bullet implementation tickets",
      input: {
        idea: state.idea,
        confirmedBrief: state.reflectBrief?.confirmed,
        resolutions: state.grillResolutions,
        defaultTdd: this.config.workflow.tdd,
        defaultTestCommand: this.config.commands.test,
      },
      expectedOutput:
        "{summary,tasks:[{id,title,description,acceptanceCriteria,affectedPaths?,blockedBy,tdd?,testCommand?}]}",
      schema: PlannerOutputSchema,
      knowledgeQuery: [
        state.reflectBrief?.confirmed ?? state.idea,
        compactDomainSeed(
          state.idea,
          state.reflectBrief?.confirmed,
          ...state.grillResolutions.flatMap((item) => [item.question, item.answer, item.summary]),
        ),
      ]
        .filter(Boolean)
        .join(" "),
      knowledgeFallbackQuery: compactDomainSeed(state.idea, state.reflectBrief?.confirmed),
    });
    const tasks = materializeTasks(output, this.config);
    assertAcyclic(tasks);
    const branchName = await this.git.ensureRunBranch(state.runId);
    return this.store.record(
      { ...state, tasks, branchName, phase: "executing" },
      "plan.created",
      { tasks: tasks.length, tdd: tasks.filter((task) => task.tdd).length },
    );
  }

  private async execute(state: RunState): Promise<StepResult> {
    const failed = state.tasks.find((task) => task.status === "failed");
    if (failed) throw new Error(`Task ${failed.id} failed: ${failed.failure ?? "unknown failure"}`);
    const active = state.tasks.find((task) => task.status === "active");
    const task = active ?? taskFrontier(state.tasks)[0];
    if (!task) {
      if (state.tasks.every((item) => item.status === "done")) {
        return {
          state: await this.store.record({ ...state, phase: "publishing" }, "implementation.completed"),
          consumedBudget: false,
        };
      }
      throw new Error("Build frontier is empty while pending tasks remain");
    }
    return this.executeTaskStep(state, task);
  }

  private async executeTaskStep(state: RunState, task: BuildTask): Promise<StepResult> {
    switch (task.step) {
      case "pending": {
        const next = {
          ...task,
          status: "active" as const,
          step: task.tdd ? ("writing_tests" as const) : ("implementing" as const),
        };
        return {
          state: await this.updateTask(state, next, "task.started"),
          consumedBudget: false,
        };
      }
      case "writing_tests":
        return { state: await this.writeTests(state, task), consumedBudget: true };
      case "red":
        return {
          state: await this.updateTask(
            state,
            { ...task, step: "implementing" },
            "task.red_confirmed",
          ),
          consumedBudget: false,
        };
      case "implementing":
        return { state: await this.implementTask(state, task), consumedBudget: true };
      case "verifying":
        return { state: await this.verifyTask(state, task), consumedBudget: true };
      case "reviewing":
        return { state: await this.reviewTask(state, task), consumedBudget: true };
      case "committing":
        return { state: await this.commitTask(state, task), consumedBudget: true };
      case "done":
      case "failed":
        return { state, consumedBudget: false };
    }
  }

  private async writeTests(state: RunState, task: BuildTask): Promise<RunState> {
    const result = await this.agents.invoke({
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
    });
    const observedPaths = this.config.git.enabled ? await this.git.changedFiles() : result.changedFiles;
    const illegal = observedPaths.filter((file) => !isTestPath(file));
    if (illegal.length > 0) {
      throw new Error(`Test writer changed non-test paths: ${illegal.join(", ")}`);
    }
    const evidence = await this.runTargetedTest(task, "tdd:red");
    const attempts = { ...task.attempts, tests: task.attempts.tests + 1 };
    const meaningfulRed =
      evidence.exitCode !== 0 &&
      evidence.exitCode !== 124 &&
      !/no tests found|no test files found|command not found|not recognized/i.test(
        `${evidence.stdout}\n${evidence.stderr}`,
      );
    const exhausted = !meaningfulRed && attempts.tests >= this.config.workflow.maxTestAttempts;
    const updated: BuildTask = {
      ...task,
      attempts,
      testPaths: unique([...task.testPaths, ...observedPaths.filter(isTestPath)]),
      changedFiles: unique([...task.changedFiles, ...result.changedFiles]),
      evidence: [...task.evidence, evidence],
      step: meaningfulRed ? "red" : exhausted ? "failed" : "writing_tests",
      status: exhausted ? "failed" : "active",
      failure: exhausted ? "Test writer could not produce a meaningful RED run" : undefined,
    };
    return this.updateTask(state, updated, meaningfulRed ? "task.red_observed" : "task.red_rejected");
  }

  private async implementTask(state: RunState, task: BuildTask): Promise<RunState> {
    if (task.tdd && task.attempts.implementation > 0) {
      const recovery = await this.runTargetedTest(task, "tdd:resume-check");
      if (recovery.passed) {
        return this.updateTask(
          state,
          { ...task, evidence: [...task.evidence, recovery], step: "verifying" },
          "task.recovered_green",
        );
      }
      task = { ...task, evidence: [...task.evidence, recovery] };
      state = await this.updateTask(state, task, "task.resume_check_failed");
    }
    const result = await this.agents.invoke({
      runId: state.runId,
      role: "implementer",
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
    });
    const evidence = await this.runTargetedTest(task, task.tdd ? "tdd:green" : "test");
    const attempts = {
      ...task.attempts,
      implementation: task.attempts.implementation + 1,
    };
    const observedPaths = this.config.git.enabled
      ? await this.git.changedFiles()
      : result.changedFiles;
    const touchedTests = observedPaths.filter((file) =>
      task.testPaths.some((testPath) => normalizePathKey(testPath) === normalizePathKey(file)),
    );
    if (evidence.passed && touchedTests.length > 0) {
      const exhausted = attempts.implementation >= this.config.workflow.maxImplementationAttempts;
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
      return this.updateTask(state, updated, "task.implementation_test_tamper");
    }
    const exhausted =
      !evidence.passed && attempts.implementation >= this.config.workflow.maxImplementationAttempts;
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
      state,
      updated,
      evidence.passed ? "task.green_observed" : "task.implementation_repair_needed",
    );
  }

  private async verifyTask(state: RunState, task: BuildTask): Promise<RunState> {
    const evidence = [];
    for (const gate of this.config.commands.gates) {
      const result = await runCommand(gate.command, {
        cwd: this.config.repositoryRoot,
        timeoutMs: gate.timeoutMs,
      });
      evidence.push(commandEvidence(`gate:${gate.id}`, result));
    }
    const passed = evidence.every((item) => item.passed);
    const canRepair = task.attempts.implementation < this.config.workflow.maxImplementationAttempts;
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
    return this.updateTask(state, updated, passed ? "task.gates_passed" : "task.gates_failed");
  }

  private async reviewTask(state: RunState, task: BuildTask): Promise<RunState> {
    const changedFiles = this.config.git.enabled ? await this.git.changedFiles() : task.changedFiles;
    const review = await this.agents.invoke({
      runId: state.runId,
      role: "reviewer",
      objective: `Independently review “${task.title}” against its acceptance criteria`,
      input: {
        task: taskForPacket(task),
        changedFiles,
        commandEvidence: recentEvidenceOutput(task.evidence),
      },
      expectedOutput: "{approved,summary,findings:[{severity,message}]}",
      schema: ReviewOutputSchema,
      knowledgeQuery: [task.title, task.description, ...task.acceptanceCriteria].join(" "),
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
      attempts.review < this.config.workflow.maxReviewAttempts &&
      task.attempts.implementation < this.config.workflow.maxImplementationAttempts;
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
    return this.updateTask(state, updated, approved ? "task.review_passed" : "task.review_failed");
  }

  private async commitTask(state: RunState, task: BuildTask): Promise<RunState> {
    const fallback: MessageOutput = {
      subject: `feat: ${task.title}`.slice(0, 100),
      body: task.description,
    };
    const message = this.config.workflow.generateCommitMessages
      ? await this.message(
          state.runId,
          `Write the commit message for completed task “${task.title}”`,
          { task: taskForPacket(task), changedFiles: task.changedFiles, review: task.reviewSummary },
          fallback,
        )
      : MessageOutputSchema.parse(fallback);
    const commitSha = await this.git.commitTask(task.id, message, task.changedFiles);
    const graphifyUpdated = includesSourcePath(task.changedFiles)
      ? await this.knowledge.rebuildRepositoryGraph()
      : false;
    return this.updateTask(
      state,
      { ...task, status: "done", step: "done", commitSha },
      "task.committed",
      { commitSha, graphifyUpdated },
    );
  }

  private async publish(state: RunState): Promise<RunState> {
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
      ? await this.git.publish(state.branchName, message)
      : undefined;
    return this.store.record(
      { ...state, phase: "completed", pullRequestUrl },
      "run.completed",
      { pullRequestUrl },
    );
  }

  private async message(
    runId: string,
    objective: string,
    input: unknown,
    fallback: MessageOutput,
  ): Promise<MessageOutput> {
    try {
      return await this.agents.invoke({
        runId,
        role: "message-writer",
        objective,
        input,
        expectedOutput: "{subject,body}",
        schema: MessageOutputSchema,
        buildPrompt: false,
        retrieval: false,
      });
    } catch {
      return MessageOutputSchema.parse(fallback);
    }
  }

  private async runTargetedTest(task: BuildTask, purpose: string) {
    const command = task.testCommand ?? this.config.commands.test;
    const gate = this.config.commands.gates.find((item) => item.command === command);
    const result = await runCommand(command, {
      cwd: this.config.repositoryRoot,
      timeoutMs: gate?.timeoutMs ?? 10 * 60 * 1000,
    });
    return commandEvidence(purpose, result);
  }

  private async updateTask(
    state: RunState,
    task: BuildTask,
    event: string,
    detail: Record<string, unknown> = {},
  ): Promise<RunState> {
    return this.store.record(
      { ...state, tasks: state.tasks.map((item) => (item.id === task.id ? task : item)) },
      event,
      { taskId: task.id, step: task.step, ...detail },
    );
  }

  private async syncArtifacts(state: RunState): Promise<void> {
    await this.tracker.sync(state);
  }
}

function materializeTasks(
  output: {
    tasks: Array<{
      id: string;
      title: string;
      description: string;
      acceptanceCriteria: string[];
      affectedPaths?: string[];
      blockedBy: string[];
      tdd?: boolean;
      testCommand?: string;
    }>;
  },
  config: HarnessConfig,
): BuildTask[] {
  const idMap = new Map<string, string>();
  const used = new Set<string>();
  for (const [index, task] of output.tasks.entries()) {
    let id = safeId(task.id, `task-${index + 1}`);
    let suffix = 2;
    while (used.has(id)) {
      id = `${safeId(task.id, `task-${index + 1}`)}-${suffix}`;
      suffix += 1;
    }
    used.add(id);
    idMap.set(task.id, id);
  }
  return output.tasks.map((task) => ({
    id: idMap.get(task.id)!,
    title: task.title,
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
    affectedPaths: task.affectedPaths ?? [],
    blockedBy: task.blockedBy.map((id) => idMap.get(id) ?? id),
    tdd: task.tdd ?? config.workflow.tdd,
    testCommand: task.testCommand ?? config.commands.test,
    status: "pending" as const,
    step: "pending" as const,
    attempts: { tests: 0, implementation: 0, review: 0 },
    evidence: [],
    testPaths: [],
    changedFiles: [],
  }));
}

function mergeResolutions(
  existing: GrillResolution[],
  next: GrillResolution,
): GrillResolution[] {
  return [...existing.filter((item) => item.id !== next.id), next];
}

function mergeResolutionLists(
  existing: GrillResolution[],
  additions: GrillResolution[],
): GrillResolution[] {
  let result = existing;
  for (const item of additions) result = mergeResolutions(result, item);
  return result;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function safeId(value: string, fallback: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || fallback;
}

function terminal(phase: RunPhase): boolean {
  return phase === "completed" || phase === "blocked" || phase === "cancelled";
}

function configurationHash(config: unknown): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

const PACKET_DESCRIPTION_LIMIT = 2_000;
const PACKET_CRITERION_LIMIT = 500;

/** Drop durable evidence and bound long prose before a task enters a packet. */
export function taskForPacket(task: BuildTask): Omit<BuildTask, "evidence"> {
  const { evidence: _evidence, ...rest } = task;
  return {
    ...rest,
    description: rest.description.slice(0, PACKET_DESCRIPTION_LIMIT),
    acceptanceCriteria: rest.acceptanceCriteria.map((item) =>
      item.slice(0, PACKET_CRITERION_LIMIT),
    ),
  };
}

function isTestPath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  return (
    normalized.startsWith("tests/") ||
    normalized.startsWith("test/") ||
    normalized.includes("/__tests__/") ||
    /\.(test|spec)\.[^/]+$/.test(normalized)
  );
}

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".kts",
  ".cs",
  ".cpp",
  ".c",
  ".h",
  ".hpp",
  ".rb",
  ".php",
  ".swift",
]);

function includesSourcePath(paths: string[]): boolean {
  return paths.some((filePath) => SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
}

function normalizePathKey(filePath: string): string {
  return filePath.replaceAll("\\", "/").toLowerCase();
}
