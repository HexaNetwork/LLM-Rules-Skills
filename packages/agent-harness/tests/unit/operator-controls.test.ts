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
      workflow: { tdd: false } as never,
      agent: { promptBuilder: false } as never,
    });
    const engine = new HarnessEngine(config, { backend });
    let state = await engine.start("Ship greeting");
    state = await engine.advance(state.runId);
    const reflectQ = state.questions.find((item) => item.status === "open");
    expect(reflectQ).toBeDefined();
    state = await engine.answerMany(state.runId, [
      { questionId: reflectQ!.id, answer: REFLECT_OUTPUT.restatement },
    ]);
    state = await engine.advance(state.runId);
    expect(state.phase).toBe("awaiting_input");
    expect(state.grillReady?.summary).toBeTruthy();
    state = await engine.confirmGrill(state.runId);
    state = await engine.advance(state.runId);
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
      failure: "Implementer left the tree in a broken state",
    });
    await store.writeJson(runId, "config.json", { ...config, configVersion: CONFIG_VERSION });
    let fixerCalls = 0;
    const backend = createFakeBackend({
      fixer: () => {
        fixerCalls += 1;
        return fixerCalls === 1
          ? {
            summary: "Repair the broken implementer output.",
            steps: [{ title: "Restore files", description: "Revert the broken paths." }],
            risks: ["The run should be retried after the repair."],
            allowedPaths: ["src/app.ts"],
            validationCommands: [],
          }
          : { summary: "Restored the broken files.", changedFiles: ["src/app.ts"] };
      },
    });
    const engine = new HarnessEngine(config, { backend });

    await expect(engine.applyApprovedFix(runId)).rejects.toThrow(/no fixer plan awaiting approval/);
    const proposed = await engine.proposeFix(runId, "Repair the broken implementer output.");
    expect(proposed.phase).toBe("blocked");
    expect(proposed.fixerRecovery).toMatchObject({ role: "fixer", status: "proposed", changedFiles: [] });
    const applied = await engine.applyApprovedFix(runId);
    expect(applied.phase).toBe("executing");
    expect(applied.failure).toBeUndefined();
    expect(applied.fixerRecovery).toMatchObject({
      role: "fixer",
      status: "applied",
      result: "Restored the broken files.",
    });
  });

  it("uses the config-fixer's validated recommendation without accepting a caller patch", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { tdd: true, testPathPatterns: ["tests/**"] } as never,
      agent: { promptBuilder: false } as never,
    });
    const store = new RunStore(config);
    await store.initialize();
    const runId = "config-fixer-run";
    const hash = configurationHash(config);
    await store.create({
      ...createRunState(runId, "idea", new Date().toISOString(), hash, CONFIG_VERSION),
      phase: "blocked",
      blockedFrom: "executing",
      blockedKind: "config",
      blockedRetriable: false,
      failure: "Test writer changed non-test paths: sample-app/tests/recovery.test.ts",
    });
    await store.writeJson(runId, "config.json", { ...config, configVersion: CONFIG_VERSION });
    let configFixerCalls = 0;
    let fixerCalls = 0;
    const backend = createFakeBackend({
      "config-fixer": () => {
        configFixerCalls += 1;
        return {
          summary: "Widen test path patterns to include the written test.",
          configPatch: { workflow: { testPathPatterns: ["tests/**", "sample-app/tests/**"] } },
        };
      },
      fixer: () => {
        fixerCalls += 1;
        return { summary: "should not run", changedFiles: [] };
      },
    });
    const engine = new HarnessEngine(config, { backend });

    const proposed = await engine.proposeFix(runId, "Preserve the test and widen patterns.");
    expect(proposed.fixerRecovery).toMatchObject({
      role: "config-fixer",
      status: "proposed",
      plan: {
        summary: "Widen test path patterns to include the written test.",
        configPatch: { workflow: { testPathPatterns: ["tests/**", "sample-app/tests/**"] } },
      },
    });
    expect(configFixerCalls).toBe(1);
    expect(fixerCalls).toBe(0);

    const applied = await engine.applyApprovedFix(runId);
    expect(applied.phase).toBe("executing");
    expect(applied.failure).toBeUndefined();
    expect(applied.fixerRecovery).toMatchObject({ role: "config-fixer", status: "applied" });
    expect(fixerCalls).toBe(0);
    expect(configFixerCalls).toBe(1);

    const frozen = (await engine.store.readJson(runId, "config.json")) as {
      workflow: { testPathPatterns: string[] };
    };
    expect(frozen.workflow.testPathPatterns).toEqual(["tests/**", "sample-app/tests/**"]);
    const events = await engine.store.readText(runId, "events.jsonl");
    expect(events).toContain("run.config_repaired");
    expect(events).toContain("fixer.applied");
  });

  it("routes Test writer non-test-path failures to config-fixer even when blockedKind is internal", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { tdd: true, testPathPatterns: ["tests/**"] } as never,
      agent: { promptBuilder: false } as never,
    });
    const store = new RunStore(config);
    await store.initialize();
    const runId = "misclassified-config";
    const hash = configurationHash(config);
    await store.create({
      ...createRunState(runId, "idea", new Date().toISOString(), hash, CONFIG_VERSION),
      phase: "blocked",
      blockedFrom: "executing",
      blockedKind: "internal",
      blockedRetriable: false,
      failure:
        "Test writer changed non-test paths: civcraft/src/main/test/com/avrgaming/civcraft/civilization/town/BuildFootprintTest.java",
    });
    await store.writeJson(runId, "config.json", { ...config, configVersion: CONFIG_VERSION });
    let configFixerCalls = 0;
    let fixerCalls = 0;
    const backend = createFakeBackend({
      "config-fixer": () => {
        configFixerCalls += 1;
        return {
          summary: "Recognize CivCraft nested test roots.",
          configPatch: {
            workflow: {
              testPathPatterns: ["tests/**", "**/src/main/test/**"],
            },
          },
        };
      },
      fixer: () => {
        fixerCalls += 1;
        return {
          summary: "should not run",
          steps: [{ title: "noop", description: "noop" }],
          risks: [],
          allowedPaths: ["agent-harness.config.yaml"],
          validationCommands: [],
        };
      },
    });
    const engine = new HarnessEngine(config, { backend });

    const proposed = await engine.proposeFix(runId, "Recognize the nested test directory.");
    expect(proposed.fixerRecovery?.role).toBe("config-fixer");
    expect(configFixerCalls).toBe(1);
    expect(fixerCalls).toBe(0);

    const applied = await engine.applyApprovedFix(runId);
    expect(applied.phase).toBe("executing");
    expect(engine.config.workflow.testPathPatterns).toEqual(["tests/**", "**/src/main/test/**"]);
    const frozen = (await engine.store.readJson(runId, "config.json")) as {
      workflow: { testPathPatterns: string[] };
    };
    expect(frozen.workflow.testPathPatterns).toEqual(["tests/**", "**/src/main/test/**"]);
  });

  it("rejects applying a file-fixer plan against a config-shaped failure", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { tdd: true, testPathPatterns: ["tests/**"] } as never,
      agent: { promptBuilder: false } as never,
    });
    const store = new RunStore(config);
    await store.initialize();
    const runId = "wrong-fixer-role";
    const hash = configurationHash(config);
    await store.create({
      ...createRunState(runId, "idea", new Date().toISOString(), hash, CONFIG_VERSION),
      phase: "blocked",
      blockedFrom: "executing",
      blockedKind: "internal",
      blockedRetriable: false,
      failure: "Test writer changed non-test paths: app/src/main/test/ThingTest.java",
      fixerRecovery: {
        role: "fixer",
        guidance: "fix the yaml",
        failure: "Test writer changed non-test paths: app/src/main/test/ThingTest.java",
        plan: {
          summary: "Edit project yaml only",
          steps: [{ title: "Edit yaml", description: "Add a pattern" }],
          risks: [],
          allowedPaths: ["agent-harness.config.yaml"],
          validationCommands: [],
        },
        status: "proposed",
        proposedAt: new Date().toISOString(),
        changedFiles: [],
      },
    });
    await store.writeJson(runId, "config.json", { ...config, configVersion: CONFIG_VERSION });
    const engine = new HarnessEngine(config, { backend: createFakeBackend({}) });

    await expect(engine.applyApprovedFix(runId)).rejects.toThrow(/config-fixer repair that updates the frozen run config/);
  });
});
