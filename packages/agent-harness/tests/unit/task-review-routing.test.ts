import { describe, expect, it } from "vitest";
import { createFakeBackend } from "../../src/infrastructure/agents/fake-backend.js";
import { CONFIG_VERSION, configurationHash } from "../../src/config/schema.js";
import { createRunState, type BuildTask, type RunState } from "../../src/domain.js";
import { WorkerHarnessRuntime } from "../../src/application/harness-engine.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

function reviewingTask(overrides: Partial<BuildTask> = {}): BuildTask {
  return {
    id: "greet",
    title: "Ship greeting",
    description: "Render greeting",
    acceptanceCriteria: ["Greeting is casual"],
    affectedPaths: ["src/greet.ts"],
    blockedBy: [],
    status: "active",
    step: "reviewing",
    attempts: { implementation: 1, review: 0 },
    evidence: [
      {
        purpose: "test",
        command: 'node -e "process.exit(0)"',
        exitCode: 0,
        passed: true,
        stdout: "",
        stderr: "",
        durationMs: 1,
        at: new Date().toISOString(),
      },
    ],
    testPaths: [],
    changedFiles: ["src/greet.ts"],
    ...overrides,
  };
}

async function seedReviewingRun(
  engine: WorkerHarnessRuntime,
  config: ReturnType<typeof fixtureConfig>,
  runId: string,
  task: BuildTask,
  phase: RunState["phase"] = "executing",
): Promise<RunState> {
  let state: RunState = {
    ...createRunState(runId, "idea", new Date().toISOString(), "hash", CONFIG_VERSION),
    phase,
    tasks: [task],
    reflectBrief: { draft: "d", confirmed: "confirmed", confirmedAt: new Date().toISOString() },
    configurationHash: configurationHash(config),
  };
  await engine.store.initialize();
  await engine.store.create(state);
  await engine.store.writeJson(state.runId, "state.json", state);
  await engine.store.writeJson(state.runId, "config.json", {
    ...config,
    configVersion: CONFIG_VERSION,
  });
  return state;
}

