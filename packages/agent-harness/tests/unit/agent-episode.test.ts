import { describe, expect, it } from "vitest";
import { resolveHarnessPaths } from "../../src/application/paths.js";
import { TaskExecutionService } from "../../src/application/task-execution-service.js";
import { ApplicationContext } from "../../src/application/application-context.js";
import {
  AgentCoordinator,
  createFakeBackend,
  emitFakeToolCallSteps,
  type AgentRequest,
} from "../../src/agent.js";
import {
  BuildTaskSchema,
  WorkerOutputSchema,
  createRunState,
  createTddLoop,
} from "../../src/domain.js";
import { LocalKnowledgeBase } from "../../src/knowledge.js";
import { RunStore } from "../../src/store.js";
import { createScriptedBackend } from "../testkit/scripted-backend.js";
import { fixtureConfig, fixtureRoot, passingCommandRunner } from "../helpers.js";

describe("invokeInEpisode continuations", () => {
  it("sends a full prompt then bounded continuationInput for retained red and green sessions", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      agent: { promptBuilder: false } as never,
      knowledge: {
        ...fixtureConfig(root).knowledge,
        graphify: { ...fixtureConfig(root).knowledge.graphify, enabled: false },
      },
    });
    const store = new RunStore(config, resolveHarnessPaths(config).stateRoot);
    await store.initialize();
    const knowledge = new LocalKnowledgeBase(config);
    await knowledge.refresh();
    const runId = "episode-continue";
    await store.create(createRunState(runId, "Alternating TDD", new Date().toISOString()));

    const captured: Array<{
      role: AgentRequest["role"];
      reused: boolean;
      prompt: string;
      mode?: AgentRequest["mode"];
    }> = [];

    const backend = createFakeBackend({
      "red-writer": (request) => {
        const reused = request.providerSessionId != null;
        captured.push({
          role: request.role,
          reused,
          prompt: reused
            ? (request.continuationPrompt ?? request.prompt)
            : request.prompt,
          mode: request.mode,
        });
        return {
          summary: "red batch",
          changedFiles: ["tests/feature.test.ts"],
        };
      },
      implementer: (request) => {
        const reused = request.providerSessionId != null;
        captured.push({
          role: request.role,
          reused,
          prompt: reused
            ? (request.continuationPrompt ?? request.prompt)
            : request.prompt,
          mode: request.mode,
        });
        return { summary: "green batch", changedFiles: ["src/feature.ts"] };
      },
    });
    const agents = new AgentCoordinator(config, backend, store, knowledge);

    const taskId = "task-feature";
    const uniqueTaskTitle = "UNIQUE_FULL_TASK_TITLE_FOR_EPISODE";
    const uniqueEvidence = "UNIQUE_FULL_EVIDENCE_BLOB_FOR_EPISODE";

    const redFirst = await agents.invokeInEpisode({
      runId,
      role: "red-writer",
      mode: "agent",
      objective: "Write tests",
      input: {
        task: {
          id: taskId,
          title: uniqueTaskTitle,
          description: "desc",
          acceptanceCriteria: ["works"],
          tdd: true,
        },
        priorCommandOutput: uniqueEvidence,
      },
      expectedOutput: "{summary,changedFiles}",
      schema: WorkerOutputSchema,
      knowledgeQuery: "feature tests",
      retrieval: false,
      buildPrompt: false,
    });

    const redSecond = await agents.invokeInEpisode({
      runId,
      role: "red-writer",
      mode: "agent",
      objective: "Write tests",
      input: {
        task: {
          id: taskId,
          title: uniqueTaskTitle,
          description: "desc",
          acceptanceCriteria: ["works"],
          tdd: true,
        },
        priorCommandOutput: uniqueEvidence,
      },
      continuationInput: {
        round: 2,
        instruction: "Add the next coherent test batch or return done. Do not run commands.",
      },
      expectedOutput: "{summary,changedFiles}",
      schema: WorkerOutputSchema,
      knowledgeQuery: "feature tests",
      retrieval: false,
      buildPrompt: false,
      providerSessionId: redFirst.providerSessionId,
      previousGuidanceFingerprint: redFirst.guidanceFingerprint,
    });

    const greenFirst = await agents.invokeInEpisode({
      runId,
      role: "implementer",
      mode: "agent",
      objective: "Implement",
      input: {
        task: {
          id: taskId,
          title: uniqueTaskTitle,
          description: "desc",
          acceptanceCriteria: ["works"],
          tdd: true,
        },
        verifiedCommandOutput: uniqueEvidence,
      },
      expectedOutput: "{summary,changedFiles}",
      schema: WorkerOutputSchema,
      knowledgeQuery: "feature impl",
      retrieval: false,
      buildPrompt: false,
    });

    await agents.invokeInEpisode({
      runId,
      role: "implementer",
      mode: "agent",
      objective: "Implement",
      input: {
        task: {
          id: taskId,
          title: uniqueTaskTitle,
          description: "desc",
          acceptanceCriteria: ["works"],
          tdd: true,
        },
        verifiedCommandOutput: uniqueEvidence,
      },
      continuationInput: {
        round: 2,
        instruction: "Implement this round without modifying tests.",
      },
      expectedOutput: "{summary,changedFiles}",
      schema: WorkerOutputSchema,
      knowledgeQuery: "feature impl",
      retrieval: false,
      buildPrompt: false,
      providerSessionId: greenFirst.providerSessionId,
      previousGuidanceFingerprint: greenFirst.guidanceFingerprint,
    });

    expect(redFirst.providerSessionId).toBeTruthy();
    expect(redSecond.providerSessionReused).toBe(true);
    expect(redFirst.providerSessionId).toBe(redSecond.providerSessionId);
    expect(greenFirst.providerSessionId).not.toBe(redFirst.providerSessionId);

    expect(captured).toHaveLength(4);
    expect(captured.map((entry) => entry.mode)).toEqual([
      "agent",
      "agent",
      "agent",
      "agent",
    ]);

    const [redInitial, redContinue, greenInitial, greenContinue] = captured;
    expect(redInitial?.reused).toBe(false);
    expect(redInitial?.prompt).toContain("WORK PACKET");
    expect(redInitial?.prompt).toContain(uniqueTaskTitle);
    expect(redInitial?.prompt).toContain(uniqueEvidence);
    expect(redInitial?.prompt).toContain("typically three to five tests");

    expect(redContinue?.reused).toBe(true);
    expect(redContinue?.prompt).toContain("Add the next coherent test batch");
    expect(redContinue?.prompt).not.toContain("WORK PACKET");
    expect(redContinue?.prompt).not.toContain(uniqueTaskTitle);
    expect(redContinue?.prompt).not.toContain(uniqueEvidence);

    expect(greenInitial?.reused).toBe(false);
    expect(greenInitial?.prompt).toContain("WORK PACKET");
    expect(greenInitial?.prompt).toContain(uniqueTaskTitle);
    expect(greenInitial?.prompt).toContain("green-implementer");

    expect(greenContinue?.reused).toBe(true);
    expect(greenContinue?.prompt).toContain("Implement this round without modifying tests.");
    expect(greenContinue?.prompt).not.toContain("WORK PACKET");
    expect(greenContinue?.prompt).not.toContain(uniqueTaskTitle);
  });

  it("keeps cold-start packets complete when continuationInput is supplied without a session", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      agent: { promptBuilder: false } as never,
      knowledge: {
        ...fixtureConfig(root).knowledge,
        graphify: { ...fixtureConfig(root).knowledge.graphify, enabled: false },
      },
    });
    const store = new RunStore(config, resolveHarnessPaths(config).stateRoot);
    await store.initialize();
    const knowledge = new LocalKnowledgeBase(config);
    await knowledge.refresh();
    const runId = "episode-cold";
    await store.create(createRunState(runId, "Cold fallback", new Date().toISOString()));

    let submitted = "";
    const backend = createFakeBackend({
      "red-writer": (request) => {
        // Cold start must submit the full prompt even when continuationInput was provided.
        expect(request.providerSessionId).toBeUndefined();
        submitted = request.prompt;
        return { summary: "red", changedFiles: ["tests/a.test.ts"] };
      },
    });
    const agents = new AgentCoordinator(config, backend, store, knowledge);
    const uniqueTitle = "COLD_FALLBACK_FULL_TASK_TITLE";

    await agents.invokeInEpisode({
      runId,
      role: "red-writer",
      mode: "agent",
      objective: "Write tests",
      input: {
        task: {
          id: "t1",
          title: uniqueTitle,
          description: "desc",
          acceptanceCriteria: ["works"],
          tdd: true,
        },
        priorCommandOutput: "cold-evidence",
      },
      continuationInput: { instruction: "delta only" },
      expectedOutput: "{summary,changedFiles}",
      schema: WorkerOutputSchema,
      knowledgeQuery: "tests",
      retrieval: false,
      buildPrompt: false,
    });

    expect(submitted).toContain("WORK PACKET");
    expect(submitted).toContain(uniqueTitle);
    expect(submitted).toContain("cold-evidence");
    expect(submitted).not.toContain("delta only");
  });

  it("surfaces observed tool names from onStep emissions", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      agent: { promptBuilder: false } as never,
      knowledge: {
        ...fixtureConfig(root).knowledge,
        graphify: { ...fixtureConfig(root).knowledge.graphify, enabled: false },
      },
    });
    const store = new RunStore(config, resolveHarnessPaths(config).stateRoot);
    await store.initialize();
    const knowledge = new LocalKnowledgeBase(config);
    await knowledge.refresh();
    const runId = "episode-tools";
    await store.create(createRunState(runId, "Tool audit", new Date().toISOString()));

    const backend = createFakeBackend({
      "red-writer": (request) => {
        emitFakeToolCallSteps(request, ["readFile", "shell"]);
        return { summary: "red", changedFiles: ["tests/a.test.ts"] };
      },
    });
    const agents = new AgentCoordinator(config, backend, store, knowledge);
    const invocation = await agents.invokeInEpisode({
      runId,
      role: "red-writer",
      mode: "agent",
      objective: "Write tests",
      input: { task: { title: "T", description: "d", acceptanceCriteria: ["a"], tdd: true } },
      expectedOutput: "{summary,changedFiles}",
      schema: WorkerOutputSchema,
      knowledgeQuery: "tests",
      retrieval: false,
      buildPrompt: false,
    });
    expect(invocation.observedToolNames).toEqual(["readFile", "shell"]);
  });
});

