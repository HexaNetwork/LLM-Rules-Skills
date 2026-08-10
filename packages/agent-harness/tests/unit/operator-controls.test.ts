import { describe, expect, it } from "vitest";
import { createFakeBackend } from "../../src/agent.js";
import { CONFIG_VERSION, configurationHash } from "../../src/config.js";
import { HarnessEngine } from "../../src/engine.js";
import { createRunState } from "../../src/domain.js";
import { RunStore } from "../../src/store.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

const REFLECT_OUTPUT = {
  summary: "Restated",
  restatement: "Ship greeting.",
  goal: "Greet users",
  users: ["users"],
  inScope: ["greeting"],
  outOfScope: [],
  assumptions: [],
  unknowns: [],
};

const PLAN_WITH_INSTALLS = {
  summary: "Plan",
  tasks: [
    {
      id: "one",
      title: "First",
      description: "Do first",
      acceptanceCriteria: ["ok"],
      blockedBy: [] as string[],
      tdd: false,
    },
    {
      id: "two",
      title: "Second",
      description: "Do second",
      acceptanceCriteria: ["ok"],
      blockedBy: ["one"],
      tdd: false,
    },
  ],
  proposedInstalls: [
    {
      id: "deps",
      manager: "npm" as const,
      packages: ["left-pad"],
      reason: "Tiny helper used by the greeting",
    },
  ],
};

