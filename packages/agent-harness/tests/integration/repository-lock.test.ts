import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeBackend } from "../../src/infrastructure/agents/fake-backend.js";
import { HarnessEngine } from "../../src/application/harness-engine.js";
import { assertGitWorktreeCapability } from "../../src/git/capabilities.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";
import {
  createProjectFixture,
  type ProjectFixture} from "../testkit/project-fixture.js";

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

describe("repository lock", () => {
  let fixture: ProjectFixture | undefined;

  afterEach(async () => {
    if (fixture) {
      await fixture.cleanup();
      fixture = undefined;
    }
  });

  it("serializes install resolution with repository work for legacy-shared runs", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root);
    const engine = new HarnessEngine(config, { backend: createFakeBackend({}) });
    await engine.store.initialize();
    let release!: () => void;
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = engine.store.withRepositoryLock(
      { runId: "other-run", action: "advance" },
      async () => {
        acquired();
        await held;
      },
    );
    await ready;

    await expect(engine.resolveInstalls("missing-run", {})).rejects.toThrow(
      /repository is in use by run other-run/i,
    );
    release();
    await holder;
  });

  it("allows concurrent advance of independent worktree runs without a repository lock", async () => {
    await assertGitWorktreeCapability();
    fixture = await createProjectFixture({
      config: {
        git: { enabled: true, baseBranch: "main", branchPrefix: "harness" },
        workflow: { } as never,
        knowledge: {
          sources: [{ path: "README.md" }],
          graphify: { enabled: false },
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

  it("serializes legacy-shared advances with the repository lock", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { } as never});

    let releaseReflect!: () => void;
    let reflecting!: () => void;
    const reflectStarted = new Promise<void>((resolve) => {
      reflecting = resolve;
    });
    const reflectHold = new Promise<void>((resolve) => {
      releaseReflect = resolve;
    });

    const backend = createFakeBackend({
      reflector: async () => {
        reflecting();
        await reflectHold;
        return REFLECT_OUTPUT;
      }});
    const engine = new HarnessEngine(config, { backend });

    const runA = await engine.start("Idea A", "run-a", false, false);
    const runB = await engine.start("Idea B", "run-b", false, false);
    await engine.store.writeJson(runA.runId, "workspace.json", {
      version: 1,
      kind: "legacy-shared",
      controlRoot: root,
      createdAt: new Date().toISOString()});
    await engine.store.writeJson(runB.runId, "workspace.json", {
      version: 1,
      kind: "legacy-shared",
      controlRoot: root,
      createdAt: new Date().toISOString()});

    const first = engine.advance(runA.runId);
    await reflectStarted;

    const started = performance.now();
    await expect(engine.advance(runB.runId)).rejects.toThrow(
      /repository is in use by run run-a/i,
    );
    expect(performance.now() - started).toBeLessThan(500);

    releaseReflect();
    const finishedA = await first;
    expect(finishedA.phase).toBe("awaiting_input");
    expect((await engine.status(runB.runId)).phase).toBe("new");
  });

  it("does not hold the repository lock after a worktree advance returns at awaiting_input", async () => {
    await assertGitWorktreeCapability();
    fixture = await createProjectFixture({
      config: {
        git: { enabled: true, baseBranch: "main", branchPrefix: "harness" },
        workflow: { } as never,
        knowledge: {
          sources: [{ path: "README.md" }],
          graphify: { enabled: false },
          guidance: { enabled: false, maxResults: 0, maxCharacters: 1 }}}});
    await fixture.initGit({ branch: "main" });
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT});
    const engine = new HarnessEngine(fixture.config, { backend });
    const started = await engine.start("Idea", "run-awaiting", false, false);

    const state = await engine.advance(started.runId);
    expect(state.phase).toBe("awaiting_input");
    expect(await engine.store.inspectRepositoryLock()).toBeNull();
  });

  it("allows answerMany while another holder keeps the repository lock", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { } as never});
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT});
    const engine = new HarnessEngine(config, { backend });
    let state = await engine.start("Idea", "run-answer", false, false);
    state = await engine.advance(state.runId);
    expect(state.phase).toBe("awaiting_input");
    const question = state.questions.find((item) => item.id === state.activeQuestionId);
    expect(question).toBeDefined();

    let release!: () => void;
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = engine.store.withRepositoryLock(
      { runId: "holder-run", action: "advance" },
      async () => {
        acquired();
        await held;
      },
    );
    await ready;

    state = await engine.answerMany(state.runId, [
      { questionId: question!.id, answer: "Confirmed brief: casual greeting." }]);
    expect(state.phase).toBe("grilling");
    expect(state.questions.find((item) => item.id === question!.id)?.status).toBe("answered");

    release();
    await holder;
  });
});
