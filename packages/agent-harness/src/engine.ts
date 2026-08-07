import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { z } from "zod";
import type { HarnessConfig } from "./config.js";
import {
  AgentCoordinator,
  type AgentBackend,
  type InvokeInput,
} from "./agent.js";
import { commandEvidence, evidenceOutput, runCommand } from "./commands.js";
import {
  DECISION_EXPECTED_OUTPUT,
  DecisionOutputSchema,
  MessageOutputSchema,
  NAVIGATOR_EXPECTED_OUTPUT,
  NavigatorOutputSchema,
  PlannerOutputSchema,
  ReviewOutputSchema,
  WorkerOutputSchema,
  createRunState,
  type AgentRole,
  type BuildTask,
  type DecisionOutput,
  type DecisionTicket,
  type HumanQuestionDraft,
  type MessageOutput,
  type NavigatorOutput,
  type RunPhase,
  type RunState,
} from "./domain.js";
import { GitService } from "./git.js";
import { LocalKnowledgeBase } from "./knowledge.js";
import { RunStore } from "./store.js";
import { LocalTracker, assertAcyclic, decisionFrontier, taskFrontier, type TrackerPort } from "./tracker.js";

export type HarnessDependencies = {
  backend: AgentBackend;
  tracker?: TrackerPort;
  store?: RunStore;
  knowledge?: LocalKnowledgeBase;
  git?: GitService;
};

export class HarnessEngine {
  readonly store: RunStore;
  readonly knowledge: LocalKnowledgeBase;
  readonly tracker: TrackerPort;
  readonly git: GitService;
  readonly agents: AgentCoordinator;

  constructor(
    readonly config: HarnessConfig,
    dependencies: HarnessDependencies,
  ) {
    this.store = dependencies.store ?? new RunStore(config);
    this.knowledge = dependencies.knowledge ?? new LocalKnowledgeBase(config);
    this.tracker = dependencies.tracker ?? new LocalTracker(this.store);
    this.git = dependencies.git ?? new GitService(config);
    this.agents = new AgentCoordinator(config, dependencies.backend, this.store, this.knowledge);
  }

  async start(
    idea: string,
    runId: string = randomUUID(),
    refreshKnowledge = true,
  ): Promise<RunState> {
    if (!idea.trim()) throw new Error("Idea cannot be empty");
    await this.store.initialize();
    if (refreshKnowledge) await this.knowledge.refresh();
    let state = createRunState(
      runId,
      idea,
      new Date().toISOString(),
      configurationHash(this.config),
    );
    await this.store.create(state);
    await this.store.writeJson(runId, "config.json", this.config);
    state = await this.store.record(state, "run.created", { idea: idea.trim() });
    await this.syncArtifacts(state);
    return state;
  }

