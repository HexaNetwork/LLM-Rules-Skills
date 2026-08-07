import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeBackend } from "../../src/agent.js";
import { HarnessEngine } from "../../src/engine.js";
import { startUiServer, type UiServer } from "../../src/ui/server.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

const REFLECT_OUTPUT = {
  summary: "Restated",
  restatement: "Build a dashboard-driven feature.",
  goal: "Ship from the dashboard",
  users: ["operators"],
  inScope: ["HITL grilling"],
  outOfScope: ["wayfinding"],
  assumptions: [],
  unknowns: ["tone"],
};

const GRILL_QUESTION = {
  prompt: "Should the interface feel quiet or energetic?",
  context: "This choice controls the dashboard's density, motion, and visual emphasis.",
  options: [
    {
      id: "quiet",
      label: "Quiet and focused",
      description: "Restrained color and motion support longer work sessions.",
    },
    {
      id: "energetic",
      label: "Energetic",
      description: "Stronger color and motion make progress more visible.",
    },
  ],
  recommendedOptionId: "quiet",
  recommendation: "Choose quiet and focused because this is a long-running control surface.",
};

describe("central dashboard", () => {
  let ui: UiServer | undefined;

  afterEach(async () => {
    await ui?.close();
    ui = undefined;
  });

  it("validates and persists schema-driven project settings", async () => {
    const root = await fixtureRoot();
    const configPath = path.join(root, "agent-harness.config.yaml");
    await writeFile(
      configPath,
      "version: 2\nrepositoryRoot: .\nworkflow:\n  maxGrillQuestionsPerEpisode: 6\n",
      "utf8",
    );
    ui = await startUiServer({
      config: fixtureConfig(root),
      backend: createFakeBackend({}),
      configPath,
      port: 0,
      token: "ui-test",
    });

    const initial = await request(ui, "/api/settings");
    const initialBody = (await initial.json()) as {
      settings: { editable: boolean; definitions: unknown[]; values: Record<string, number> };
    };
    expect(initialBody.settings.editable).toBe(true);
    expect(initialBody.settings.definitions).toHaveLength(2);
    expect(initialBody.settings.values["workflow.maxGrillQuestionsPerEpisode"]).toBe(5);
    expect(initialBody.settings.values["workflow.staleAnswerMinutes"]).toBe(30);

    const invalid = await request(ui, "/api/settings", {
      method: "PUT",
      body: {
        values: {
          "workflow.maxGrillQuestionsPerEpisode": 0,
          "workflow.staleAnswerMinutes": 30,
        },
      },
    });
    expect(invalid.status).toBe(400);

    const updated = await request(ui, "/api/settings", {
      method: "PUT",
      body: {
        values: {
          "workflow.maxGrillQuestionsPerEpisode": 10,
          "workflow.staleAnswerMinutes": 45,
        },
      },
    });
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as {
      appliesTo: string;
      settings: { values: Record<string, number> };
    };
    expect(updatedBody.appliesTo).toBe("new_runs");
    expect(updatedBody.settings.values["workflow.maxGrillQuestionsPerEpisode"]).toBe(10);
    expect(updatedBody.settings.values["workflow.staleAnswerMinutes"]).toBe(45);
    expect(await readFile(configPath, "utf8")).toContain("maxGrillQuestionsPerEpisode: 10");

    const bootstrap = await request(ui, "/api/bootstrap");
    const bootstrapBody = (await bootstrap.json()) as {
      project: { settings: { values: Record<string, number> } };
    };
    expect(
      bootstrapBody.project.settings.values["workflow.maxGrillQuestionsPerEpisode"],
    ).toBe(10);
  });

  it("lets an explicitly resumed restored run rebuild knowledge before advancing", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root);
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
    });
    const engine = new HarnessEngine(config, { backend });
    const started = await engine.start("Resume after dashboard restart", "restored-run", false);
    expect(started.phase).toBe("new");

    ui = await startUiServer({ config, backend, port: 0, token: "ui-test" });
    const resumed = await request(ui, `/api/runs/${started.runId}/actions`, {
      method: "POST",
      body: { action: "resume" },
    });
    expect(resumed.status).toBe(202);

    const detail = await waitForPhase(ui, started.runId, "awaiting_input");
    expect(detail.state.reflectBrief.draft).toContain("dashboard-driven");
    expect(detail.state.questions[0]?.purpose).toBe("reflect");
  });

  it("runs the HITL workflow, exposes artifacts, and searches local knowledge", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      agent: { promptBuilder: false } as never,
      workflow: { tdd: false } as never,
    });
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
      griller: (request) => {
        if (
          String(request.prompt).includes("Quiet and focused") ||
          String(request.continuationPrompt ?? "").includes("Quiet and focused")
        ) {
          return {
            status: "ready_to_plan",
            summary: "Use a quiet interface",
            resolutions: [
              {
                id: "tone",
                question: GRILL_QUESTION.prompt,
                answer: "Quiet and focused",
                summary: "Use a quiet interface",
              },
            ],
          };
        }
        return {
          status: "needs_input",
          summary: "Need tone",
          question: GRILL_QUESTION,
        };
      },
      planner: () => ({
        summary: "One UI task",
        tasks: [
          {
            id: "dashboard",
            title: "Deliver dashboard",
            description: "Expose the feature through the dashboard.",
            acceptanceCriteria: ["The dashboard shows the feature"],
            blockedBy: [],
            tdd: false,
            testCommand: "node -e \"process.exit(0)\"",
          },
        ],
      }),
      implementer: () => ({ summary: "Built", changedFiles: ["src/dashboard.ts"] }),
      reviewer: () => ({ approved: true, summary: "Verified", findings: [] }),
      "message-writer": () => ({ subject: "feat: add dashboard", body: "Verified UI." }),
    });
    ui = await startUiServer({ config, backend, port: 0, token: "ui-test" });

    expect((await fetch(`${ui.origin}/api/bootstrap`)).status).toBe(401);
    const refreshed = await fetch(`${ui.origin}/`);
    expect(refreshed.status).toBe(200);
    expect(await refreshed.text()).toContain("Reflect · Grill · Deliver");
    const page = await fetch(`${ui.origin}/?token=ui-test`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Agent Harness");

    const created = await request(ui, "/api/runs", {
      method: "POST",
      body: { idea: "Build it from one dashboard", tdd: false },
    });
    expect(created.status).toBe(202);
    const createdBody = (await created.json()) as { run: { runId: string } };
    const runId = createdBody.run.runId;

    let detail = await waitForPhase(ui, runId, "awaiting_input");
    let question = detail.state.questions.find(
      (item: { id: string }) => item.id === detail.state.activeQuestionId,
    );
    expect(question.purpose).toBe("reflect");
    expect(question.draftAnswer).toContain("dashboard-driven");

    await request(ui, `/api/runs/${runId}/actions`, {
      method: "POST",
      body: {
        action: "answer",
        questionId: question.id,
        answer: "Confirmed: quiet dashboard feature.",
      },
    });

    detail = await waitForPhase(ui, runId, "awaiting_input");
    question = detail.state.questions.find(
      (item: { id: string }) => item.id === detail.state.activeQuestionId,
    );
    expect(question.prompt).toContain("quiet or energetic");
    expect(question.options).toHaveLength(2);
    expect(question.recommendedOptionId).toBe("quiet");

    const answered = await request(ui, `/api/runs/${runId}/actions`, {
      method: "POST",
      body: {
        action: "answer",
        questionId: question.id,
        answer: "Quiet and focused, with restrained color.",
      },
    });
    expect(answered.status).toBe(202);
    detail = await waitForPhase(ui, runId, "completed");

    expect(detail.state.tasks[0]?.status).toBe("done");
    expect(detail.sessions.length).toBeGreaterThan(0);
    expect(detail.artifacts).toContain("brief.md");
    expect(detail.artifacts).toContain("grill.md");

    const grillerSession = detail.sessions.find(
      (session: { role: string }) => session.role === "griller",
    );
    const inspected = await request(
      ui,
      `/api/runs/${runId}/session?path=${encodeURIComponent(grillerSession.path)}`,
    );
    expect(inspected.status).toBe(200);
    const inspection = (await inspected.json()) as {
      inputPrompt: string;
      inputSource: string;
      packet: { role: string };
      session: { output: { summary: string } };
    };
    expect(inspection.inputSource).toBe("stored exact input");
    expect(inspection.inputPrompt).toContain("griller");
    expect(inspection.packet.role).toBe("griller");

    const brief = await request(
      ui,
      `/api/runs/${runId}/artifact?path=${encodeURIComponent("brief.md")}`,
    );
    expect(((await brief.json()) as { content: string }).content).toContain(
      "Confirmed: quiet dashboard feature.",
    );

    const search = await request(ui, "/api/knowledge/search", {
      method: "POST",
      body: { query: "quiet interface" },
    });
    const searchBody = (await search.json()) as { results: Array<{ source: string }> };
    expect(searchBody.results.some((result) => result.source.includes(".agent-harness/runs/"))).toBe(
      false,
    );

    const retrievalStatus = await request(ui, "/api/knowledge/status");
    expect(await retrievalStatus.json()).toMatchObject({
      lexical: true,
      semantic: { enabled: false },
    });

    const traversal = await request(
      ui,
      `/api/runs/${runId}/artifact?path=${encodeURIComponent("../package.json")}`,
    );
    expect(traversal.status).toBe(400);

    const sessionTraversal = await request(
      ui,
      `/api/runs/${runId}/session?path=${encodeURIComponent("../state.json")}`,
    );
    expect(sessionTraversal.status).toBe(400);
  });
});

async function request(
  ui: UiServer,
  pathname: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`${ui.origin}${pathname}`, {
    method: init.method ?? "GET",
    headers: {
      "X-Harness-Token": ui.token,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
}

async function waitForPhase(
  ui: UiServer,
  runId: string,
  phase: string,
): Promise<{
  state: {
    phase: string;
    activeQuestionId?: string;
    reflectBrief?: { draft?: string; confirmed?: string };
    questions: Array<{
      id: string;
      purpose?: string;
      prompt: string;
      draftAnswer?: string;
      options?: unknown[];
      recommendedOptionId?: string;
    }>;
    tasks: Array<{ status: string }>;
  };
  sessions: Array<{ role: string; path: string }>;
  artifacts: string[];
}> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await request(ui, `/api/runs/${runId}`);
    if (response.status !== 200) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    const body = (await response.json()) as {
      state?: {
        phase: string;
      };
      job?: { status: string };
      sessions: Array<{ role: string; path: string }>;
      artifacts: string[];
    };
    if (body.state?.phase === phase && !body.job) {
      return body as never;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for phase ${phase}`);
}
