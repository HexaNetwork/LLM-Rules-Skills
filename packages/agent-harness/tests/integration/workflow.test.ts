import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  AgentBackendRunError,
  createFakeBackend,
  type AgentBackend,
  type AgentRequest,
} from "../../src/agent.js";
import { HarnessEngine } from "../../src/engine.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

const NAVIGATOR_PLAN = {
  summary: "Need one product decision",
  destination: "A finished greeting feature",
  notes: [],
  tickets: [
    {
      id: "tone",
      title: "Choose greeting tone",
      question: {
        prompt: "Should the greeting be formal or casual?",
        context: "The choice sets the voice users encounter throughout the feature.",
        options: [
          { id: "formal", label: "Formal", description: "Polished and reserved." },
          { id: "casual", label: "Casual", description: "Warm and direct." },
        ],
        recommendedOptionId: "casual",
        recommendation: "Use casual for a lightweight greeting.",
      },
      kind: "grilling",
      interaction: "HITL",
      blockedBy: [],
    },
  ],
  fog: [],
  outOfScope: [],
  readyToPlan: false,
};

describe("durable idea-to-feature workflow", () => {
  it("pauses for a human, resumes from disk, and hands fresh packets between model tiers", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { tdd: false, maxWayfindingTurnsPerEpisode: 6 } as never,
    });
    const requests: AgentRequest[] = [];
    const backend = createFakeBackend({
      "prompt-builder": (request) => {
        requests.push(request);
        return { prompt: `COMPILED\n${request.prompt}` };
      },
      navigator: (request) => {
        requests.push(request);
        return {
          summary: "Need one product decision",
          destination: "A finished greeting feature",
          notes: ["Use user-facing language"],
          tickets: [
            {
              id: "tone",
              title: "Choose greeting tone",
              question: {
                prompt: "Should the greeting be formal or casual?",
                context: "The choice sets the voice users encounter throughout the feature.",
                options: [
                  {
                    id: "formal",
                    label: "Formal",
                    description: "Polished and reserved, but less approachable.",
                  },
                  {
                    id: "casual",
                    label: "Casual",
                    description: "Warm and direct, but still professional.",
                  },
                ],
                recommendedOptionId: "casual",
                recommendation: "Use casual because it fits a lightweight greeting without adding slang.",
              },
              kind: "grilling",
              interaction: "HITL",
              blockedBy: [],
            },
          ],
          fog: [],
          outOfScope: [],
          readyToPlan: false,
        };
      },
      "decision-facilitator": (request) => {
        requests.push(request);
        expect(request.prompt).toContain("Casual");
        return {
          status: "resolved",
          summary: "Use a casual greeting",
          resolution: "The user selected a casual tone.",
          newTickets: [],
          newFog: [],
          clearFog: [],
          outOfScope: [],
          routeClear: true,
        };
      },
      planner: (request) => {
        requests.push(request);
        return {
          summary: "One tracer bullet",
          tasks: [
            {
              id: "greeting",
              title: "Deliver casual greeting",
              description: "Expose a casual greeting through the public API.",
              acceptanceCriteria: ["The public API returns a casual greeting"],
              blockedBy: [],
              tdd: false,
              testCommand: "node -e \"process.exit(0)\"",
            },
          ],
        };
      },
      implementer: (request) => {
        requests.push(request);
        return { summary: "Implemented greeting", changedFiles: ["src/greeting.ts"] };
      },
      reviewer: (request) => {
        requests.push(request);
        return { approved: true, summary: "Acceptance met", findings: [] };
      },
      "message-writer": (request) => {
        requests.push(request);
        return { subject: "feat: add casual greeting", body: "Adds the verified greeting." };
      },
    });
    const engine = new HarnessEngine(config, { backend });
    let state = await engine.start("Build a greeting", "human-loop");
    state = await engine.advance(state.runId);

    expect(state.phase).toBe("awaiting_input");
    const question = state.questions.find((item) => item.id === state.activeQuestionId)!;
    expect(question.prompt).toContain("formal or casual");
    expect(question.options).toHaveLength(2);
    expect(question.recommendedOptionId).toBe("casual");
    expect(question.recommendation).toContain("Use casual");

    await engine.answer(state.runId, question.id, "Casual, but not slangy.");
    state = await engine.advance(state.runId);

    expect(state.phase).toBe("completed");
    expect(state.map?.decisionsSoFar[0]?.gist).toBe("Use a casual greeting");
    expect(state.tasks[0]?.status).toBe("done");
    const facilitator = requests.find((request) => request.role === "decision-facilitator");
    expect(facilitator?.model).toBe("capable-model");
    expect(facilitator?.providerSessionId).toBeDefined();
    expect(facilitator?.continuationPrompt).toContain("Casual, but not slangy.");
    expect(facilitator?.continuationPrompt?.length).toBeLessThan(facilitator?.prompt.length ?? 0);
    expect(state.wayfindingEpisode?.turnCount).toBe(2);
    expect(state.wayfindingEpisode?.closedAt).toBeDefined();
    expect(requests.filter((request) => request.role === "prompt-builder").every((request) => request.model === "small-model")).toBe(true);
    expect(requests.filter((request) => request.role === "message-writer").every((request) => request.model === "small-model")).toBe(true);

    const sessions = await readdir(path.join(root, ".agent-harness", "runs", state.runId, "sessions"));
    expect(new Set(sessions).size).toBe(sessions.length);
    expect(sessions.length).toBe(requests.length);
    const wayfindingSessions = await Promise.all(
      sessions.map(async (session) =>
        JSON.parse(
          await readFile(
            path.join(root, ".agent-harness", "runs", state.runId, "sessions", session),
            "utf8",
          ),
        ) as {
          role: string;
          providerSessionId?: string;
          providerSessionReused?: boolean;
        },
      ),
    );
    const navigatorSession = wayfindingSessions.find((session) => session.role === "navigator");
    const facilitatorSession = wayfindingSessions.find(
      (session) => session.role === "decision-facilitator",
    );
    expect(facilitatorSession?.providerSessionId).toBe(navigatorSession?.providerSessionId);
    expect(facilitatorSession?.providerSessionReused).toBe(true);
    const issue = await readFile(
      path.join(root, ".agent-harness", "runs", state.runId, "issues", "tone-choose-greeting-tone.md"),
      "utf8",
    );
    expect(issue).toContain("Casual, but not slangy");
    expect(issue).toContain("The user selected a casual tone");
    expect(issue).toContain("### Options");
    expect(issue).toContain("Casual (recommended)");
  });

  it("writes run artifacts to disk without indexing them into knowledge", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      agent: { promptBuilder: false } as never,
      workflow: { tdd: false } as never,
    });
    const backend = createFakeBackend({
      navigator: () => NAVIGATOR_PLAN,
      "decision-facilitator": () => ({
        status: "resolved",
        summary: "Use a casual greeting",
        resolution: "The user selected a casual tone.",
        newTickets: [],
        newFog: [],
        clearFog: [],
        outOfScope: [],
        routeClear: true,
      }),
      planner: () => ({
        summary: "One tracer bullet",
        tasks: [
          {
            id: "greeting",
            title: "Deliver casual greeting",
            description: "Expose a casual greeting through the public API.",
            acceptanceCriteria: ["The public API returns a casual greeting"],
            blockedBy: [],
            tdd: false,
            testCommand: "node -e \"process.exit(0)\"",
          },
        ],
      }),
      implementer: () => ({ summary: "Implemented greeting", changedFiles: ["src/greeting.ts"] }),
      reviewer: () => ({ approved: true, summary: "Acceptance met", findings: [] }),
      "message-writer": () => ({ subject: "feat: add casual greeting", body: "Adds the verified greeting." }),
    });
    const engine = new HarnessEngine(config, { backend });
    let state = await engine.start("Build a greeting", "no-index-artifacts");
    state = await engine.advance(state.runId);
    const question = state.questions.find((item) => item.id === state.activeQuestionId)!;
    await engine.answer(state.runId, question.id, "Casual.");
    state = await engine.advance(state.runId);

    const mapPath = path.join(root, ".agent-harness", "runs", state.runId, "map.md");
    const map = await readFile(mapPath, "utf8");
    expect(map).toContain("Use a casual greeting");

    const withoutRun = await engine.knowledge.search("casual greeting", 10, { repository: false });
    const withRun = await engine.knowledge.search("casual greeting", 10, {
      repository: false,
      runId: state.runId,
    });
    expect(withoutRun.every((result) => !result.source.includes(".agent-harness/runs/"))).toBe(true);
    expect(withRun.every((result) => !result.source.includes(".agent-harness/runs/"))).toBe(true);
  });

  it("runs RED before implementation and routes failing GREEN evidence into a bounded repair", async () => {
    const root = await fixtureRoot();
    const command =
      "node -e \"const fs=require('fs');process.exit(fs.existsSync('src/done.txt')?0:1)\"";
    const config = fixtureConfig(root, {
      agent: { promptBuilder: false } as never,
      commands: { test: command, gates: [] } as never,
    });
    const order: string[] = [];
    const implementPrompts: string[] = [];
    let implementations = 0;
    const backend = createFakeBackend({
      navigator: () => ({
        summary: "Route already clear",
        destination: "A file-backed completion signal",
        notes: [],
        tickets: [],
        fog: [],
        outOfScope: [],
        readyToPlan: true,
      }),
      planner: () => ({
        summary: "One vertical task",
        tasks: [
          {
            id: "done-signal",
            title: "Create completion signal",
            description: "Create the signal file.",
            acceptanceCriteria: ["The completion signal is observable"],
            blockedBy: [],
            tdd: true,
            testCommand: command,
          },
        ],
      }),
      "test-writer": async (request) => {
        order.push("test-writer");
        await mkdir(path.join(request.cwd, "tests"), { recursive: true });
        await writeFile(path.join(request.cwd, "tests", "done.test.js"), "// behavioral seam\n", "utf8");
        return { summary: "Wrote failing behavior", changedFiles: ["tests/done.test.js"] };
      },
      implementer: async (request) => {
        order.push("implementer");
        implementPrompts.push(request.prompt);
        implementations += 1;
        if (implementations === 2) {
          await mkdir(path.join(request.cwd, "src"), { recursive: true });
          await writeFile(path.join(request.cwd, "src", "done.txt"), "done\n", "utf8");
          return { summary: "Created signal", changedFiles: ["src/done.txt"] };
        }
        return { summary: "Incomplete attempt", changedFiles: [] };
      },
      reviewer: () => ({ approved: true, summary: "Verified", findings: [] }),
      "message-writer": () => ({ subject: "feat: add completion signal", body: "Verified." }),
    });
    const engine = new HarnessEngine(config, { backend });
    const created = await engine.start("Add a completion signal", "tdd-loop");
    const state = await engine.advance(created.runId);

    expect(state.phase).toBe("completed");
    expect(order[0]).toBe("test-writer");
    expect(implementations).toBe(2);
    expect(implementPrompts[1]).toContain("tdd:green: FAIL");
    expect(implementPrompts[1]).toContain("Exit: 1");
    const purposes = state.tasks[0]?.evidence.map((item) => item.purpose) ?? [];
    expect(purposes[0]).toBe("tdd:red");
    expect(purposes).toContain("tdd:green");
    expect(state.tasks[0]?.evidence.at(-1)?.passed).toBe(true);
  });

  it("blocks quickly instead of hanging when an agent never returns", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      agent: { timeoutMs: 25, promptBuilder: false, schemaRepairAttempts: 0 } as never,
    });
    const backend = createFakeBackend({
      navigator: () => new Promise(() => undefined),
    });
    const engine = new HarnessEngine(config, { backend });
    const created = await engine.start("Never hang", "timeout");
    const started = performance.now();
    const state = await engine.advance(created.runId);

    expect(performance.now() - started).toBeLessThan(1_000);
    expect(state.phase).toBe("blocked");
    expect(state.failure).toContain("timed out");
    expect(state.blockedFrom).toBe("navigating");
  });

  it("repairs malformed output in the same provider session and preserves failed usage", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      agent: { promptBuilder: false, schemaRepairAttempts: 1 } as never,
    });
    const requests: AgentRequest[] = [];
    let calls = 0;
    const backend: AgentBackend = {
      async run(request) {
        requests.push(request);
        calls += 1;
        if (calls === 1) {
          return {
            output: "not json",
            providerSessionId: "wayfinding-agent",
            providerRunId: "provider-run-1",
            providerSessionReused: false,
            submittedPrompt: request.prompt,
            inputTokens: 100,
            outputTokens: 5,
          };
        }
        expect(request.providerSessionId).toBe("wayfinding-agent");
        expect(request.continuationPrompt).toContain("previous response");
        return {
          output: {
            summary: "One human choice remains",
            destination: "A repaired route",
            notes: [],
            tickets: [
              {
                id: "choice",
                title: "Choose behavior",
                question: {
                  prompt: "Which behavior should ship?",
                  context: "The implementation depends on this product preference.",
                  options: [
                    { id: "a", label: "A", description: "Choose the first behavior." },
                    { id: "b", label: "B", description: "Choose the second behavior." },
                  ],
                  recommendedOptionId: "a",
                  recommendation: "Choose A because it is the narrower behavior.",
                },
                kind: "grilling",
                interaction: "HITL",
                blockedBy: [],
              },
            ],
            fog: [],
            outOfScope: [],
            readyToPlan: false,
          },
          providerSessionId: "wayfinding-agent",
          providerRunId: "provider-run-2",
          providerSessionReused: true,
          submittedPrompt: request.continuationPrompt,
          inputTokens: 20,
          outputTokens: 10,
        };
      },
      async release() {},
    };
    const engine = new HarnessEngine(config, { backend });
    const created = await engine.start("Repair structured output", "repair-usage");
    const state = await engine.advance(created.runId);

    expect(state.phase).toBe("awaiting_input");
    expect(requests).toHaveLength(2);
    const sessionDirectory = path.join(
      root,
      ".agent-harness",
      "runs",
      state.runId,
      "sessions",
    );
    const records = await Promise.all(
      (await readdir(sessionDirectory)).map(async (file) =>
        JSON.parse(await readFile(path.join(sessionDirectory, file), "utf8")) as {
          status: string;
          attempt: number;
          providerSessionId?: string;
          providerSessionReused?: boolean;
          providerRunId?: string;
          usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
          output?: unknown;
        },
      ),
    );
    const failed = records.find((record) => record.status === "failed");
    const repaired = records.find((record) => record.status === "completed");
    expect(failed?.providerSessionId).toBe("wayfinding-agent");
    expect(failed?.providerRunId).toBe("provider-run-1");
    expect(failed?.usage).toEqual({ inputTokens: 100, outputTokens: 5, totalTokens: 105 });
    expect(failed?.output).toBe("not json");
    expect(repaired?.providerSessionId).toBe("wayfinding-agent");
    expect(repaired?.providerSessionReused).toBe(true);
  });

  it("rolls to a fresh wayfinding episode at the configured turn boundary", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      agent: { promptBuilder: false } as never,
      workflow: { maxWayfindingTurnsPerEpisode: 1 } as never,
    });
    const requests: AgentRequest[] = [];
    const backend = createFakeBackend({
      navigator: (request) => {
        requests.push(request);
        return {
          summary: "One research decision",
          destination: "A bounded episode",
          notes: [],
          tickets: [
            {
              id: "research",
              title: "Resolve source",
              question: "Which source is authoritative?",
              kind: "research",
              interaction: "AFK",
              blockedBy: [],
            },
          ],
          fog: [],
          outOfScope: [],
          readyToPlan: false,
        };
      },
      "decision-researcher": (request) => {
        requests.push(request);
        return {
          status: "resolved",
          summary: "Use the repository",
          resolution: "The repository is authoritative.",
          newTickets: [],
          newFog: [],
          clearFog: [],
          outOfScope: [],
          routeClear: true,
        };
      },
    });
    const engine = new HarnessEngine(config, { backend });
    const created = await engine.start("Bound the interview", "episode-rollover");
    const state = await engine.advance(created.runId, 2);

    expect(requests).toHaveLength(2);
    expect(requests[0]?.providerSessionId).toBeUndefined();
    expect(requests[1]?.providerSessionId).toBeUndefined();
    expect(state.wayfindingEpisode?.number).toBe(2);
    expect(state.wayfindingEpisode?.turnCount).toBe(1);
    expect(await readFile(
      path.join(root, ".agent-harness", "runs", state.runId, "events.jsonl"),
      "utf8",
    )).toContain("wayfinding.episode_rolled");
  });

  it("continues a frozen run created before episode and guidance config existed", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, { agent: { promptBuilder: false } as never });
    const backend = createFakeBackend({
      navigator: () => ({
        summary: "Need one choice",
        destination: "A migrated run",
        notes: [],
        tickets: [
          {
            id: "choice",
            title: "Choose migration behavior",
            question: {
              prompt: "Should the migrated run continue?",
              context: "The old frozen config did not contain the new episode limit.",
              options: [
                { id: "yes", label: "Continue", description: "Preserve the active run." },
                { id: "no", label: "Stop", description: "Require a replacement run." },
              ],
              recommendedOptionId: "yes",
              recommendation: "Continue because the missing field has a deterministic default.",
            },
            kind: "grilling",
            interaction: "HITL",
            blockedBy: [],
          },
        ],
        fog: [],
        outOfScope: [],
        readyToPlan: false,
      }),
    });
    const engine = new HarnessEngine(config, { backend });
    let created = await engine.start("Continue an old run", "legacy-episode-config");
    const { maxWayfindingTurnsPerEpisode: _missingInLegacy, ...legacyWorkflow } =
      config.workflow;
    const { guidance: _missingGuidanceInLegacy, ...legacyKnowledge } = config.knowledge;
    const legacyHash = createHash("sha256")
      .update(JSON.stringify({ ...config, workflow: legacyWorkflow, knowledge: legacyKnowledge }))
      .digest("hex");
    created = await engine.store.writeState({ ...created, configurationHash: legacyHash });

    const state = await engine.advance(created.runId);

    expect(state.phase).toBe("awaiting_input");
    expect(state.failure).toBeUndefined();
    expect(state.wayfindingEpisode?.number).toBe(1);
  });

  it("accepts navigator JSON delivered only through CreatePlan when result is empty", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      agent: { promptBuilder: false, schemaRepairAttempts: 1 } as never,
    });
    const backend: AgentBackend = {
      async run(request) {
        return {
          output: "",
          createPlanBodies: [JSON.stringify(NAVIGATOR_PLAN)],
          providerSessionId: "plan-agent",
          providerRunId: "plan-run",
          providerSessionReused: false,
          submittedPrompt: request.prompt,
        };
      },
      async release() {},
    };
    const engine = new HarnessEngine(config, { backend });
    const created = await engine.start("Harvest CreatePlan payload", "create-plan-harvest");
    const state = await engine.advance(created.runId);

    expect(state.phase).toBe("awaiting_input");
    expect(state.map?.destination).toBe("A finished greeting feature");
    const sessions = await readdir(
      path.join(root, ".agent-harness", "runs", state.runId, "sessions"),
    );
    const completed = JSON.parse(
      await readFile(
        path.join(root, ".agent-harness", "runs", state.runId, "sessions", sessions[0]!),
        "utf8",
      ),
    ) as { status: string; output: string };
    expect(completed.status).toBe("completed");
    expect(completed.output).toContain("A finished greeting feature");
  });

  it("does not schema-repair provider run errors", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      agent: { promptBuilder: false, schemaRepairAttempts: 1 } as never,
    });
    let calls = 0;
    const backend: AgentBackend = {
      async run() {
        calls += 1;
        throw new AgentBackendRunError(
          "Cursor run run_budget cancelled",
          { output: "", providerSessionId: "cancelled-agent" },
        );
      },
      async release() {},
    };
    const engine = new HarnessEngine(config, { backend });
    const created = await engine.start("Provider cancel", "provider-no-repair");
    const state = await engine.advance(created.runId);

    expect(calls).toBe(1);
    expect(state.phase).toBe("blocked");
    expect(state.failure).toContain("cancelled");
    expect(state.failure).not.toContain("no JSON object");
  });
});
