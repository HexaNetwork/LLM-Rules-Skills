import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeBackend, stepPersistenceLimits } from "../../src/agent.js";
import { HarnessEngine } from "../../src/engine.js";
import { startUiServer, type UiServer } from "../../src/ui/server.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

const exec = promisify(execFile);

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
    expect(initialBody.settings.definitions).toHaveLength(5);
    expect(initialBody.settings.values["workflow.maxGrillQuestionsPerEpisode"]).toBe(5);
    expect(initialBody.settings.values["workflow.staleAnswerMinutes"]).toBe(30);
    expect(initialBody.settings.values["workflow.grillQuestionsPerBatch"]).toBe(3);
    expect(initialBody.settings.values["git.autoCommitPreflight"]).toBe(false);
    expect(initialBody.settings.values["git.preflightCommitOrder"]).toBe("branch-then-commit");

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

    const updatedGit = await request(ui, "/api/settings", {
      method: "PUT",
      body: {
        values: {
          "workflow.maxGrillQuestionsPerEpisode": 10,
          "workflow.staleAnswerMinutes": 45,
          "git.autoCommitPreflight": true,
          "git.preflightCommitOrder": "commit-then-branch",
        },
      },
    });
    expect(updatedGit.status).toBe(200);
    const updatedGitBody = (await updatedGit.json()) as {
      settings: { values: Record<string, unknown> };
    };
    expect(updatedGitBody.settings.values["git.autoCommitPreflight"]).toBe(true);
    expect(updatedGitBody.settings.values["git.preflightCommitOrder"]).toBe("commit-then-branch");

    const invalidOrder = await request(ui, "/api/settings", {
      method: "PUT",
      body: {
        values: {
          "workflow.maxGrillQuestionsPerEpisode": 10,
          "workflow.staleAnswerMinutes": 45,
          "git.preflightCommitOrder": "sideways",
        },
      },
    });
    expect(invalidOrder.status).toBe(400);
  });

  it("reports unchanged for a matching ?since= signature and a fresh payload after a transition", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root);
    const backend = createFakeBackend({ reflector: () => REFLECT_OUTPUT });
    const engine = new HarnessEngine(config, { backend });
    const started = await engine.start("Poll for changes", "poll-run", false);

    ui = await startUiServer({ config, backend, port: 0, token: "ui-test" });
    const first = await request(ui, `/api/runs/${started.runId}`);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { signature: string; state: { phase: string } };
    expect(firstBody.signature).toBeTruthy();

    const stillUnchanged = await request(
      ui,
      `/api/runs/${started.runId}?since=${encodeURIComponent(firstBody.signature)}`,
    );
    expect(stillUnchanged.status).toBe(200);
    const unchangedBody = (await stillUnchanged.json()) as { unchanged?: boolean; signature: string };
    expect(unchangedBody.unchanged).toBe(true);
    expect(unchangedBody.signature).toBe(firstBody.signature);
    expect((unchangedBody as { state?: unknown }).state).toBeUndefined();

    await request(ui, `/api/runs/${started.runId}/actions`, {
      method: "POST",
      body: { action: "resume" },
    });
    const detail = await waitForPhase(ui, started.runId, "awaiting_input");
    const changed = await request(
      ui,
      `/api/runs/${started.runId}?since=${encodeURIComponent(firstBody.signature)}`,
    );
    const changedBody = (await changed.json()) as { unchanged?: boolean; signature: string; state: unknown };
    expect(changedBody.unchanged).toBeUndefined();
    expect(changedBody.signature).not.toBe(firstBody.signature);
    expect(changedBody.state).toBeTruthy();
    void detail;
  });

  it("appends agent steps to steps.jsonl and updates activity.json during a run", async () => {
    const root = await fixtureRoot();
    const runId = "live-activity-run";
    const config = fixtureConfig(root, {
      agent: { promptBuilder: false, timeoutMs: 10_000, schemaRepairAttempts: 0 } as never,
    });
    let releaseReflect!: () => void;
    const holdReflect = new Promise<void>((resolve) => {
      releaseReflect = resolve;
    });
    let midRunActivity: Record<string, unknown> | undefined;
    let midRunSteps = "";

    const backend = createFakeBackend({
      reflector: async (request) => {
        request.onStep?.({
          type: "toolCall",
          toolName: "readFile",
          summary: "readFile README.md",
        });
        const runDir = path.join(root, ".agent-harness", "runs", runId);
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          try {
            const activity = JSON.parse(
              await readFile(path.join(runDir, "activity.json"), "utf8"),
            ) as Record<string, unknown>;
            const { readdir } = await import("node:fs/promises");
            const sessionFiles = await readdir(path.join(runDir, "sessions"));
            const stepsFile = sessionFiles.find((name) => name.endsWith(".steps.jsonl"));
            if (stepsFile && Number(activity.stepCount) >= 1) {
              midRunActivity = activity;
              midRunSteps = await readFile(path.join(runDir, "sessions", stepsFile), "utf8");
              break;
            }
          } catch {
            // still writing
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await holdReflect;
        return REFLECT_OUTPUT;
      },
    });
    const engine = new HarnessEngine(config, { backend });
    await engine.start("Live activity", runId, false);
    ui = await startUiServer({ config, backend, port: 0, token: "ui-test" });

    const resume = request(ui, `/api/runs/${runId}/actions`, {
      method: "POST",
      body: { action: "resume" },
    });
    const readyDeadline = Date.now() + 5_000;
    while (!midRunSteps && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(midRunSteps.trim()).toBeTruthy();
    const stepLine = JSON.parse(midRunSteps.trim().split(/\r?\n/)[0]!) as Record<string, unknown>;
    expect(stepLine).toMatchObject({
      type: "toolCall",
      toolName: "readFile",
      summary: "readFile README.md",
    });
    expect(midRunActivity).toMatchObject({
      role: "reflector",
      lastStepSummary: "readFile README.md",
      stepCount: 1,
    });
    expect(midRunActivity?.sessionId).toBeTruthy();
    expect(midRunActivity?.model).toBeTruthy();
    expect(midRunActivity?.startedAt).toBeTruthy();
    expect(midRunActivity?.lastStepAt).toBeTruthy();

    releaseReflect();
    await resume;
    await waitForPhase(ui, runId, "awaiting_input");

    const sessionsDir = path.join(root, ".agent-harness", "runs", runId, "sessions");
    const { readdir } = await import("node:fs/promises");
    const stepsFile = (await readdir(sessionsDir)).find((name) => name.endsWith(".steps.jsonl"));
    expect(stepsFile).toBeTruthy();
    expect(await readFile(path.join(sessionsDir, stepsFile!), "utf8")).toContain("readFile README.md");
    await expect(readFile(path.join(root, ".agent-harness", "runs", runId, "activity.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("polls run detail while a multi-line steps.jsonl exists", async () => {
    const root = await fixtureRoot();
    const runId = "steps-jsonl-poll-run";
    const config = fixtureConfig(root, {
      agent: { promptBuilder: false, timeoutMs: 10_000, schemaRepairAttempts: 0 } as never,
    });
    let releaseReflect!: () => void;
    const holdReflect = new Promise<void>((resolve) => {
      releaseReflect = resolve;
    });
    const backend = createFakeBackend({
      reflector: async (request) => {
        request.onStep?.({ type: "thinkingMessage", summary: "thinkingMessage" });
        request.onStep?.({ type: "assistantMessage", summary: "assistantMessage" });
        request.onStep?.({
          type: "toolCall",
          toolName: "readFile",
          summary: "readFile README.md",
        });
        await holdReflect;
        return REFLECT_OUTPUT;
      },
    });
    const engine = new HarnessEngine(config, { backend });
    await engine.start("Poll with steps.jsonl", runId, false);
    ui = await startUiServer({ config, backend, port: 0, token: "ui-test" });

    const resume = request(ui, `/api/runs/${runId}/actions`, {
      method: "POST",
      body: { action: "resume" },
    });

    const sessionsDir = path.join(root, ".agent-harness", "runs", runId, "sessions");
    const { readdir } = await import("node:fs/promises");
    const deadline = Date.now() + 5_000;
    let stepsRaw = "";
    while (Date.now() < deadline) {
      try {
        const stepsFile = (await readdir(sessionsDir)).find((name) => name.endsWith(".steps.jsonl"));
        if (stepsFile) {
          stepsRaw = await readFile(path.join(sessionsDir, stepsFile), "utf8");
          if (stepsRaw.split(/\r?\n/).filter(Boolean).length >= 2) break;
        }
      } catch {
        // still writing
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(stepsRaw.split(/\r?\n/).filter(Boolean).length).toBeGreaterThanOrEqual(2);

    const midRun = await request(ui, `/api/runs/${runId}`);
    expect(midRun.status).toBe(200);
    const midBody = (await midRun.json()) as {
      error?: string;
      sessions: Array<{ path: string; role?: string }>;
    };
    expect(midBody.error).toBeUndefined();
    expect(midBody.sessions.every((session) => session.path.endsWith(".json"))).toBe(true);
    expect(midBody.sessions.some((session) => session.path.endsWith(".steps.jsonl"))).toBe(false);

    releaseReflect();
    await resume;
    await waitForPhase(ui, runId, "awaiting_input");
  });

  it("never persists raw tool args in steps.jsonl", async () => {
    const root = await fixtureRoot();
    const runId = "redact-args-run";
    const config = fixtureConfig(root, {
      agent: { promptBuilder: false, timeoutMs: 10_000, schemaRepairAttempts: 0 } as never,
    });
    const secret = "SUPER_SECRET_TOKEN_do_not_persist";
    const backend = createFakeBackend({
      reflector: async (request) => {
        // Deliberately pass a hostile extra `args` field — persistence must strip it.
        (request.onStep as ((step: Record<string, unknown>) => void) | undefined)?.({
          type: "toolCall",
          toolName: "write",
          summary: "write secrets.env",
          args: { path: "secrets.env", contents: secret },
        });
        return REFLECT_OUTPUT;
      },
    });
    const engine = new HarnessEngine(config, { backend });
    await engine.start("Redact args", runId, false);
    ui = await startUiServer({ config, backend, port: 0, token: "ui-test" });
    await request(ui, `/api/runs/${runId}/actions`, { method: "POST", body: { action: "resume" } });
    await waitForPhase(ui, runId, "awaiting_input");

    const { readdir } = await import("node:fs/promises");
    const sessionsDir = path.join(root, ".agent-harness", "runs", runId, "sessions");
    const stepsFile = (await readdir(sessionsDir)).find((name) => name.endsWith(".steps.jsonl"));
    expect(stepsFile).toBeTruthy();
    const raw = await readFile(path.join(sessionsDir, stepsFile!), "utf8");
    expect(raw).toContain("write secrets.env");
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain('"args"');
    expect(raw).not.toContain("contents");
  });

  it("stops appending to steps.jsonl once the line/byte cap is reached", async () => {
    const root = await fixtureRoot();
    const runId = "steps-cap-run";
    const previousLimits = { ...stepPersistenceLimits };
    stepPersistenceLimits.maxLines = 5;
    stepPersistenceLimits.maxBytes = 256 * 1024;
    try {
      const config = fixtureConfig(root, {
        agent: { promptBuilder: false, timeoutMs: 10_000, schemaRepairAttempts: 0 } as never,
      });
      const backend = createFakeBackend({
        reflector: async (request) => {
          for (let index = 0; index < 12; index += 1) {
            request.onStep?.({
              type: "toolCall",
              toolName: "readFile",
              summary: `readFile file-${index}.ts`,
            });
          }
          return REFLECT_OUTPUT;
        },
      });
      const engine = new HarnessEngine(config, { backend });
      await engine.start("Cap steps", runId, false);
      await engine.advance(runId);

      const { readdir } = await import("node:fs/promises");
      const sessionsDir = path.join(root, ".agent-harness", "runs", runId, "sessions");
      const stepsFile = (await readdir(sessionsDir)).find((name) => name.endsWith(".steps.jsonl"));
      expect(stepsFile).toBeTruthy();
      const raw = await readFile(path.join(sessionsDir, stepsFile!), "utf8");
      const lines = raw.split(/\r?\n/).filter(Boolean);
      expect(lines.length).toBeLessThanOrEqual(6);
      expect(lines.some((line) => line.includes('"type":"truncated"'))).toBe(true);
      expect(raw).toContain("file-4.ts");
      expect(raw).not.toContain("file-11.ts");
    } finally {
      stepPersistenceLimits.maxLines = previousLimits.maxLines;
      stepPersistenceLimits.maxBytes = previousLimits.maxBytes;
    }
  });

  it("changes the poll signature when only activity.json changes", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root);
    const backend = createFakeBackend({ reflector: () => REFLECT_OUTPUT });
    const engine = new HarnessEngine(config, { backend });
    const started = await engine.start("Activity signature", "activity-sig-run", false);
    ui = await startUiServer({ config, backend, port: 0, token: "ui-test" });

    const first = await request(ui, `/api/runs/${started.runId}`);
    const firstBody = (await first.json()) as { signature: string; activity?: unknown };
    expect(firstBody.signature).toBeTruthy();
    expect(firstBody.activity == null).toBe(true);

    const unchanged = await request(
      ui,
      `/api/runs/${started.runId}?since=${encodeURIComponent(firstBody.signature)}`,
    );
    expect(((await unchanged.json()) as { unchanged?: boolean }).unchanged).toBe(true);

    await engine.store.writeJson(started.runId, "activity.json", {
      sessionId: "sess-1",
      role: "implementer",
      model: "composer-2.5",
      startedAt: "2026-08-08T00:00:00.000Z",
      lastStepAt: "2026-08-08T00:00:05.000Z",
      lastStepSummary: "editing src/engine.ts",
      stepCount: 3,
    });

    const changed = await request(
      ui,
      `/api/runs/${started.runId}?since=${encodeURIComponent(firstBody.signature)}`,
    );
    const changedBody = (await changed.json()) as {
      unchanged?: boolean;
      signature: string;
      activity?: { stepCount?: number; lastStepSummary?: string };
    };
    expect(changedBody.unchanged).toBeUndefined();
    expect(changedBody.signature).not.toBe(firstBody.signature);
    expect(changedBody.activity).toMatchObject({
      stepCount: 3,
      lastStepSummary: "editing src/engine.ts",
    });

    const still = await request(
      ui,
      `/api/runs/${started.runId}?since=${encodeURIComponent(changedBody.signature)}`,
    );
    expect(((await still.json()) as { unchanged?: boolean }).unchanged).toBe(true);

    await engine.store.writeJson(started.runId, "activity.json", {
      sessionId: "sess-1",
      role: "implementer",
      model: "composer-2.5",
      startedAt: "2026-08-08T00:00:00.000Z",
      lastStepAt: "2026-08-08T00:00:06.000Z",
      lastStepSummary: "editing src/engine.ts",
      stepCount: 4,
    });
    const stepped = await request(
      ui,
      `/api/runs/${started.runId}?since=${encodeURIComponent(changedBody.signature)}`,
    );
    const steppedBody = (await stepped.json()) as { signature: string; activity?: { stepCount?: number } };
    expect(steppedBody.signature).not.toBe(changedBody.signature);
    expect(steppedBody.activity?.stepCount).toBe(4);
  });

  it("accepts the legacy single {questionId, answer} shape for the answer action", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, { workflow: { tdd: false } as never });
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
      griller: () => ({
        status: "ready_to_plan",
        summary: "Ready",
        resolutions: [
          { id: "tone", question: GRILL_QUESTION.prompt, answer: "Quiet", summary: "Quiet" },
        ],
      }),
      planner: () => ({
        summary: "One task",
        tasks: [
          {
            id: "dashboard",
            title: "Deliver dashboard",
            description: "Expose the feature.",
            acceptanceCriteria: ["Works"],
            blockedBy: [],
            tdd: false,
            testCommand: 'node -e "process.exit(0)"',
          },
        ],
      }),
      implementer: () => ({ summary: "Built", changedFiles: ["src/dashboard.ts"] }),
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "message-writer": () => ({ subject: "feat: dashboard", body: "ok" }),
    });
    ui = await startUiServer({ config, backend, port: 0, token: "ui-test" });

    const created = await request(ui, "/api/runs", {
      method: "POST",
      body: { idea: "Legacy answer shape", tdd: false },
    });
    const runId = ((await created.json()) as { run: { runId: string } }).run.runId;
    let detail = await waitForPhase(ui, runId, "awaiting_input");
    const question = detail.state.questions.find(
      (item: { id: string }) => item.id === detail.state.activeQuestionId,
    )!;

    const answered = await request(ui, `/api/runs/${runId}/actions`, {
      method: "POST",
      body: { action: "answer", questionId: question.id, answer: "Confirmed legacy shape." },
    });
    expect(answered.status).toBe(202);
    detail = await waitForPhase(ui, runId, "completed");
    expect(detail.state.tasks[0]?.status).toBe("done");
  });

  it("accepts a structured reflect payload through the batched answers[] shape and stores it as confirmedStructured", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root);
    const backend = createFakeBackend({ reflector: () => REFLECT_OUTPUT });
    const engine = new HarnessEngine(config, { backend });
    const started = await engine.start("Structured reflect edit", "structured-reflect-run", false);
    ui = await startUiServer({ config, backend, port: 0, token: "ui-test" });

    await request(ui, `/api/runs/${started.runId}/actions`, {
      method: "POST",
      body: { action: "resume" },
    });
    const detail = await waitForPhase(ui, started.runId, "awaiting_input");
    const question = detail.state.questions.find(
      (item: { id: string }) => item.id === detail.state.activeQuestionId,
    )!;
    expect(question.purpose).toBe("reflect");

    const editedStructured = {
      summary: "Edited restated summary",
      restatement: "The operator rewrote this restatement by hand.",
      goal: "Ship the edited goal",
      users: ["operators", "reviewers"],
      inScope: ["editable list scope"],
      outOfScope: [],
      assumptions: ["nothing implicit"],
      unknowns: [],
    };
    const answered = await request(ui, `/api/runs/${started.runId}/actions`, {
      method: "POST",
      body: {
        action: "answer",
        answers: [
          {
            questionId: question.id,
            answer: editedStructured.restatement,
            structured: editedStructured,
          },
        ],
      },
    });
    expect(answered.status).toBe(202);

    // The structured confirmation happens synchronously inside answerMany,
    // before advance runs, so poll state instead of pinning a transient phase.
    const deadline = Date.now() + 10_000;
    let confirmedStructured: { goal?: string } | undefined;
    let confirmedText: string | undefined;
    for (;;) {
      const response = await request(ui, `/api/runs/${started.runId}`);
      const body = (await response.json()) as {
        state?: { reflectBrief?: { confirmed?: string; confirmedStructured?: { goal?: string } } };
      };
      confirmedText = body.state?.reflectBrief?.confirmed;
      confirmedStructured = body.state?.reflectBrief?.confirmedStructured;
      if (confirmedStructured || Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(confirmedText).toContain("operator rewrote this restatement");
    expect(confirmedStructured?.goal).toBe("Ship the edited goal");
  });

  it("rejects an invalid structured reflect payload with a 400 instead of silently dropping it", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root);
    const backend = createFakeBackend({ reflector: () => REFLECT_OUTPUT });
    const engine = new HarnessEngine(config, { backend });
    const started = await engine.start("Invalid structured reflect edit", "invalid-structured-run", false);
    ui = await startUiServer({ config, backend, port: 0, token: "ui-test" });

    await request(ui, `/api/runs/${started.runId}/actions`, { method: "POST", body: { action: "resume" } });
    const detail = await waitForPhase(ui, started.runId, "awaiting_input");
    const question = detail.state.questions.find(
      (item: { id: string }) => item.id === detail.state.activeQuestionId,
    )!;

    const rejected = await request(ui, `/api/runs/${started.runId}/actions`, {
      method: "POST",
      body: {
        action: "answer",
        answers: [
          {
            questionId: question.id,
            answer: "Confirmed.",
            structured: { restatement: "missing required fields" },
          },
        ],
      },
    });
    expect(rejected.status).toBe(400);
  });

  it("records an operator note without requiring the run to be awaiting input", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root);
    const backend = createFakeBackend({ reflector: () => REFLECT_OUTPUT });
    const engine = new HarnessEngine(config, { backend });
    const started = await engine.start("Note taking", "note-run", false);
    ui = await startUiServer({ config, backend, port: 0, token: "ui-test" });

    const noted = await request(ui, `/api/runs/${started.runId}/actions`, {
      method: "POST",
      body: { action: "note", text: "Remember to check the pricing tier.", asUnknown: true },
    });
    expect(noted.status).toBe(202);

    const deadline = Date.now() + 5_000;
    let body: { state: { operatorNotes: Array<{ text: string }>; openUnknowns: Array<{ title: string }> } };
    for (;;) {
      const detail = await request(ui, `/api/runs/${started.runId}`);
      body = (await detail.json()) as typeof body;
      if (body.state.operatorNotes.length > 0 || Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(body!.state.operatorNotes[0]?.text).toContain("pricing tier");
    expect(body!.state.openUnknowns.some((item) => item.title.includes("pricing tier"))).toBe(true);
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
          questions: [GRILL_QUESTION],
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
  it("commit_preflight unblocks a dirty-tree run and advances with the fake backend", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);
    await writeFile(path.join(root, "surprise.txt"), "dirty\n", "utf8");

    const config = fixtureConfig(root, {
      git: { enabled: true, autoCommitPreflight: false } as never,
      workflow: { tdd: false } as never,
    });
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
      griller: () => ({
        status: "ready_to_plan",
        summary: "No grill needed",
        resolutions: [],
        openUnknowns: [],
      }),
      planner: () => ({
        summary: "One task",
        tasks: [
          {
            id: "dashboard",
            title: "Deliver dashboard",
            description: "Expose the feature.",
            acceptanceCriteria: ["Works"],
            blockedBy: [],
            tdd: false,
            testCommand: 'node -e "process.exit(0)"',
          },
        ],
      }),
      implementer: () => ({ summary: "Built", changedFiles: ["src/dashboard.ts"] }),
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "message-writer": () => ({ subject: "feat: dashboard", body: "ok" }),
    });
    const engine = new HarnessEngine(config, { backend });
    const blocked = await engine.start("Commit preflight via UI", "ui-commit-preflight", false);
    expect(blocked.phase).toBe("blocked");
    expect(blocked.blockedFrom).toBe("new");

    ui = await startUiServer({ config, backend, port: 0, token: "ui-test" });
    const accepted = await request(ui, `/api/runs/${blocked.runId}/actions`, {
      method: "POST",
      body: { action: "commit_preflight", order: "branch-then-commit" },
    });
    expect(accepted.status).toBe(202);

    const detail = await waitForPhase(ui, blocked.runId, "awaiting_input");
    expect(detail.state.phase).toBe("awaiting_input");
    expect(detail.state.questions[0]?.purpose).toBe("reflect");
  });

  it("includes git.currentBranch/baseBranch only for a blocked run, never for other phases", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);
    await writeFile(path.join(root, "surprise.txt"), "dirty\n", "utf8");

    const config = fixtureConfig(root, { git: { enabled: true } as never });
    const backend = createFakeBackend({});
    const engine = new HarnessEngine(config, { backend });
    const blocked = await engine.start("Report git branch", "git-payload-run", false);
    expect(blocked.phase).toBe("blocked");

    ui = await startUiServer({ config, backend, port: 0, token: "ui-test" });
    const blockedResponse = await request(ui, `/api/runs/${blocked.runId}`);
    const blockedBody = (await blockedResponse.json()) as {
      git?: { currentBranch?: string; baseBranch?: string };
    };
    expect(blockedBody.git).toEqual({ currentBranch: "main", baseBranch: "main" });

    // Same run, not blocked: the git subprocess must not run, so the key is absent.
    const nonBlockedConfig = fixtureConfig(root);
    const nonBlockedBackend = createFakeBackend({ reflector: () => REFLECT_OUTPUT });
    const nonBlockedEngine = new HarnessEngine(nonBlockedConfig, { backend: nonBlockedBackend });
    const started = await nonBlockedEngine.start("Not blocked", "git-payload-not-blocked", false);
    const otherUi = await startUiServer({
      config: nonBlockedConfig,
      backend: nonBlockedBackend,
      port: 0,
      token: "ui-test",
    });
    try {
      const nonBlockedResponse = await request(otherUi, `/api/runs/${started.runId}`);
      const nonBlockedBody = (await nonBlockedResponse.json()) as { git?: unknown };
      expect("git" in nonBlockedBody).toBe(false);
    } finally {
      await otherUi.close();
    }
  });
});

async function initGitRepo(root: string): Promise<void> {
  await git(root, "init");
  await git(root, "config", "user.email", "harness@example.com");
  await git(root, "config", "user.name", "Harness Test");
  await writeFile(path.join(root, ".gitignore"), ".agent-harness/\n", "utf8");
  await git(root, "add", "--all");
  await git(root, "commit", "-m", "initial");
  await git(root, "branch", "-M", "main");
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await exec("git", args, { cwd, windowsHide: true });
  return result.stdout;
}

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