describe("operator controls", () => {
  it("amends only a blocked run's frozen config and records the reviewed policy change", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root);
    const engine = new HarnessEngine(config, { backend: createFakeBackend({}) });
    const started = await engine.start("recover test paths");
    const blocked = {
      ...started,
      phase: "blocked" as const,
      blockedFrom: "reflecting" as const,
      blockedKind: "contract" as const,
      blockedRetriable: false,
      failure: "Test writer changed a non-test path",
    };
    await engine.store.writeJson(started.runId, "state.json", blocked);

    const updated = await engine.amendConfig(started.runId, {
      workflow: { testPathPatterns: ["src/**/test/**"] },
    });

    expect(updated.phase).toBe("blocked");
    expect(updated.configurationHash).not.toBe(configurationHash(config));
    const frozen = (await engine.store.readJson(started.runId, "config.json")) as {
      workflow: { testPathPatterns: string[] };
    };
    expect(frozen.workflow.testPathPatterns).toEqual(["src/**/test/**"]);
    const events = await engine.store.readText(started.runId, "events.jsonl");
    expect(events).toContain("run.config_amended");
    expect(events).toContain("workflow.testPathPatterns");

    const active = { ...started, phase: "reflecting" as const };
    await engine.store.writeJson(started.runId, "state.json", active);
    await expect(
      engine.amendConfig(started.runId, { workflow: { testPathPatterns: ["tests/**"] } }),
    ).rejects.toThrow(/must be blocked/i);
  });

  it("gates on proposed installs then enters executing after deny-all", async () => {
    const root = await fixtureRoot();
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
      griller: () => ({
        status: "ready_to_plan",
        summary: "Ready",
        resolutions: [],
      }),
      planner: () => PLAN_WITH_INSTALLS,
    });
    const config = fixtureConfig(root, {
      workflow: { tdd: false, maxStepsPerRun: 20 } as never,
      agent: { promptBuilder: false } as never,
    });
    const engine = new HarnessEngine(config, { backend });
    let state = await engine.start("Ship greeting");
    state = await engine.advance(state.runId, 5);
    const reflectQ = state.questions.find((item) => item.status === "open");
    expect(reflectQ).toBeDefined();
    state = await engine.answerMany(state.runId, [
      { questionId: reflectQ!.id, answer: REFLECT_OUTPUT.restatement },
    ]);
    state = await engine.advance(state.runId, 10);
    expect(state.phase).toBe("awaiting_input");
    expect(state.grillReady?.summary).toBeTruthy();
    state = await engine.confirmGrill(state.runId);
    state = await engine.advance(state.runId, 10);
    expect(state.phase).toBe("awaiting_input");
    expect(state.proposedInstalls).toHaveLength(1);
    expect(state.tasks).toHaveLength(2);

    state = await engine.resolveInstalls(state.runId, {
      accepted: [],
      denied: ["deps"],
    });
    expect(state.proposedInstalls[0]?.decision).toBe("denied");
    expect(state.phase).toBe("executing");
  });

  it("requestStop sets stoppedAfterTaskAt when no task is active", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { tdd: false } as never,
      agent: { promptBuilder: false } as never,
    });
    const store = new RunStore(config);
    await store.initialize();
    const runId = "stop-run";
    const now = new Date().toISOString();
    const hash = configurationHash(config);
    await store.create({
      ...createRunState(runId, "idea", now, hash, CONFIG_VERSION),
      phase: "executing",
      tasks: [
        {
          id: "one",
          title: "First",
          description: "Done",
          acceptanceCriteria: ["ok"],
          affectedPaths: [],
          blockedBy: [],
          tdd: false,
          status: "done",
          step: "done",
          attempts: { tests: 0, implementation: 0, review: 0 },
          evidence: [],
          testPaths: [],
          changedFiles: [],
        },
        {
          id: "two",
          title: "Second",
          description: "Pending",
          acceptanceCriteria: ["ok"],
          affectedPaths: [],
          blockedBy: ["one"],
          tdd: false,
          status: "pending",
          step: "pending",
          attempts: { tests: 0, implementation: 0, review: 0 },
          evidence: [],
          testPaths: [],
          changedFiles: [],
        },
      ],
    });
    await store.writeJson(runId, "config.json", { ...config, configVersion: CONFIG_VERSION });
    const engine = new HarnessEngine(config, { backend: createFakeBackend({}) });
    const state = await engine.requestStop(runId);
    expect(state.stoppedAfterTaskAt).toBeTruthy();
    expect(state.phase).toBe("executing");
  });

  it("set_tdd updates pending tasks and refuses started ones", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { tdd: true } as never,
      agent: { promptBuilder: false } as never,
    });
    const store = new RunStore(config);
    await store.initialize();
    const runId = "tdd-run";
    const now = new Date().toISOString();
    const hash = configurationHash(config);
    await store.create({
      ...createRunState(runId, "idea", now, hash, CONFIG_VERSION),
      phase: "executing",
      tasks: [
        {
          id: "pending-task",
          title: "Pending",
          description: "Not started",
          acceptanceCriteria: ["ok"],
          affectedPaths: [],
          blockedBy: [],
          tdd: true,
          status: "pending",
          step: "pending",
          attempts: { tests: 0, implementation: 0, review: 0 },
          evidence: [],
          testPaths: [],
          changedFiles: [],
        },
        {
          id: "active-task",
          title: "Active",
          description: "Started",
          acceptanceCriteria: ["ok"],
          affectedPaths: [],
          blockedBy: [],
          tdd: true,
          status: "active",
          step: "implementing",
          attempts: { tests: 0, implementation: 1, review: 0 },
          evidence: [],
          testPaths: [],
          changedFiles: [],
        },
      ],
    });
    const frozenPatterns = ["tests/**"];
    await store.writeJson(runId, "config.json", {
      ...config,
      workflow: { ...config.workflow, testPathPatterns: frozenPatterns, tdd: true },
      configVersion: CONFIG_VERSION,
    });
    // Live engine config may already carry an overlay; rewriting frozen must not bake it in.
    const liveEngineConfig = {
      ...config,
      workflow: { ...config.workflow, testPathPatterns: ["modules/**/src/test/**"], tdd: true },
    };
    const engine = new HarnessEngine(liveEngineConfig, { backend: createFakeBackend({}) });

    const updated = await engine.setTdd(runId, false);
    expect(updated.tasks.find((task) => task.id === "pending-task")?.tdd).toBe(false);
    expect(updated.tasks.find((task) => task.id === "active-task")?.tdd).toBe(true);
    const rewritten = (await store.readJson(runId, "config.json")) as {
      workflow: { tdd: boolean; testPathPatterns: string[] };
    };
    expect(rewritten.workflow.tdd).toBe(false);
    expect(rewritten.workflow.testPathPatterns).toEqual(frozenPatterns);

    await expect(engine.setTdd(runId, false, "active-task")).rejects.toThrow(/Cannot change TDD/);
  });

  it("requires an approved fixer plan before clearing a blocked run", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, { agent: { promptBuilder: false } as never });
    const store = new RunStore(config);
    await store.initialize();
    const runId = "fixer-run";
    const hash = configurationHash(config);
    await store.create({
      ...createRunState(runId, "idea", new Date().toISOString(), hash, CONFIG_VERSION),
      phase: "blocked",
      blockedFrom: "executing",
      blockedKind: "internal",
      blockedRetriable: false,
      failure: "Test writer changed non-test paths: sample-app/tests/recovery.test.ts",
    });
    await store.writeJson(runId, "config.json", { ...config, configVersion: CONFIG_VERSION });
    let fixerCalls = 0;
    const backend = createFakeBackend({
      fixer: () => {
        fixerCalls += 1;
        return fixerCalls === 1
          ? {
            summary: "Classify the repository's test directory as a test path.",
            steps: [{ title: "Update test paths", description: "Add the project test folder glob in agent-harness.config.yaml." }],
            risks: ["The run should be retried after the configuration is corrected."],
            allowedPaths: ["agent-harness.config.yaml"],
            validationCommands: [],
          }
          : { summary: "Updated the recovery configuration.", changedFiles: ["agent-harness.config.yaml"] };
      },
    });
    const engine = new HarnessEngine(config, { backend });

    await expect(engine.applyApprovedFix(runId)).rejects.toThrow(/no fixer plan awaiting approval/);
    const proposed = await engine.proposeFix(runId, "Preserve the test and repair the test path configuration.");
    expect(proposed.phase).toBe("blocked");
    expect(proposed.fixerRecovery).toMatchObject({ status: "proposed", changedFiles: [] });
    const applied = await engine.applyApprovedFix(runId);
    expect(applied.phase).toBe("executing");
    expect(applied.failure).toBeUndefined();
    expect(applied.fixerRecovery).toMatchObject({
      status: "applied",
      result: "Updated the recovery configuration.",
    });
  });
});