  async advance(runId: string, maxSteps = this.config.workflow.maxStepsPerRun): Promise<RunState> {
    return this.store.withLock(runId, async () => {
      let state = await this.store.load(runId);
      if (terminal(state.phase) || state.phase === "awaiting_input") return state;
      try {
        if (!configurationHashes(this.config).has(state.configurationHash)) {
          throw new Error("Run configuration changed; resume with the persisted run config");
        }
        for (let step = 0; step < maxSteps; step += 1) {
          state = await this.advanceOne(state);
          await this.syncArtifacts(state);
          if (terminal(state.phase) || state.phase === "awaiting_input") return state;
        }
        state = await this.store.record(state, "run.yielded", { maxSteps });
        return state;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A transition may have checkpointed immediately before an external
        // call failed. Reload so retry resumes from durable truth, not the
        // caller's older in-memory snapshot.
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
      const decisionTickets = state.decisionTickets.map((ticket) =>
        ticket.id === question.ticketId
          ? {
              ...ticket,
              conversation: [
                ...ticket.conversation,
                { speaker: "human" as const, text: answer.trim(), at: now },
              ],
              updatedAt: now,
            }
          : ticket,
      );
      state = await this.store.record(
        {
          ...state,
          questions,
          decisionTickets,
          activeQuestionId: undefined,
          phase: "wayfinding",
        },
        "question.answered",
        { questionId, ticketId: question.ticketId },
      );
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
      const cancelled = await this.closeWayfindingEpisode({ ...state, phase: "cancelled" });
      return this.store.record(cancelled, "run.cancelled");
    });
  }

  status(runId: string): Promise<RunState> {
    return this.store.load(runId);
  }

  private async advanceOne(state: RunState): Promise<RunState> {
    switch (state.phase) {
      case "new":
      case "navigating":
        return this.navigate(state, false);
      case "wayfinding":
        return this.wayfind(state);
      case "planning":
        return this.plan(state);
      case "executing":
        return this.execute(state);
      case "publishing":
        return this.publish(state);
      case "awaiting_input":
      case "completed":
      case "blocked":
      case "cancelled":
        return state;
    }
  }

  private async navigate(state: RunState, expanding: boolean): Promise<RunState> {
    if (!expanding && state.phase !== "navigating") {
      state = await this.store.record({ ...state, phase: "navigating" }, "navigation.started");
    }
    const invocation = await this.invokeWayfinding(state, {
      runId: state.runId,
      role: "navigator",
      objective: expanding
        ? "Advance the existing decision map by graduating only newly precise fog into tickets"
        : "Name the destination and chart the first decision frontier for this idea",
      input: expanding ? { idea: state.idea, map: state.map, tickets: state.decisionTickets } : { idea: state.idea },
      expectedOutput: NAVIGATOR_EXPECTED_OUTPUT,
      schema: NavigatorOutputSchema,
      knowledgeQuery: `${state.idea} ${state.map?.notYetSpecified.join(" ") ?? ""}`,
    });
    state = invocation.state;
    const output = invocation.output;
    const { tickets: nextTickets, deferredCount } = materializeProposedTickets(
      output.tickets,
      expanding ? state.decisionTickets : [],
      new Date().toISOString(),
      this.config.workflow.maxOpenDecisionTickets,
    );
    assertAcyclic(nextTickets);
    const capNote =
      deferredCount > 0
        ? `${deferredCount} proposed decision(s) deferred until open decisions resolve (cap ${this.config.workflow.maxOpenDecisionTickets}).`
        : undefined;
    const map = expanding
      ? {
          ...state.map!,
          notes: unique([
            ...state.map!.notes,
            ...output.notes,
            ...(capNote ? [capNote] : []),
          ]),
          notYetSpecified: unique(output.fog),
          outOfScope: unique([...state.map!.outOfScope, ...output.outOfScope]),
          readyToPlan: output.readyToPlan,
        }
      : {
          destination: output.destination,
          notes: capNote ? [...output.notes, capNote] : output.notes,
          decisionsSoFar: [],
          notYetSpecified: output.fog,
          outOfScope: output.outOfScope,
          readyToPlan: output.readyToPlan,
        };
    const routeClear = output.readyToPlan && nextTickets.every(decisionClosed) && map.notYetSpecified.length === 0;
    let nextState: RunState = {
      ...state,
      map,
      decisionTickets: nextTickets,
      navigationPasses: state.navigationPasses + 1,
      phase: routeClear ? "planning" : "wayfinding",
    };
    if (routeClear) nextState = await this.closeWayfindingEpisode(nextState);
    return this.store.record(
      nextState,
      expanding ? "navigation.expanded" : "navigation.charted",
      { tickets: nextTickets.length, fog: map.notYetSpecified.length, routeClear },
    );
  }

  private async wayfind(state: RunState): Promise<RunState> {
    const resumed = state.decisionTickets.find(
      (ticket) => ticket.status === "claimed" && ticket.claimedBy === state.runId,
    );
    const ticket = resumed ?? decisionFrontier(state.decisionTickets)[0];
    if (!ticket) {
      const open = state.decisionTickets.filter((item) => !decisionClosed(item));
      if (open.length > 0) throw new Error("Decision frontier is empty while unresolved tickets remain");
      if ((state.map?.notYetSpecified.length ?? 0) > 0) {
        if (state.navigationPasses >= this.config.workflow.maxFogPasses) {
          throw new Error("Fog did not converge within the configured navigation pass budget");
        }
        return this.navigate(state, true);
      }
      const nextState = await this.closeWayfindingEpisode({
        ...state,
        phase: "planning",
        map: { ...state.map!, readyToPlan: true },
      });
      return this.store.record(
        nextState,
        "wayfinding.completed",
      );
    }

    let claimed = ticket;
    if (ticket.status === "open") {
      claimed = { ...ticket, status: "claimed", claimedBy: state.runId, updatedAt: new Date().toISOString() };
      state = await this.store.record(
        { ...state, decisionTickets: replaceTicket(state.decisionTickets, claimed) },
        "decision.claimed",
        { ticketId: ticket.id, title: ticket.title },
      );
    }

    const hasHumanAnswer = claimed.conversation.some((turn) => turn.speaker === "human");
    if (claimed.interaction === "HITL" && !hasHumanAnswer) {
      return this.askQuestion(state, claimed, claimed.humanQuestion ?? claimed.question);
    }

    const role = decisionRole(claimed);
    const invocation = await this.invokeWayfinding(state, {
      runId: state.runId,
      role,
      objective: `Resolve the decision named “${claimed.title}”`,
      input: { destination: state.map?.destination, ticket: claimed },
      expectedOutput: DECISION_EXPECTED_OUTPUT,
      schema: DecisionOutputSchema,
      priorArtifacts: [`issues/${claimed.id}`],
      knowledgeQuery: `${claimed.title} ${claimed.question}`,
    });
    state = invocation.state;
    const output = invocation.output;
    if (output.status === "needs_input") return this.askQuestion(state, claimed, output.question);
    return this.resolveDecision(state, claimed, output);
  }

  private async invokeWayfinding<T>(
    state: RunState,
    input: InvokeInput<T>,
  ): Promise<{ state: RunState; output: T }> {
    let episode = state.wayfindingEpisode;
    const limit = this.config.workflow.maxWayfindingTurnsPerEpisode;
    if (episode && !episode.closedAt && episode.turnCount >= limit) {
      await this.agents.releaseProviderSession(episode.providerSessionId).catch(() => undefined);
      const now = new Date().toISOString();
      const nextNumber = episode.number + 1;
      state = await this.store.record(
        {
          ...state,
          wayfindingEpisode: {
            number: nextNumber,
            turnCount: 0,
            startedAt: now,
            updatedAt: now,
          },
        },
        "wayfinding.episode_rolled",
        {
          previousEpisode: episode.number,
          previousTurns: episode.turnCount,
          nextEpisode: nextNumber,
        },
      );
      episode = state.wayfindingEpisode;
    } else if (!episode || episode.closedAt) {
      const now = new Date().toISOString();
      const nextNumber = (episode?.number ?? 0) + 1;
      state = await this.store.record(
        {
          ...state,
          wayfindingEpisode: {
            number: nextNumber,
            turnCount: 0,
            startedAt: now,
            updatedAt: now,
          },
        },
        "wayfinding.episode_started",
        { episode: nextNumber },
      );
      episode = state.wayfindingEpisode;
    }

    const invocation = await this.agents.invokeInEpisode({
      ...input,
      buildPrompt: false,
      providerSessionId: episode?.providerSessionId,
    });
    const now = new Date().toISOString();
    return {
      state: {
        ...state,
        wayfindingEpisode: {
          number: episode?.number ?? 1,
          providerSessionId: invocation.providerSessionId,
          turnCount: (episode?.turnCount ?? 0) + invocation.providerTurns,
          startedAt: episode?.startedAt ?? now,
          updatedAt: now,
        },
      },
      output: invocation.value,
    };
  }

  private async closeWayfindingEpisode(state: RunState): Promise<RunState> {
    const episode = state.wayfindingEpisode;
    if (!episode || episode.closedAt) return state;
    await this.agents.releaseProviderSession(episode.providerSessionId).catch(() => undefined);
    const now = new Date().toISOString();
    return {
      ...state,
      wayfindingEpisode: {
        ...episode,
        updatedAt: now,
        closedAt: now,
      },
    };
  }

  private async askQuestion(
    state: RunState,
    ticket: DecisionTicket,
    question: HumanQuestionDraft | string,
  ): Promise<RunState> {
    const now = new Date().toISOString();
    const questionId = `q-${randomUUID()}`;
    const details =
      typeof question === "string"
        ? { prompt: question, context: "", options: [] }
        : question;
    const updatedTicket = {
      ...ticket,
      status: "claimed" as const,
      claimedBy: state.runId,
      humanQuestion: typeof question === "string" ? ticket.humanQuestion : question,
      conversation: [
        ...ticket.conversation,
        { speaker: "agent" as const, text: details.prompt, at: now },
      ],
      updatedAt: now,
    };
    return this.store.record(
      {
        ...state,
        decisionTickets: replaceTicket(state.decisionTickets, updatedTicket),
        questions: [
          ...state.questions,
          {
            id: questionId,
            ticketId: ticket.id,
            ...details,
            status: "open",
            askedAt: now,
          },
        ],
        activeQuestionId: questionId,
        phase: "awaiting_input",
      },
      "question.asked",
      { questionId, ticketId: ticket.id, ...details },
    );
  }

  private async resolveDecision(
    state: RunState,
    ticket: DecisionTicket,
    output: Extract<DecisionOutput, { status: "resolved" }>,
  ): Promise<RunState> {
    const now = new Date().toISOString();
    const resolved: DecisionTicket = {
      ...ticket,
      status: "resolved",
      resolution: output.resolution,
      resolutionSummary: output.summary,
      updatedAt: now,
    };
    let tickets = replaceTicket(state.decisionTickets, resolved);
    const materialized = materializeProposedTickets(
      output.newTickets,
      tickets,
      now,
      this.config.workflow.maxOpenDecisionTickets,
    );
    tickets = materialized.tickets;
    assertAcyclic(tickets);
    const capNote =
      materialized.deferredCount > 0
        ? `${materialized.deferredCount} proposed decision(s) deferred until open decisions resolve (cap ${this.config.workflow.maxOpenDecisionTickets}).`
        : undefined;
    const cleared = new Set(output.clearFog.map(normalizeFog));
    const map = {
      ...state.map!,
      notes: capNote ? unique([...state.map!.notes, capNote]) : state.map!.notes,
      decisionsSoFar: [
        ...state.map!.decisionsSoFar.filter((item) => item.ticketId !== ticket.id),
        { ticketId: ticket.id, title: ticket.title, gist: output.summary },
      ],
      notYetSpecified: unique([
        ...state.map!.notYetSpecified.filter((item) => !cleared.has(normalizeFog(item))),
        ...output.newFog,
      ]),
      outOfScope: unique([...state.map!.outOfScope, ...output.outOfScope]),
      readyToPlan: output.routeClear,
    };
    return this.store.record(
      { ...state, map, decisionTickets: tickets, phase: "wayfinding" },
      "decision.resolved",
      { ticketId: ticket.id, title: ticket.title, newTickets: output.newTickets.length },
    );
  }

  private async plan(state: RunState): Promise<RunState> {
    const output = await this.agents.invoke({
      runId: state.runId,
      role: "planner",
      objective: "Turn the clear decision map into dependency-ordered tracer-bullet implementation tickets",
      input: {
        idea: state.idea,
        map: state.map,
        decisions: state.decisionTickets.map(({ id, title, resolution }) => ({ id, title, resolution })),
        defaultTdd: this.config.workflow.tdd,
        defaultTestCommand: this.config.commands.test,
      },
      expectedOutput:
        "{summary,tasks:[{id,title,description,acceptanceCriteria,affectedPaths?,blockedBy,tdd?,testCommand?}]}",
      schema: PlannerOutputSchema,
      knowledgeQuery: `${state.map?.destination ?? state.idea} implementation tests architecture`,
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

  private async execute(state: RunState): Promise<RunState> {
    const failed = state.tasks.find((task) => task.status === "failed");
    if (failed) throw new Error(`Task ${failed.id} failed: ${failed.failure ?? "unknown failure"}`);
    const active = state.tasks.find((task) => task.status === "active");
    const task = active ?? taskFrontier(state.tasks)[0];
    if (!task) {
      if (state.tasks.every((item) => item.status === "done")) {
        return this.store.record({ ...state, phase: "publishing" }, "implementation.completed");
      }
      throw new Error("Build frontier is empty while pending tasks remain");
    }
    return this.executeTaskStep(state, task);
  }

  private async executeTaskStep(state: RunState, task: BuildTask): Promise<RunState> {
    switch (task.step) {
      case "pending": {
        const next = { ...task, status: "active" as const, step: task.tdd ? ("writing_tests" as const) : ("implementing" as const) };
        return this.updateTask(state, next, "task.started");
      }
      case "writing_tests":
        return this.writeTests(state, task);
      case "red":
        return this.updateTask(state, { ...task, step: "implementing" }, "task.red_confirmed");
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

  private async writeTests(state: RunState, task: BuildTask): Promise<RunState> {
    const result = await this.agents.invoke({
      runId: state.runId,
      role: "test-writer",
      objective: `Write the next failing behavioral test for “${task.title}”`,
      input: { task, priorCommandOutput: evidenceOutput(task.evidence) },
      expectedOutput: "{summary,changedFiles}",
      schema: WorkerOutputSchema,
      constraints: ["Change tests only", "Do not implement production code"],
      knowledgeQuery: `${task.title} tests public interface seam`,
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
      changedFiles: unique([...task.changedFiles, ...result.changedFiles]),
      evidence: [...task.evidence, evidence],
      step: meaningfulRed ? "red" : exhausted ? "failed" : "writing_tests",
      status: exhausted ? "failed" : "active",
      failure:
        exhausted
          ? "Test writer could not produce a meaningful RED run"
          : undefined,
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
        task,
        verifiedCommandOutput: evidenceOutput(task.evidence),
        reviewFeedback: task.reviewSummary,
      },
      expectedOutput: "{summary,changedFiles}",
      schema: WorkerOutputSchema,
      constraints: ["Do not commit", "Do not weaken tests", "Stop after this one task"],
      knowledgeQuery: `${task.title} ${task.description}`,
    });
    const evidence = await this.runTargetedTest(task, task.tdd ? "tdd:green" : "test");
    const attempts = {
      ...task.attempts,
      implementation: task.attempts.implementation + 1,
    };
    const exhausted = !evidence.passed && attempts.implementation >= this.config.workflow.maxImplementationAttempts;
    const updated: BuildTask = {
      ...task,
      attempts,
      changedFiles: unique([...task.changedFiles, ...result.changedFiles]),
      evidence: [...task.evidence, evidence],
      step: evidence.passed ? "verifying" : exhausted ? "failed" : "implementing",
      status: exhausted ? "failed" : "active",
      failure: exhausted ? `Targeted test failed after ${attempts.implementation} implementation attempts` : undefined,
    };
    return this.updateTask(state, updated, evidence.passed ? "task.green_observed" : "task.implementation_repair_needed");
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
      failure: !passed && !canRepair ? "Command gates failed and implementation repair budget is exhausted" : undefined,
    };
    return this.updateTask(state, updated, passed ? "task.gates_passed" : "task.gates_failed");
  }

  private async reviewTask(state: RunState, task: BuildTask): Promise<RunState> {
    const changedFiles = this.config.git.enabled ? await this.git.changedFiles() : task.changedFiles;
    const review = await this.agents.invoke({
      runId: state.runId,
      role: "reviewer",
      objective: `Independently review “${task.title}” against its acceptance criteria`,
      input: { task, changedFiles, commandEvidence: task.evidence },
      expectedOutput: "{approved,summary,findings:[{severity,message}]}",
      schema: ReviewOutputSchema,
      knowledgeQuery: `${task.title} acceptance security standards`,
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
      reviewSummary: [review.summary, ...review.findings.map((finding) => `${finding.severity}: ${finding.message}`)].join("\n"),
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
    const message = await this.message(
      state.runId,
      `Write the commit message for completed task “${task.title}”`,
      { task, changedFiles: task.changedFiles, review: task.reviewSummary },
      fallback,
    );
    const commitSha = await this.git.commitTask(task.id, message, task.changedFiles);
    // A committed task is the deterministic graph boundary: the next task can
    // query the code structure that was just verified and committed. Graphify
    // fails soft here so a graph-tool outage never invalidates a good commit.
    const graphifyUpdated = await this.knowledge.rebuildRepositoryGraph();
    return this.updateTask(
      state,
      { ...task, status: "done", step: "done", commitSha },
      "task.committed",
      { commitSha, graphifyUpdated },
    );
  }

  private async publish(state: RunState): Promise<RunState> {
    const fallback: MessageOutput = {
      subject: `feat: ${state.map?.destination ?? state.idea}`.slice(0, 100),
      body: state.tasks.map((task) => `- ${task.title}`).join("\n"),
    };
    const message = await this.message(
      state.runId,
      "Write the pull-request title and body for this verified feature",
      {
        destination: state.map?.destination,
        decisions: state.map?.decisionsSoFar,
        tasks: state.tasks.map(({ title, reviewSummary, commitSha }) => ({ title, reviewSummary, commitSha })),
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
    // Write map/issues/tasks to disk for within-run handoff (work packets, priorArtifacts,
    // direct reads). Do not index run artifacts into the knowledge base.
    await this.tracker.sync(state);
  }
}

function materializeProposedTickets(
  proposals: NavigatorOutput["tickets"],
  existing: DecisionTicket[],
  now: string,
  maxOpen?: number,
): { tickets: DecisionTicket[]; deferredCount: number } {
  const used = new Set(existing.map((ticket) => ticket.id));
  const idMap = new Map<string, string>();
  const existingProposalIds = new Set<string>();
  for (const [index, proposal] of proposals.entries()) {
    const baseId = safeId(proposal.id, `decision-${index + 1}`);
    if (used.has(baseId)) {
      idMap.set(proposal.id, baseId);
      existingProposalIds.add(proposal.id);
      continue;
    }
    let id = baseId;
    let suffix = 2;
    while (used.has(id)) {
      id = `${safeId(proposal.id, `decision-${index + 1}`)}-${suffix}`;
      suffix += 1;
    }
    used.add(id);
    idMap.set(proposal.id, id);
  }
  const existingIds = new Set(existing.map((ticket) => ticket.id));
  const newProposals = proposals.filter((proposal) => !existingProposalIds.has(proposal.id));
  const openCount = existing.filter((ticket) => !decisionClosed(ticket)).length;
  const slots =
    maxOpen === undefined ? newProposals.length : Math.max(0, maxOpen - openCount);
  const accepted = newProposals.slice(0, slots);
  const deferredCount = newProposals.length - accepted.length;
  const created = accepted.map((proposal) => {
    const question =
      typeof proposal.question === "string"
        ? proposal.question
        : proposal.question.prompt;
    const humanQuestion =
      typeof proposal.question === "string" ? undefined : proposal.question;
    return {
      id: idMap.get(proposal.id)!,
      title: proposal.title,
      question,
      humanQuestion,
      kind: proposal.kind,
      interaction: proposal.interaction,
      status: "open" as const,
      blockedBy: proposal.blockedBy.map((id) =>
        idMap.get(id) ?? (existingIds.has(id) ? id : id),
      ),
      conversation: [],
      createdAt: now,
      updatedAt: now,
    };
  });
  return { tickets: [...existing, ...created], deferredCount };
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
    status: "pending",
    step: "pending",
    attempts: { tests: 0, implementation: 0, review: 0 },
    evidence: [],
    changedFiles: [],
  }));
}

function decisionRole(ticket: DecisionTicket): AgentRole {
  if (ticket.kind === "prototype") return "decision-prototyper";
  if (ticket.kind === "research") return "decision-researcher";
  return "decision-facilitator";
}

function decisionClosed(ticket: DecisionTicket): boolean {
  return ticket.status === "resolved" || ticket.status === "out_of_scope";
}

function replaceTicket(tickets: DecisionTicket[], replacement: DecisionTicket): DecisionTicket[] {
  return tickets.map((ticket) => (ticket.id === replacement.id ? replacement : ticket));
}

function normalizeFog(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = normalizeFog(trimmed);
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

function configurationHashes(config: HarnessConfig): Set<string> {
  const { maxWayfindingTurnsPerEpisode: _addedInEpisodeMigration, ...legacyWorkflow } =
    config.workflow;
  const { guidance: _addedInGuidanceMigration, ...legacyKnowledge } = config.knowledge;
  const variants = [
    config,
    { ...config, workflow: legacyWorkflow },
    { ...config, knowledge: legacyKnowledge },
    { ...config, workflow: legacyWorkflow, knowledge: legacyKnowledge },
  ];
  return new Set([
    // Runs created before ADR 0004 did not serialize this default. Accept the
    // otherwise-identical frozen snapshot so an in-flight run can upgrade.
    // The same applies to the guidance default introduced by ADR 0006.
    ...variants.map(configurationHash),
  ]);
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

void DecisionOutputSchema;
void NavigatorOutputSchema;
void ReviewOutputSchema;
void WorkerOutputSchema;
