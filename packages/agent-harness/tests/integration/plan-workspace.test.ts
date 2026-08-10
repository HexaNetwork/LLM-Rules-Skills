import { afterEach, describe, expect, it } from "vitest";
import { createFakeBackend, type AgentRequest } from "../../src/agent.js";
import { HarnessEngine } from "../../src/engine.js";
import { createProjectFixture, type ProjectFixture } from "../testkit/project-fixture.js";

const REFLECT_OUTPUT = {
  summary: "Restated greeting feature",
  restatement: "Add a greeting feature with a chosen tone.",
  goal: "Ship a greeting users understand",
  users: ["end users"],
  inScope: ["tone choice", "greeting copy"],
  outOfScope: ["localization"],
  assumptions: ["English only"],
  unknowns: ["formal vs casual"],
};

const PLAN_OUTPUT = {
  summary: "One task",
  tasks: [
    {
      id: "greet",
      title: "Ship greeting",
      description: "Render greeting.",
      acceptanceCriteria: ["Works"],
      blockedBy: [] as string[],
      tdd: false,
      testCommand: 'node -e "process.exit(0)"',
    },
  ],
};

describe("plan() workspace guard", () => {
  let fixture: ProjectFixture | undefined;

  afterEach(async () => {
    if (fixture) {
      await fixture.cleanup();
      fixture = undefined;
    }
  });

  it("blocks on a dirty tree before invoking the planner", async () => {
    fixture = await createProjectFixture({
      config: {
        git: { enabled: true } as never,
        workflow: { tdd: false } as never,
        agent: { promptBuilder: false } as never,
      },
    });
    await fixture.initGit();

    const requests: AgentRequest[] = [];
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
      griller: () => ({
        status: "ready_to_plan",
        summary: "Ready",
        resolutions: [],
      }),
      planner: (request) => {
        requests.push(request);
        return PLAN_OUTPUT;
      },
    });

    const engine = new HarnessEngine(fixture.config, { backend });
    const planning = await reachPlanning(engine);

    await fixture.write("package-lock.json", "{}\n");

    const blocked = await engine.advance(planning.runId);
    expect(blocked.phase).toBe("blocked");
    expect(blocked.blockedFrom).toBe("planning");
    expect(blocked.blockedKind).toBe("workspace");
    expect(blocked.failure).toMatch(/dirty working tree/i);
    expect(blocked.failure).toContain("package-lock.json");
    expect(requests.filter((request) => request.role === "planner")).toHaveLength(0);
    expect(blocked.tasks).toHaveLength(0);
  });

  it("persists the plan when the planner dirties the tree, and retry skips re-planning", async () => {
    fixture = await createProjectFixture({
      config: {
        git: { enabled: true } as never,
        workflow: { tdd: false } as never,
        agent: { promptBuilder: false } as never,
      },
    });
    await fixture.initGit();

    let plannerCalls = 0;
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
      griller: () => ({
        status: "ready_to_plan",
        summary: "Ready",
        resolutions: [],
      }),
      planner: async () => {
        plannerCalls += 1;
        await fixture!.write(
          "package-lock.json",
          `{"lockfileVersion":${plannerCalls}}\n`,
        );
        return PLAN_OUTPUT;
      },
    });

    const engine = new HarnessEngine(fixture.config, { backend });
    const planning = await reachPlanning(engine);
    const runId = planning.runId;

    const blocked = await engine.advance(runId);
    expect(blocked.phase).toBe("blocked");
    expect(blocked.blockedFrom).toBe("planning");
    expect(blocked.blockedKind).toBe("workspace");
    expect(blocked.failure).toContain("package-lock.json");
    expect(blocked.tasks).toHaveLength(1);
    expect(blocked.tasks[0]?.title).toBe("Ship greeting");
    expect(plannerCalls).toBe(1);

    const events = (await engine.store.readText(runId, "events.jsonl"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.some((event) => event.type === "plan.created")).toBe(true);

    // Operator clears the dirty tree the planner left behind.
    await fixture.git("add", "--all");
    await fixture.git("commit", "-m", "chore: accept planner side effect");

    await engine.retry(runId);
    // Resume skips re-planning; with no implementer the run blocks once executing starts.
    const resumed = await engine.advance(runId);
    expect(plannerCalls).toBe(1);
    expect(resumed.tasks).toHaveLength(1);

    const after = (await engine.store.readText(runId, "events.jsonl"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string });
    expect(after.filter((event) => event.type === "plan.created")).toHaveLength(1);
    expect(after.some((event) => event.type === "plan.resumed")).toBe(true);
  });
});

async function reachPlanning(engine: HarnessEngine) {
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
  return state;
}
