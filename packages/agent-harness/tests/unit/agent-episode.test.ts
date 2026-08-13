import { describe, expect, it } from "vitest";
import { resolveHarnessPaths } from "../../src/application/paths.js";
import { AgentCoordinator } from "../../src/infrastructure/agents/agent-coordinator.js";
import { createFakeBackend, emitFakeToolCallSteps } from "../../src/infrastructure/agents/fake-backend.js";
import type { AgentRequest } from "../../src/infrastructure/agents/types.js";
import { WorkerOutputSchema, createRunState } from "../../src/domain.js";
import { LocalKnowledgeBase } from "../../src/knowledge.js";
import { RunStore } from "../../src/store.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

describe("invokeInEpisode continuations", () => {
  it("sends a full prompt then bounded continuationInput for retained implementer sessions", async () => {
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
    await store.create(createRunState(runId, "Implement feature", new Date().toISOString()));

    const uniqueTaskTitle = "UNIQUE_FULL_TASK_TITLE_FOR_EPISODE";
    const captured: Array<{ reused: boolean; prompt: string }> = [];
    const backend = createFakeBackend({
      implementer: (request: AgentRequest) => {
        const reused = request.providerSessionId != null;
        captured.push({
          reused,
          prompt: reused ? (request.continuationPrompt ?? request.prompt) : request.prompt,
        });
        return { summary: reused ? "repaired" : "implemented", changedFiles: ["src/feature.ts"] };
      },
    });
    const agents = new AgentCoordinator(config, backend, store, knowledge);

    const first = await agents.invokeInEpisode({
      runId,
      role: "implementer",
      mode: "agent",
      objective: `Implement ${uniqueTaskTitle}`,
      input: {
        task: {
          id: "task-1",
          title: uniqueTaskTitle,
          description: "desc",
          acceptanceCriteria: ["works"],
        },
      },
      knowledgeQuery: uniqueTaskTitle,
      retrieval: false,
      buildPrompt: false,
      expectedOutput: "{summary,changedFiles}",
      schema: WorkerOutputSchema,
    });
    expect(first.providerSessionId).toBeTruthy();

    const second = await agents.invokeInEpisode({
      runId,
      role: "implementer",
      mode: "agent",
      objective: `Repair ${uniqueTaskTitle}`,
      input: {
        task: {
          id: "task-1",
          title: uniqueTaskTitle,
          description: "desc",
          acceptanceCriteria: ["works"],
        },
      },
      continuationInput: {
        instruction: "Continue from the latest verified command output and review feedback.",
      },
      knowledgeQuery: uniqueTaskTitle,
      retrieval: false,
      buildPrompt: false,
      expectedOutput: "{summary,changedFiles}",
      schema: WorkerOutputSchema,
      providerSessionId: first.providerSessionId,
      previousGuidanceFingerprint: first.guidanceFingerprint,
    });

    expect(second.providerSessionId).toBe(first.providerSessionId);
    expect(captured).toHaveLength(2);
    expect(captured[0]?.reused).toBe(false);
    expect(captured[0]?.prompt).toContain("WORK PACKET");
    expect(captured[0]?.prompt).toContain(uniqueTaskTitle);
    expect(captured[1]?.reused).toBe(true);
    expect(captured[1]?.prompt).toContain(
      "Continue from the latest verified command output and review feedback.",
    );
    expect(captured[1]?.prompt).not.toContain("WORK PACKET");
    expect(captured[1]?.prompt).not.toContain(uniqueTaskTitle);
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
    let prompt = "";
    const backend = createFakeBackend({
      implementer: (request: AgentRequest) => {
        prompt = request.prompt;
        return { summary: "ok", changedFiles: [] };
      },
    });
    const agents = new AgentCoordinator(config, backend, store, knowledge);
    await agents.invokeInEpisode({
      runId: "cold-run",
      role: "implementer",
      objective: "Implement feature",
      input: { task: { id: "t1", title: "Feature", description: "d", acceptanceCriteria: ["a"] } },
      continuationInput: { instruction: "delta only" },
      knowledgeQuery: "Feature",
      retrieval: false,
      buildPrompt: false,
      expectedOutput: "{summary,changedFiles}",
      schema: WorkerOutputSchema,
    });
    expect(prompt).toContain("WORK PACKET");
    expect(prompt).toContain("Feature");
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
    const backend = createFakeBackend({
      implementer: async (request) => {
        await emitFakeToolCallSteps(request, ["Read", "Shell"]);
        return { summary: "ok", changedFiles: ["src/a.ts"] };
      },
    });
    const agents = new AgentCoordinator(config, backend, store, knowledge);
    const result = await agents.invokeInEpisode({
      runId: "tools-run",
      role: "implementer",
      mode: "agent",
      objective: "Implement",
      input: { task: { id: "t1", title: "T", description: "d", acceptanceCriteria: ["a"] } },
      knowledgeQuery: "T",
      retrieval: false,
      buildPrompt: false,
      expectedOutput: "{summary,changedFiles}",
      schema: WorkerOutputSchema,
    });
    expect(result.observedToolNames).toEqual(expect.arrayContaining(["Read", "Shell"]));
  });
});
