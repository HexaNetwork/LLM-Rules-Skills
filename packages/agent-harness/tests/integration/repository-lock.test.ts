import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { createFakeBackend } from "../../src/agent.js";
import { HarnessEngine } from "../../src/engine.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

const REFLECT_OUTPUT = {
  proposedTitle: "Add greeting tone",
  summary: "Restated greeting feature",
  restatement: "Add a greeting feature with a chosen tone.",
  goal: "Ship a greeting users understand",
  users: ["end users"],
  inScope: ["tone choice", "greeting copy"],
  outOfScope: ["localization"],
  assumptions: ["English only"],
  unknowns: ["formal vs casual"],
};

describe("repository lock", () => {
  it("serializes install resolution with repository work", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root);
    const engine = new HarnessEngine(config, { backend: createFakeBackend({}) });
    await engine.store.initialize();
    let release!: () => void;
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const holder = engine.store.withRepositoryLock({ runId: "other-run", action: "advance" }, async () => {
      acquired();
      await held;
    });
    await ready;

    await expect(engine.resolveInstalls("missing-run", {})).rejects.toThrow(
      /repository is in use by run other-run/i,
    );
    release();
    await holder;
  });

  it("fails a concurrent advance fast, names the holding run, and leaves both states loadable", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { tdd: false } as never,
    });

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
      },
    });
    const engine = new HarnessEngine(config, { backend });

    const runA = await engine.start("Idea A", "run-a", false, false);
    const runB = await engine.start("Idea B", "run-b", false, false);

    const first = engine.advance(runA.runId);
    await reflectStarted;

    const started = performance.now();
    await expect(engine.advance(runB.runId)).rejects.toThrow(
      /repository is in use by run run-a/i,
    );
    expect(performance.now() - started).toBeLessThan(500);

    const stateADuring = await engine.status(runA.runId);
    const stateBDuring = await engine.status(runB.runId);
    expect(stateADuring.phase).not.toBe("blocked");
    expect(stateBDuring.phase).toBe("new");
    expect(stateBDuring.failure).toBeUndefined();

    releaseReflect();
    const finishedA = await first;
    expect(finishedA.phase).toBe("awaiting_input");

    const stateA = await engine.status(runA.runId);
    const stateB = await engine.status(runB.runId);
    expect(stateA.phase).toBe("awaiting_input");
    expect(stateA.revision).toBeGreaterThan(runA.revision);
    expect(stateB.phase).toBe("new");
    expect(stateB.revision).toBe(runB.revision);
  });

  it("releases the repository lock when advance returns at awaiting_input", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { tdd: false } as never,
    });
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
    });
    const engine = new HarnessEngine(config, { backend });
    const started = await engine.start("Idea", "run-awaiting", false, false);

    const state = await engine.advance(started.runId);
    expect(state.phase).toBe("awaiting_input");
    expect(await engine.store.inspectRepositoryLock()).toBeNull();
  });

  it("allows answerMany while another holder keeps the repository lock", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { tdd: false } as never,
    });
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
    });
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
      { questionId: question!.id, answer: "Confirmed brief: casual greeting." },
    ]);
    expect(state.phase).toBe("grilling");
    expect(state.questions.find((item) => item.id === question!.id)?.status).toBe("answered");

    release();
    await holder;
  });
});
