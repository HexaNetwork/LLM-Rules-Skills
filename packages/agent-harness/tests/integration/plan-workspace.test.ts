import path from "node:path";
import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeBackend } from "../../src/infrastructure/agents/fake-backend.js";
import type { AgentRequest } from "../../src/infrastructure/agents/types.js";
import { WorkerHarnessRuntime } from "../../src/application/harness-engine.js";
import {
  createPlannerPrdSequence,
  HIGH_LEVEL_PLAN,
  SCENARIO_PLANNER_OUTPUT,
} from "../helpers.js";
import { createProjectFixture, type ProjectFixture } from "../testkit/project-fixture.js";
import { git as runGit } from "../testkit/git.js";

const REFLECT_OUTPUT = {
  proposedTitle: "Add greeting tone",
  summary: "Restated greeting feature",
  restatement: "Add a greeting feature with a chosen tone.",
  goal: "Ship a greeting users understand",
  users: ["end users"],
  inScope: ["tone choice", "greeting copy"],
  outOfScope: ["localization"],
  assumptions: ["English only"],
  unknowns: ["formal vs casual"]};

describe("plan() workspace guard", () => {
  let fixture: ProjectFixture | undefined;

  afterEach(async () => {
    if (fixture) {
      await fixture.cleanup();
      fixture = undefined;
    }
  });

  it("blocks on a dirty workspace before invoking the planner", async () => {
    fixture = await createProjectFixture({
      config: {
        git: { enabled: true } as never,
        workflow: { } as never,
        agent: { promptBuilder: false } as never}});
    await fixture.initGit();

    const requests: AgentRequest[] = [];
    const seq = createPlannerPrdSequence(HIGH_LEVEL_PLAN);
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
      griller: () => ({
        status: "ready_to_plan",
        summary: "Ready",
        resolutions: []}),
      planner: (request) => {
        requests.push(request);
        return seq.planner();
      },
      "scenario-planner": () => SCENARIO_PLANNER_OUTPUT});

    const engine = new WorkerHarnessRuntime(fixture.config, { backend });
    const planning = await reachPlanning(engine);

    await writeFile(path.join(engine.paths.workspaceRoot, "package-lock.json"), "{}\n", "utf8");

    const blocked = await engine.advance(planning.runId);
    expect(blocked.phase).toBe("blocked");
    expect(blocked.blockedFrom).toBe("planning");
    expect(blocked.blockedKind).toBe("workspace");
    expect(blocked.failure).toMatch(/dirty working tree/i);
    expect(blocked.failure).toContain("package-lock.json");
    expect(requests.filter((request) => request.role === "planner")).toHaveLength(0);
    expect(blocked.tasks).toHaveLength(0);
  });

  it("persists the plan when the planner dirties the workspace, and retry continues the cold path", async () => {
    fixture = await createProjectFixture({
      config: {
        git: { enabled: true } as never,
        workflow: { } as never,
        agent: { promptBuilder: false } as never}});
    await fixture.initGit();

    let plannerCalls = 0;
    let workspaceRoot = "";
    const seq = createPlannerPrdSequence(HIGH_LEVEL_PLAN);
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
      griller: () => ({
        status: "ready_to_plan",
        summary: "Ready",
        resolutions: []}),
      planner: async (request) => {
        plannerCalls += 1;
        workspaceRoot = request.cwd;
        // Only the high-level plan step dirties the tree; PRD continuation must stay clean.
        const text = `${request.prompt ?? ""}\n${request.continuationPrompt ?? ""}`;
        const isPrd = /local PRD|user stories|Expand the approved high-level plan/i.test(text);
        if (!isPrd) {
          await writeFile(
            path.join(request.cwd, "package-lock.json"),
            `{"lockfileVersion":${plannerCalls}}\n`,
            "utf8",
          );
        }
        return seq.planner(request);
      },
      "scenario-planner": () => SCENARIO_PLANNER_OUTPUT});

    const engine = new WorkerHarnessRuntime(fixture.config, { backend });
    const planning = await reachPlanning(engine);
    const runId = planning.runId;

    const blocked = await engine.advance(runId);
    expect(blocked.phase).toBe("blocked");
    // High-level plan persists in planning; gate opens only after PRD + scenarios.
    expect(blocked.blockedFrom).toBe("planning");
    expect(blocked.blockedKind).toBe("workspace");
    expect(blocked.failure).toContain("package-lock.json");
    expect(blocked.planReady).toBeUndefined();
    expect(blocked.plan?.summary).toBe(HIGH_LEVEL_PLAN.summary);
    expect(blocked.tasks).toHaveLength(0);
    expect(plannerCalls).toBe(1);

    const events = (await engine.store.readText(runId, "events.jsonl"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.some((event) => event.type === "plan.created")).toBe(true);

    // Operator clears the dirty workspace the planner left behind.
    await runGit(workspaceRoot, "add", "--all");
    await runGit(workspaceRoot, "commit", "-m", "chore: accept planner side effect");

    await engine.retry(runId);
    const resumed = await engine.advance(runId);
    // Retry resumes planning cold path through PRD + scenarios to the bundled gate.
    expect(plannerCalls).toBe(2);
    expect(resumed.phase).toBe("awaiting_input");
    expect(resumed.planReady?.summary).toContain(HIGH_LEVEL_PLAN.summary);
    expect(resumed.prd).toBeTruthy();
    expect(resumed.scenarios.length).toBeGreaterThan(0);
    expect(resumed.tasks).toHaveLength(0);

    const after = (await engine.store.readText(runId, "events.jsonl"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string });
    expect(after.filter((event) => event.type === "plan.created")).toHaveLength(1);
  });
});

async function reachPlanning(engine: WorkerHarnessRuntime) {
  let state = await engine.start("Add a greeting feature");
  expect(state.phase).toBe("new");
  state = await engine.advance(state.runId);
  expect(state.phase).toBe("awaiting_input");
  const reflectId = state.activeQuestionId!;
  state = await engine.answer(state.runId, reflectId, "Confirmed brief: casual greeting.");
  expect(state.phase).toBe("grilling");
  // Grill → grillReady gate (awaiting_input). Confirm without advancing into plan().
  state = await engine.advance(state.runId);
  expect(state.phase).toBe("awaiting_input");
  expect(state.grillReady?.summary).toBeTruthy();
  state = await engine.confirmGrill(state.runId);
  expect(state.phase).toBe("planning");
  state = await engine.advance(state.runId);
  expect(state.verificationReady?.summary).toBeTruthy();
  state = await engine.confirmVerification(state.runId, {
    patch: state.verificationReady!.proposedPatch});
  expect(state.phase).toBe("planning");
  return state;
}
