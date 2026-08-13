import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeBackend } from "../../src/infrastructure/agents/fake-backend.js";
import { migrateRunWorkspace } from "../../src/domain/workspace.js";
import { HarnessEngine } from "../../src/application/harness-engine.js";
import { assertGitWorktreeCapability } from "../../src/git/capabilities.js";
import {
  confirmGrillAndAdvance,
  createPlannerPrdSequence,
  SCENARIO_PLANNER_OUTPUT
} from "../helpers.js";
import {
  createProjectFixture,
  type ProjectFixture} from "../testkit/project-fixture.js";

const REFLECT_OUTPUT = {
  proposedTitle: "Ship a feature",
  summary: "Restated feature",
  restatement: "Ship the requested feature.",
  goal: "Deliver the feature",
  users: ["operators"],
  inScope: ["core change"],
  outOfScope: ["extras"],
  assumptions: ["base branch is correct"],
  unknowns: ["edge cases"]};

describe("concurrent worktree runs (Slice 6)", () => {
  let fixture: ProjectFixture | undefined;

  afterEach(async () => {
    if (fixture) {
      await fixture.cleanup();
      fixture = undefined;
    }
  });

  it("advances two worktree runs concurrently without a repository lock", async () => {
    await assertGitWorktreeCapability();
    fixture = await createProjectFixture({
      config: {
        git: { enabled: true, baseBranch: "main", branchPrefix: "harness" },
        workflow: { } as never,
        knowledge: {
          sources: [{ path: "README.md" }],
          codegraph: { enabled: false },
          guidance: { enabled: false, maxResults: 0, maxCharacters: 1 }}}});
    await fixture.initGit({ branch: "main" });

    let releaseA!: () => void;
    let releaseB!: () => void;
    let startedA!: () => void;
    let startedB!: () => void;
    const aStarted = new Promise<void>((resolve) => {
      startedA = resolve;
    });
    const bStarted = new Promise<void>((resolve) => {
      startedB = resolve;
    });
    const aHold = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const bHold = new Promise<void>((resolve) => {
      releaseB = resolve;
    });

    // One engine per run: UI/CLI reopen per job so paths.workspaceRoot is not shared mutable state.
    const engineA = new HarnessEngine(fixture.config, {
      backend: createFakeBackend({
        reflector: async () => {
          startedA();
          await aHold;
          return REFLECT_OUTPUT;
        }})});
    const engineB = new HarnessEngine(fixture.config, {
      backend: createFakeBackend({
        reflector: async () => {
          startedB();
          await bHold;
          return REFLECT_OUTPUT;
        }})});

    const runA = await engineA.start("Idea A", "run-a", false, false);
    const runB = await engineB.start("Idea B", "run-b", false, false);

    const advancingA = engineA.advance(runA.runId);
    const advancingB = engineB.advance(runB.runId);

    await Promise.all([aStarted, bStarted]);
    expect(await engineA.store.inspectRepositoryLock()).toBeNull();

    releaseA();
    releaseB();
    const [finishedA, finishedB] = await Promise.all([advancingA, advancingB]);
    expect(finishedA.phase).toBe("awaiting_input");
    expect(finishedB.phase).toBe("awaiting_input");
  });

  it("lets two concurrent runs edit the same relative filename independently", async () => {
    await assertGitWorktreeCapability();
    fixture = await createProjectFixture({
      config: {
        git: { enabled: true, baseBranch: "main", branchPrefix: "harness" },
        workflow: { } as never,
        knowledge: {
          sources: [{ path: "README.md" }],
          codegraph: { enabled: false },
          guidance: { enabled: false, maxResults: 0, maxCharacters: 1 }}}});
    await fixture.initGit({ branch: "main" });

    let releaseA!: () => void;
    let releaseB!: () => void;
    let startedA!: () => void;
    let startedB!: () => void;
    const aStarted = new Promise<void>((resolve) => {
      startedA = resolve;
    });
    const bStarted = new Promise<void>((resolve) => {
      startedB = resolve;
    });
    const aHold = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const bHold = new Promise<void>((resolve) => {
      releaseB = resolve;
    });

    const engineA = new HarnessEngine(fixture.config, {
      backend: createFakeBackend({
        reflector: async (request) => {
          await mkdir(path.join(request.cwd, "src"), { recursive: true });
          await writeFile(path.join(request.cwd, "src", "shared.ts"), "content-a\n", "utf8");
          startedA();
          await aHold;
          return REFLECT_OUTPUT;
        }})});
    const engineB = new HarnessEngine(fixture.config, {
      backend: createFakeBackend({
        reflector: async (request) => {
          await mkdir(path.join(request.cwd, "src"), { recursive: true });
          await writeFile(path.join(request.cwd, "src", "shared.ts"), "content-b\n", "utf8");
          startedB();
          await bHold;
          return REFLECT_OUTPUT;
        }})});

    const runA = await engineA.start("Idea A", "run-a", false, false);
    const runB = await engineB.start("Idea B", "run-b", false, false);
    const workspaceA = migrateRunWorkspace(
      await engineA.store.readJson(runA.runId, "workspace.json"),
      { controlRoot: fixture.root },
    );
    const workspaceB = migrateRunWorkspace(
      await engineB.store.readJson(runB.runId, "workspace.json"),
      { controlRoot: fixture.root },
    );

    const advancingA = engineA.advance(runA.runId);
    const advancingB = engineB.advance(runB.runId);
    await Promise.all([aStarted, bStarted]);

    expect(
      await readFile(path.join(workspaceA.worktreePath!, "src", "shared.ts"), "utf8"),
    ).toBe("content-a\n");
    expect(
      await readFile(path.join(workspaceB.worktreePath!, "src", "shared.ts"), "utf8"),
    ).toBe("content-b\n");
    expect(await engineA.store.inspectRepositoryLock()).toBeNull();

    releaseA();
    releaseB();
    await Promise.all([advancingA, advancingB]);

    expect(
      await readFile(path.join(workspaceA.worktreePath!, "src", "shared.ts"), "utf8"),
    ).toBe("content-a\n");
    expect(
      await readFile(path.join(workspaceB.worktreePath!, "src", "shared.ts"), "utf8"),
    ).toBe("content-b\n");
    await expect(readFile(path.join(fixture.root, "src", "shared.ts"), "utf8")).rejects.toThrow();
  });

  it("runs two deterministic workflows concurrently in separate worktrees", async () => {
    await assertGitWorktreeCapability();
    fixture = await createProjectFixture({
      config: {
        git: { enabled: true, baseBranch: "main", branchPrefix: "harness" },
        workflow: { } as never,
        knowledge: {
          sources: [{ path: "README.md" }],
          codegraph: { enabled: false },
          guidance: { enabled: false, maxResults: 0, maxCharacters: 1 }}}});
    await fixture.initGit({ branch: "main" });

    let releaseA!: () => void;
    let releaseB!: () => void;
    let startedA!: () => void;
    let startedB!: () => void;
    const aStarted = new Promise<void>((resolve) => {
      startedA = resolve;
    });
    const bStarted = new Promise<void>((resolve) => {
      startedB = resolve;
    });
    const aHold = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const bHold = new Promise<void>((resolve) => {
      releaseB = resolve;
    });

    async function runWorkflow(
      runId: string,
      marker: string,
      onReflect: () => Promise<void>,
    ): Promise<{ phase: string; content: string; worktreePath: string }> {
      const engine = new HarnessEngine(fixture!.config, {
        backend: createFakeBackend({
          reflector: async () => {
            await onReflect();
            return { ...REFLECT_OUTPUT, proposedTitle: `Feature ${marker}` };
          },
          griller: () => ({
            status: "ready_to_plan",
            summary: "Ready",
            resolutions: [
              {
                id: "confirm",
                question: `Confirm ${marker}?`,
                answer: "Yes",
                summary: `Use ${marker}`}]}),
          planner: createPlannerPrdSequence().planner,

          "scenario-planner": () => SCENARIO_PLANNER_OUTPUT,

          "issue-slicer": () => ({
            summary: "One task",
            tasks: [
              {
                id: `task-${marker}`,
                title: `Ship ${marker}`,
                description: `Write ${marker}`,
                acceptanceCriteria: [`${marker} exists`],
                scenarioIds: ["greet-happy"],
                blockedBy: []}],
            proposedInstalls: []}),
          implementer: async (request) => {
            await mkdir(path.join(request.cwd, "src"), { recursive: true });
            await writeFile(
              path.join(request.cwd, "src", "feature.ts"),
              `${marker}-done\n`,
              "utf8",
            );
            return { summary: "built", changedFiles: ["src/feature.ts"] };
          },
          reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
          "scenario-writer": () => ({
            status: "implemented",
            summary: "Scenario tests",
            testPaths: ["tests/greet.test.ts"],
            changedFiles: ["tests/greet.test.ts"],
          })})});

      let state = await engine.start(`Idea ${marker}`, runId, false, false);
      state = await engine.advance(state.runId);
      expect(state.phase, state.failure).toBe("awaiting_input");
      const reflectQ = state.questions.find((item) => item.id === state.activeQuestionId);
      expect(reflectQ).toBeDefined();
      state = await engine.answer(state.runId, reflectQ!.id, `Confirmed ${marker}`);
      state = await engine.advance(state.runId);
      state = await confirmGrillAndAdvance(engine, state.runId, undefined, {
        clearBaselineFailure: true});
      expect(state.phase, state.failure).toBe("completed");

      const workspace = migrateRunWorkspace(
        await engine.store.readJson(state.runId, "workspace.json"),
        { controlRoot: fixture!.root },
      );
      const content = await readFile(
        path.join(workspace.worktreePath!, "src", "feature.ts"),
        "utf8",
      );
      return { phase: state.phase, content, worktreePath: workspace.worktreePath! };
    }

    const workflows = Promise.all([
      runWorkflow("flow-a", "alpha", async () => {
        startedA();
        await aHold;
      }),
      runWorkflow("flow-b", "beta", async () => {
        startedB();
        await bHold;
      })]);

    await Promise.all([aStarted, bStarted]);
    expect(await fixture.listWorktrees()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: expect.stringContaining("flow-a") }),
        expect.objectContaining({ path: expect.stringContaining("flow-b") })]),
    );
    releaseA();
    releaseB();

    const [resultA, resultB] = await workflows;
    expect(resultA.phase).toBe("completed");
    expect(resultB.phase).toBe("completed");
    expect(resultA.content).toBe("alpha-done\n");
    expect(resultB.content).toBe("beta-done\n");
    expect(resultA.worktreePath).not.toBe(resultB.worktreePath);
  });
});
