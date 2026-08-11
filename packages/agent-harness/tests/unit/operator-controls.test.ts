import { describe, expect, it } from "vitest";
import { resolveHarnessPaths } from "../../src/application/paths.js";
import { createFakeBackend } from "../../src/agent.js";
import { CONFIG_VERSION, configurationHash } from "../../src/config.js";
import { HarnessEngine } from "../../src/engine.js";
import { createRunState } from "../../src/domain.js";
import { RunStore } from "../../src/store.js";
import {
  createPlannerPrdSequence,
  fixtureConfig,
  fixtureRoot,
  HIGH_LEVEL_PLAN,
  SLICER_ONE_TASK,
} from "../helpers.js";

const REFLECT_OUTPUT = {
  proposedTitle: "Add greeting tone",
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
    const planner = createPlannerPrdSequence(HIGH_LEVEL_PLAN);
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
      griller: () => ({
        status: "ready_to_plan",
        summary: "Ready",
        resolutions: [],
      }),
      planner: planner.planner,
      "issue-slicer": () => PLAN_WITH_INSTALLS,
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
    expect(state.verificationReady?.summary).toBeTruthy();
    state = await engine.confirmVerification(state.runId, {
      patch: state.verificationReady!.proposedPatch,
    });
    state = await engine.advance(state.runId);
    expect(state.phase).toBe("awaiting_input");
    expect(state.planReady?.summary).toBeTruthy();
    expect(state.tasks).toHaveLength(0);

    state = await engine.confirmPlan(state.runId);
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

  it("edit+approve plan and feedback replan keep tasks absent until slicer", async () => {
    const root = await fixtureRoot();
    const planner = createPlannerPrdSequence({
      ...HIGH_LEVEL_PLAN,
      summary: "Revised plan",
    });
    const retainedSessions: string[] = [];
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
      griller: () => ({
        status: "ready_to_plan",
        summary: "Ready",
        resolutions: [],
      }),
      planner: (request) => {
        if (request.providerSessionId) retainedSessions.push(request.providerSessionId);
        return planner.planner(request);
      },
      "issue-slicer": (request) => {
        expect(request.providerSessionId).toBeUndefined();
        return SLICER_ONE_TASK;
      },
    });
    const config = fixtureConfig(root, {
      workflow: { tdd: false } as never,
      agent: { promptBuilder: false } as never,
    });
    const engine = new HarnessEngine(config, { backend });
    let state = await engine.start("Ship greeting");
    state = await engine.advance(state.runId);
    state = await engine.answerMany(state.runId, [
      { questionId: state.activeQuestionId!, answer: REFLECT_OUTPUT.restatement },
    ]);
    state = await engine.advance(state.runId);
    state = await engine.confirmGrill(state.runId);
    state = await engine.advance(state.runId);
    state = await engine.confirmVerification(state.runId, {
      patch: state.verificationReady!.proposedPatch,
    });
    state = await engine.advance(state.runId);
    expect(state.planReady).toBeTruthy();

    state = await engine.confirmPlan(state.runId, {
      feedback: "Tighten the approach",
    });
    expect(state.planReady).toBeUndefined();
    expect(state.plan).toBeUndefined();
    expect(state.tasks).toHaveLength(0);
    expect(state.phase).toBe("planning");

    state = await engine.advance(state.runId);
    expect(state.planReady).toBeTruthy();
    expect(state.tasks).toHaveLength(0);

    state = await engine.confirmPlan(state.runId, {
      plan: {
        ...HIGH_LEVEL_PLAN,
        summary: "Edited by operator",
        approach: "Operator-edited approach",
      },
    });
    expect(state.plan?.summary).toBe("Edited by operator");
    state = await engine.advance(state.runId);
    expect(state.prd).toBeTruthy();
    expect(state.tasks).toHaveLength(1);
    expect(state.plannerEpisode?.closedAt).toBeTruthy();
    expect(retainedSessions.length).toBeGreaterThan(0);
  });

  it("requestStop sets stoppedAfterTaskAt when no task is active", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { tdd: false } as never,
      agent: { promptBuilder: false } as never,
    });
    const store = new RunStore(config, resolveHarnessPaths(config).stateRoot);
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
    const store = new RunStore(config, resolveHarnessPaths(config).stateRoot);
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

  it("setRag and setGraphify rewrite frozen run policy independently", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { tdd: true, rag: true } as never,
      agent: { promptBuilder: false } as never,
      knowledge: {
        ...fixtureConfig(root).knowledge,
        graphify: { ...fixtureConfig(root).knowledge.graphify, enabled: true },
      },
    });
    const store = new RunStore(config, resolveHarnessPaths(config).stateRoot);
    await store.initialize();
    const runId = "rag-graphify-run";
    const hash = configurationHash(config);
    await store.create({
      ...createRunState(runId, "idea", new Date().toISOString(), hash, CONFIG_VERSION),
      phase: "executing",
      tasks: [],
    });
    await store.writeJson(runId, "config.json", { ...config, configVersion: CONFIG_VERSION });
    const engine = new HarnessEngine(config, { backend: createFakeBackend({}) });

    await engine.setRag(runId, false);
    const afterRag = (await store.readJson(runId, "config.json")) as {
      workflow: { rag: boolean };
      knowledge: { graphify: { enabled: boolean } };
    };
    expect(afterRag.workflow.rag).toBe(false);
    expect(afterRag.knowledge.graphify.enabled).toBe(true);
    expect(engine.config.workflow.rag).toBe(false);

    await engine.setGraphify(runId, false);
    const afterBoth = (await store.readJson(runId, "config.json")) as {
      workflow: { rag: boolean };
      knowledge: { graphify: { enabled: boolean } };
    };
    expect(afterBoth.workflow.rag).toBe(false);
    expect(afterBoth.knowledge.graphify.enabled).toBe(false);
    expect(engine.config.knowledge.graphify.enabled).toBe(false);

    await expect(engine.setRag(runId, false)).resolves.toMatchObject({ runId });
  });

  it("requires an approved fixer plan before clearing a blocked run", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, { agent: { promptBuilder: false } as never });
    const store = new RunStore(config, resolveHarnessPaths(config).stateRoot);
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
    const fixerSessionIds: Array<string | undefined> = [];
    const backend = createFakeBackend({
      fixer: (request) => {
        fixerCalls += 1;
        fixerSessionIds.push(request.providerSessionId);
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
    expect(proposed.fixerRecovery?.providerSessionId).toBeTruthy();
    expect(fixerSessionIds[0]).toBeUndefined();

    const applied = await engine.applyApprovedFix(runId);
    expect(applied.phase).toBe("executing");
    expect(applied.failure).toBeUndefined();
    expect(applied.fixerRecovery).toMatchObject({
      role: "fixer",
      status: "applied",
      result: "Restored the broken files.",
    });
    expect(fixerCalls).toBe(2);
    expect(fixerSessionIds[1]).toBe(proposed.fixerRecovery?.providerSessionId);
    expect(applied.fixerRecovery?.providerSessionId).toBe(proposed.fixerRecovery?.providerSessionId);

    const sessionFiles = (await store.listFiles(runId, "sessions")).filter((file) => file.endsWith(".json"));
    const sessions = await Promise.all(
      sessionFiles.map(async (file) => store.readJson(runId, file) as Promise<{
        role?: string;
        providerSessionReused?: boolean;
        invocationKind?: string;
      }>),
    );
    const fixerSessions = sessions.filter((session) => session.role === "fixer");
    expect(fixerSessions).toHaveLength(2);
    expect(fixerSessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerSessionReused: false, invocationKind: "initial" }),
      expect.objectContaining({ providerSessionReused: true, invocationKind: "continuation" }),
    ]));
  });

  it("starts a fresh fixer context when the operator revises the plan", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, { agent: { promptBuilder: false } as never });
    const store = new RunStore(config, resolveHarnessPaths(config).stateRoot);
    await store.initialize();
    const runId = "fixer-revise-run";
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
    const fixerRequests: Array<{ providerSessionId?: string }> = [];
    const released: string[] = [];
    const inner = createFakeBackend({
      fixer: (request) => {
        fixerCalls += 1;
        fixerRequests.push({ providerSessionId: request.providerSessionId });
        if (fixerCalls <= 2) {
          return {
            summary: fixerCalls === 1 ? "First plan" : "Revised plan",
            steps: [{ title: "Restore files", description: "Revert the broken paths." }],
            risks: [],
            allowedPaths: ["src/app.ts"],
            validationCommands: [],
          };
        }
        return { summary: "Applied revised plan.", changedFiles: ["src/app.ts"] };
      },
    });
    const backend = {
      ...inner,
      async release(providerSessionId: string) {
        released.push(providerSessionId);
        await inner.release?.(providerSessionId);
      },
    };
    const engine = new HarnessEngine(config, { backend });

    const first = await engine.proposeFix(runId, "Repair the broken implementer output.");
    const firstSession = first.fixerRecovery?.providerSessionId;
    expect(firstSession).toBeTruthy();

    const revised = await engine.proposeFix(runId, "Also clean up the leftover temp file.");
    const revisedSession = revised.fixerRecovery?.providerSessionId;
    expect(revisedSession).toBeTruthy();
    expect(revisedSession).not.toBe(firstSession);
    expect(released).toContain(firstSession!);
    expect(fixerRequests[1]?.providerSessionId).toBeUndefined();
    expect(revised.fixerRecovery?.plan.summary).toBe("Revised plan");

    const applied = await engine.applyApprovedFix(runId);
    expect(applied.phase).toBe("executing");
    expect(fixerCalls).toBe(3);
    expect(fixerRequests[2]?.providerSessionId).toBe(revisedSession);
    expect(applied.fixerRecovery?.result).toBe("Applied revised plan.");
  });

  it("uses the config-fixer's validated recommendation without accepting a caller patch", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { tdd: true, testPathPatterns: ["tests/**"] } as never,
      agent: { promptBuilder: false } as never,
    });
    const store = new RunStore(config, resolveHarnessPaths(config).stateRoot);
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
    expect(events).toContain("run.config_updated");
    expect(events).toContain("fixer.applied");
  });

  it("routes Test writer non-test-path failures to config-fixer even when blockedKind is internal", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { tdd: true, testPathPatterns: ["tests/**"] } as never,
      agent: { promptBuilder: false } as never,
    });
    const store = new RunStore(config, resolveHarnessPaths(config).stateRoot);
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
    const store = new RunStore(config, resolveHarnessPaths(config).stateRoot);
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
