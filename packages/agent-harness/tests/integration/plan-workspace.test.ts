import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createFakeBackend, type AgentRequest } from "../../src/agent.js";
import { HarnessEngine } from "../../src/engine.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

const exec = promisify(execFile);

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
  it("blocks on a dirty tree before invoking the planner", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);

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

    const config = fixtureConfig(root, {
      git: { enabled: true } as never,
      workflow: { tdd: false, maxStepsPerRun: 10 } as never,
      agent: { promptBuilder: false } as never,
    });
    const engine = new HarnessEngine(config, { backend });
    const planning = await reachPlanning(engine);

    await writeFile(path.join(root, "package-lock.json"), "{}\n", "utf8");

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
    const root = await fixtureRoot();
    await initGitRepo(root);

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
        await writeFile(path.join(root, "package-lock.json"), `{"lockfileVersion":${plannerCalls}}\n`, "utf8");
        return PLAN_OUTPUT;
      },
    });

    const config = fixtureConfig(root, {
      git: { enabled: true } as never,
      workflow: { tdd: false, maxStepsPerRun: 15 } as never,
      agent: { promptBuilder: false } as never,
    });
    const engine = new HarnessEngine(config, { backend });
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
    await git(root, "add", "--all");
    await git(root, "commit", "-m", "chore: accept planner side effect");

    await engine.retry(runId);
    // One step: plan.resumed → executing. Do not enter implementer work.
    const resumed = await engine.advance(runId, 1);
    expect(plannerCalls).toBe(1);
    expect(resumed.phase).toBe("executing");
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
  state = await engine.advance(state.runId, 1);
  expect(state.phase).toBe("awaiting_input");
  const reflectId = state.activeQuestionId!;
  state = await engine.answer(state.runId, reflectId, "Confirmed brief: casual greeting.");
  expect(state.phase).toBe("grilling");
  // One step only: grill → planning. A larger budget would continue into plan().
  state = await engine.advance(state.runId, 1);
  expect(state.phase).toBe("planning");
  return state;
}

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