describe("red-writer shell-tool audit and episode persist", () => {
  it("rejects a scripted RED turn that emitted a shell step", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      agent: { promptBuilder: false } as never,
      git: { ...fixtureConfig(root).git, enabled: false },
      knowledge: {
        ...fixtureConfig(root).knowledge,
        graphify: { ...fixtureConfig(root).knowledge.graphify, enabled: false },
      },
    });
    const scripted = createScriptedBackend([
      {
        role: "red-writer",
        steps: [{ type: "toolCall", toolName: "shell", summary: "shell npm test" }],
        output: {
          status: "continue",
          summary: "used shell",
          changedFiles: ["tests/feature.test.ts"],
          behaviorsAdded: ["feature works"],
          edgeCasesAdded: [],
        },
      },
    ]);
    let commandCalls = 0;
    const commands = passingCommandRunner();
    const ctx = new ApplicationContext(config, {
      backend: scripted.backend,
      commands: {
        async run(command, options) {
          commandCalls += 1;
          return commands.run(command, options);
        },
      },
    });
    await ctx.store.initialize();
    const runId = "red-shell-reject";
    const task = BuildTaskSchema.parse({
      id: "task-1",
      title: "Feature",
      description: "Add feature",
      acceptanceCriteria: ["works"],
      blockedBy: [],
      tdd: true,
      status: "active",
      step: "writing_tests",
      attempts: { tests: 0, implementation: 0, review: 0 },
      tddLoop: createTddLoop(),
    });
    const state = {
      ...createRunState(runId, "Shell audit", new Date().toISOString()),
      phase: "executing" as const,
      tasks: [task],
    };
    await ctx.store.create(state);

    const service = new TaskExecutionService(ctx);
    await expect(service.writeTests(state, task)).rejects.toThrow(
      /Red writer used command-execution tools: shell/,
    );
    expect(commandCalls).toBe(0);
    scripted.assertExhausted();
  });

  it("persists redWriterSession after a successful agent-mode invokeInEpisode", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      agent: { promptBuilder: false } as never,
      git: { ...fixtureConfig(root).git, enabled: false },
      knowledge: {
        ...fixtureConfig(root).knowledge,
        graphify: { ...fixtureConfig(root).knowledge.graphify, enabled: false },
      },
    });
    const scripted = createScriptedBackend([
      {
        role: "red-writer",
        steps: [{ type: "toolCall", toolName: "readFile", summary: "readFile" }],
        output: {
          status: "continue",
          summary: "added tests",
          changedFiles: ["tests/feature.test.ts"],
          behaviorsAdded: ["feature works"],
          edgeCasesAdded: [],
        },
      },
    ]);
    let commandCalls = 0;
    const commands = passingCommandRunner();
    const ctx = new ApplicationContext(config, {
      backend: scripted.backend,
      commands: {
        async run(command, options) {
          commandCalls += 1;
          return commands.run(command, options);
        },
      },
    });
    await ctx.store.initialize();
    const runId = "red-session-persist";
    const task = BuildTaskSchema.parse({
      id: "task-1",
      title: "Feature",
      description: "Add feature",
      acceptanceCriteria: ["works"],
      blockedBy: [],
      tdd: true,
      status: "active",
      step: "writing_tests",
      attempts: { tests: 0, implementation: 0, review: 0 },
      tddLoop: createTddLoop(),
    });
    const state = {
      ...createRunState(runId, "Session persist", new Date().toISOString()),
      phase: "executing" as const,
      tasks: [task],
    };
    await ctx.store.create(state);

    const service = new TaskExecutionService(ctx);
    const next = await service.writeTests(state, task);
    const updated = next.tasks.find((item) => item.id === task.id);
    expect(scripted.calls[0]?.retrieval.mode).toBe("agent");
    expect(commandCalls).toBe(0);
    expect(updated?.step).toBe("red");
    expect(updated?.tddLoop?.pendingRound).toMatchObject({
      number: 1,
      mode: "feature",
      testPathsAdded: ["tests/feature.test.ts"],
      behaviorsAdded: ["feature works"],
    });
    expect(updated?.tddLoop?.redWriterSession?.providerSessionId).toBeTruthy();
    expect(updated?.tddLoop?.redWriterSession?.turns).toBe(1);
    expect(updated?.tddLoop?.redWriterSession?.guidanceFingerprint).toBeTruthy();
    scripted.assertExhausted();
  });

  it("accepts RED done only at verified green and skips the command runner", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      agent: { promptBuilder: false } as never,
      git: { ...fixtureConfig(root).git, enabled: false },
      knowledge: {
        ...fixtureConfig(root).knowledge,
        graphify: { ...fixtureConfig(root).knowledge.graphify, enabled: false },
      },
    });
    const scripted = createScriptedBackend([
      {
        role: "red-writer",
        output: {
          status: "done",
          summary: "coverage complete",
          changedFiles: [],
          acceptanceCoverage: [
            {
              criterionIndex: 0,
              covered: true,
              testPaths: ["tests/feature.test.ts"],
              rationale: "covered by round 1",
            },
          ],
          edgeCaseRationale: "boundary cases covered in round 1",
        },
      },
    ]);
    let commandCalls = 0;
    const commands = passingCommandRunner();
    const ctx = new ApplicationContext(config, {
      backend: scripted.backend,
      commands: {
        async run(command, options) {
          commandCalls += 1;
          return commands.run(command, options);
        },
      },
    });
    await ctx.store.initialize();
    const runId = "red-done";
    const task = BuildTaskSchema.parse({
      id: "task-1",
      title: "Feature",
      description: "Add feature",
      acceptanceCriteria: ["works"],
      blockedBy: [],
      tdd: true,
      status: "active",
      step: "writing_tests",
      attempts: { tests: 1, implementation: 1, review: 0 },
      testPaths: ["tests/feature.test.ts"],
      tddLoop: createTddLoop({
        atVerifiedGreen: true,
        completedRounds: [
          {
            number: 1,
            outcome: "implemented",
            testPathsAdded: ["tests/feature.test.ts"],
            behaviorsAdded: ["feature works"],
            edgeCasesAdded: [],
            completedAt: new Date().toISOString(),
          },
        ],
      }),
    });
    const state = {
      ...createRunState(runId, "Done path", new Date().toISOString()),
      phase: "executing" as const,
      tasks: [task],
    };
    await ctx.store.create(state);

    const service = new TaskExecutionService(ctx);
    const next = await service.writeTests(state, task);
    const updated = next.tasks.find((item) => item.id === task.id);
    expect(commandCalls).toBe(0);
    expect(updated?.step).toBe("verifying");
    expect(updated?.tddLoop?.coverage.finalAssessment?.edgeCaseRationale).toContain(
      "boundary cases",
    );
    scripted.assertExhausted();
  });

  it("confirmRed requires pendingRound and never runs a test command", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      agent: { promptBuilder: false } as never,
      git: { ...fixtureConfig(root).git, enabled: false },
      knowledge: {
        ...fixtureConfig(root).knowledge,
        graphify: { ...fixtureConfig(root).knowledge.graphify, enabled: false },
      },
    });
    let commandCalls = 0;
    const commands = passingCommandRunner();
    const ctx = new ApplicationContext(config, {
      backend: createScriptedBackend([]).backend,
      commands: {
        async run(command, options) {
          commandCalls += 1;
          return commands.run(command, options);
        },
      },
    });
    await ctx.store.initialize();
    const runId = "confirm-red";
    const task = BuildTaskSchema.parse({
      id: "task-1",
      title: "Feature",
      description: "Add feature",
      acceptanceCriteria: ["works"],
      blockedBy: [],
      tdd: true,
      status: "active",
      step: "red",
      attempts: { tests: 1, implementation: 0, review: 0 },
      testPaths: ["tests/feature.test.ts"],
      tddLoop: createTddLoop({
        pendingRound: {
          number: 1,
          mode: "feature",
          testPathsAdded: ["tests/feature.test.ts"],
          behaviorsAdded: ["feature works"],
          edgeCasesAdded: [],
          implementerAttempts: 0,
          startedAt: new Date().toISOString(),
        },
      }),
    });
    const state = {
      ...createRunState(runId, "Confirm red", new Date().toISOString()),
      phase: "executing" as const,
      tasks: [task],
    };
    await ctx.store.create(state);

    const service = new TaskExecutionService(ctx);
    const next = await service.confirmRed(state, task);
    expect(commandCalls).toBe(0);
    expect(next.tasks[0]?.step).toBe("implementing");
  });
});
