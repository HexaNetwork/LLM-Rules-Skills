import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeBackend } from "../../src/agent.js";
import { HarnessEngine } from "../../src/engine.js";
import { startUiServer, type UiServer } from "../../src/ui/server.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

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
      "version: 2\nrepositoryRoot: .\nworkflow:\n  maxWayfindingTurnsPerEpisode: 6\n",
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
    expect(initialBody.settings.definitions).toHaveLength(1);
    expect(initialBody.settings.values["workflow.maxWayfindingTurnsPerEpisode"]).toBe(1);

    const invalid = await request(ui, "/api/settings", {
      method: "PUT",
      body: {
        values: {
          "workflow.maxWayfindingTurnsPerEpisode": 0,
        },
      },
    });
    expect(invalid.status).toBe(400);

    const updated = await request(ui, "/api/settings", {
      method: "PUT",
      body: {
        values: {
          "workflow.maxWayfindingTurnsPerEpisode": 10,
        },
      },
    });
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as {
      appliesTo: string;
      settings: { values: Record<string, number> };
    };
    expect(updatedBody.appliesTo).toBe("new_runs");
    expect(updatedBody.settings.values["workflow.maxWayfindingTurnsPerEpisode"]).toBe(10);
    expect(await readFile(configPath, "utf8")).toContain(
      "maxWayfindingTurnsPerEpisode: 10",
    );

    const bootstrap = await request(ui, "/api/bootstrap");
    const bootstrapBody = (await bootstrap.json()) as {
      project: { settings: { values: Record<string, number> } };
    };
    expect(
      bootstrapBody.project.settings.values["workflow.maxWayfindingTurnsPerEpisode"],
    ).toBe(10);
  });

  it("lets an explicitly resumed restored run rebuild knowledge before advancing", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root);
    const backend = createFakeBackend({
      navigator: () => ({
        summary: "Needs a decision",
        destination: "A recovered route",
        notes: [],
        tickets: [
          {
            id: "recovery-choice",
            title: "Confirm recovery",
            question: {
              prompt: "Should the recovered run continue?",
              context: "The dashboard was restarted before this route was charted.",
              options: [
                {
                  id: "continue",
                  label: "Continue",
                  description: "Resume charting the route.",
                },
                {
                  id: "cancel",
                  label: "Cancel",
                  description: "Leave the recovered route paused.",
                },
              ],
              recommendedOptionId: "continue",
              recommendation: "Continue the recovered run.",
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
    const started = await engine.start("Resume after dashboard restart", "restored-run", false);
    expect(started.phase).toBe("new");

    ui = await startUiServer({ config, backend, port: 0, token: "ui-test" });
    const resumed = await request(ui, `/api/runs/${started.runId}/actions`, {
      method: "POST",
      body: { action: "resume" },
    });
    expect(resumed.status).toBe(202);
    expect((await resumed.json()) as { job: { action: string } }).toMatchObject({
      job: { action: "resume run" },
    });

    const detail = await waitForPhase(ui, started.runId, "awaiting_input");
    expect(detail.state.map.destination).toBe("A recovered route");
  });

  it("runs the HITL workflow, exposes artifacts, and searches local knowledge", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      agent: { promptBuilder: false } as never,
      workflow: { tdd: false } as never,
    });
    const backend = createFakeBackend({
      navigator: () => ({
        summary: "One preference remains",
        destination: "A dashboard-driven feature",
        notes: [],
        tickets: [
          {
            id: "tone",
            title: "Choose interface tone",
            question: {
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
      "decision-facilitator": (request) => {
        expect(request.prompt).toContain("Quiet and focused");
        return {
          status: "resolved",
          summary: "Use a quiet interface",
          resolution: "The interface should be quiet and focused.",
          newTickets: [],
          newFog: [],
          clearFog: [],
          outOfScope: [],
          routeClear: true,
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
    const page = await fetch(`${ui.origin}/?token=ui-test`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Wayfinder Control");

    const created = await request(ui, "/api/runs", {
      method: "POST",
      body: { idea: "Build it from one dashboard", tdd: false },
    });
    expect(created.status).toBe(202);
    const createdBody = (await created.json()) as { run: { runId: string } };
    const runId = createdBody.run.runId;

    let detail = await waitForPhase(ui, runId, "awaiting_input");
    const question = detail.state.questions.find(
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
    expect(detail.artifacts).toContain("map.md");
    expect(detail.artifacts.some((artifact: string) => artifact.startsWith("issues/"))).toBe(true);

    const facilitatorSession = detail.sessions.find(
      (session: { role: string }) => session.role === "decision-facilitator",
    );
    const inspected = await request(
      ui,
      `/api/runs/${runId}/session?path=${encodeURIComponent(facilitatorSession.path)}`,
    );
    expect(inspected.status).toBe(200);
    const inspection = (await inspected.json()) as {
      inputPrompt: string;
      inputSource: string;
      packet: { role: string };
      session: { output: { summary: string } };
    };
    expect(inspection.inputSource).toBe("stored exact input");
    expect(inspection.inputPrompt).toContain("decision-facilitator");
    expect(inspection.packet.role).toBe("decision-facilitator");
    expect(inspection.session.output.summary).toBe("Use a quiet interface");

    const storedSessionPath = path.join(
      root,
      ".agent-harness",
      "runs",
      runId,
      facilitatorSession.path,
    );
    const historicalSession = JSON.parse(
      await readFile(storedSessionPath, "utf8"),
    ) as Record<string, unknown>;
    delete historicalSession.prompt;
    await writeFile(storedSessionPath, JSON.stringify(historicalSession), "utf8");
    const historicalInspection = await request(
      ui,
      `/api/runs/${runId}/session?path=${encodeURIComponent(facilitatorSession.path)}`,
    );
    const historicalBody = (await historicalInspection.json()) as {
      inputPrompt: string;
      inputSource: string;
    };
    expect(historicalBody.inputSource).toBe("reconstructed deterministic input");
    expect(historicalBody.inputPrompt).toContain("decision-facilitator");

    const map = await request(
      ui,
      `/api/runs/${runId}/artifact?path=${encodeURIComponent("map.md")}`,
    );
    expect(((await map.json()) as { content: string }).content).toContain(
      "Use a quiet interface",
    );

    const search = await request(ui, "/api/knowledge/search", {
      method: "POST",
      body: { query: "quiet interface" },
    });
    const searchBody = (await search.json()) as { results: Array<{ source: string }> };
    // Run sync writes artifacts to disk but does not index them into knowledge.
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
  options: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`${ui.origin}${pathname}`, {
    method: options.method,
    headers: {
      "X-Harness-Token": ui.token,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

async function waitForPhase(
  ui: UiServer,
  runId: string,
  phase: string,
): Promise<any> {
  const deadline = Date.now() + 10_000;
  let latest: any;
  while (Date.now() < deadline) {
    const response = await request(ui, `/api/runs/${runId}`);
    latest = await response.json();
    if (latest.state?.phase === phase && !latest.job) return latest;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out waiting for ${phase}; latest=${JSON.stringify(latest)}`);
}