describe("task-reviewer routing", () => {
  it("invokes task-reviewer for per-task review", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, { agent: { promptBuilder: false } as never });
    const roles: string[] = [];
    const backend = createFakeBackend({
      "task-reviewer": (request) => {
        roles.push(request.role);
        return { approved: true, summary: "ok", findings: [] };
      },
      reviewer: (request) => {
        roles.push(request.role);
        return { approved: true, summary: "ok", findings: [] };
      },
    });
    const engine = new WorkerHarnessRuntime(config, { backend });
    const started = await seedReviewingRun(engine, config, "task-reviewer-role", reviewingTask());
    const state = await engine.advance(started.runId);
    expect(roles[0]).toBe("task-reviewer");
    expect(state.tasks[0]?.status).toBe("done");
    expect(state.tasks[0]?.step).toBe("done");
  });

  it("continues to commit when task review blocks only on scenario-intent", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, { agent: { promptBuilder: false } as never });
    const backend = createFakeBackend({
      "task-reviewer": () => ({
        approved: false,
        summary: "scenario not implemented",
        findings: [
          {
            severity: "blocking",
            kind: "scenario-intent",
            message: "Packet scenarioIds have no tests yet",
          },
        ],
      }),
    });
    const engine = new WorkerHarnessRuntime(config, { backend });
    const started = await seedReviewingRun(
      engine,
      config,
      "task-review-scenario-intent",
      reviewingTask(),
    );
    const state = await engine.advance(started.runId);
    expect(state.tasks[0]?.step).toBe("done");
    expect(state.tasks[0]?.status).toBe("done");
    expect(state.tasks[0]?.failure).toBeUndefined();
    const events = await engine.store.readText(started.runId, "events.jsonl");
    expect(events).toContain('"reviewRepairRoute":"scenario-intent"');
    expect(events).not.toContain("Review failed and repair budget is exhausted");
  });

  it("continues to commit when task review blocks only on test-coverage", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, { agent: { promptBuilder: false } as never });
    const backend = createFakeBackend({
      "task-reviewer": () => ({
        approved: false,
        summary: "missing tests",
        findings: [
          {
            severity: "blocking",
            kind: "test-coverage",
            message: "No new files matching test path patterns",
          },
        ],
      }),
    });
    const engine = new WorkerHarnessRuntime(config, { backend });
    const started = await seedReviewingRun(
      engine,
      config,
      "task-review-test-coverage",
      reviewingTask(),
    );
    const state = await engine.advance(started.runId);
    expect(state.tasks[0]?.step).toBe("done");
    expect(state.tasks[0]?.status).toBe("done");
    expect(state.tasks[0]?.failure).toBeUndefined();
    const events = await engine.store.readText(started.runId, "events.jsonl");
    expect(events).toContain('"reviewRepairRoute":"test-coverage"');
  });

  it("retries implementing when task review blocks on production and budget remains", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, { agent: { promptBuilder: false } as never });
    const backend = createFakeBackend({
      "task-reviewer": () => ({
        approved: false,
        summary: "null dereference",
        findings: [
          {
            severity: "blocking",
            kind: "production",
            message: "Handle null input",
          },
        ],
      }),
    });
    const engine = new WorkerHarnessRuntime(config, { backend });
    const started = await seedReviewingRun(
      engine,
      config,
      "task-review-production",
      reviewingTask(),
    );
    const state = await engine.advance(started.runId);
    expect(state.tasks[0]?.step).toBe("implementing");
    expect(state.tasks[0]?.status).toBe("active");
    expect(state.tasks[0]?.failure).toBeUndefined();
    const events = await engine.store.readText(started.runId, "events.jsonl");
    expect(events).toContain('"reviewRepairRoute":"production"');
  });

  it("returns task-review production findings to the retained implementer session", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, { agent: { promptBuilder: false } as never });
    let implementerProviderSessionId: string | undefined;
    let implementerContinuation = "";
    let reviewCalls = 0;
    const backend = createFakeBackend({
      "task-reviewer": () => {
        reviewCalls += 1;
        return reviewCalls === 1
          ? {
              approved: false,
              summary: "null dereference",
              findings: [
                {
                  severity: "blocking" as const,
                  kind: "production" as const,
                  message: "Handle null input",
                },
              ],
            }
          : { approved: true, summary: "fixed", findings: [] };
      },
      implementer: (request) => {
        implementerProviderSessionId = request.providerSessionId;
        implementerContinuation = request.continuationPrompt ?? "";
        return { summary: "repaired", changedFiles: ["src/greet.ts"] };
      },
    });
    const engine = new WorkerHarnessRuntime(config, { backend });
    const started = await seedReviewingRun(
      engine,
      config,
      "task-review-retained-implementer",
      reviewingTask({ implementerSession: { providerSessionId: "implementer-context-1" } }),
    );

    const repaired = await engine.advance(started.runId);

    expect(implementerProviderSessionId).toBe("implementer-context-1");
    expect(implementerContinuation).toContain("Handle null input");
    expect(repaired.tasks[0]?.status).toBe("done");
    expect(repaired.tasks[0]?.implementerSession).toBeUndefined();
  });

  it("invokes reviewer, not task-reviewer, during final_review", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, { agent: { promptBuilder: false } as never });
    const roles: string[] = [];
    const backend = createFakeBackend({
      "task-reviewer": (request) => {
        roles.push(request.role);
        return { approved: true, summary: "task ok", findings: [] };
      },
      reviewer: (request) => {
        roles.push(request.role);
        return { approved: true, summary: "final ok", findings: [] };
      },
    });
    const engine = new WorkerHarnessRuntime(config, { backend });
    const doneTask = reviewingTask({
      status: "done",
      step: "done",
    });
    const started = await seedReviewingRun(
      engine,
      config,
      "final-review-role",
      doneTask,
      "final_review",
    );
    await engine.advance(started.runId);
    expect(roles).toEqual(["reviewer"]);
  });
});
