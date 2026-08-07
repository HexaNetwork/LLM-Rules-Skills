import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { createFakeBackend } from "../../src/agent.js";
import { CONFIG_VERSION } from "../../src/config.js";
import { runCommand } from "../../src/commands.js";
import { createRunState, type BuildTask, type RunState } from "../../src/domain.js";
import { HarnessEngine } from "../../src/engine.js";
import { RunStore } from "../../src/store.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

describe("stall protection", () => {
  it("kills a timed-out command tree and returns evidence", async () => {
    const root = await fixtureRoot();
    const started = performance.now();
    const result = await runCommand("node -e \"setTimeout(() => {}, 5000)\"", {
      cwd: root,
      timeoutMs: 30,
    });

    expect(performance.now() - started).toBeLessThan(2_500);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("timed out");
  });

  it("rejects a concurrent runner instead of waiting on its lock", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root);
    const store = new RunStore(config);
    await store.initialize();
    await store.create(createRunState("locked", "Test locking", new Date().toISOString()));
    let release!: () => void;
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = store.withLock("locked", async () => {
      acquired();
      await held;
    });
    await ready;

    const started = performance.now();
    await expect(store.withLock("locked", async () => undefined)).rejects.toThrow(
      "already active",
    );
    expect(performance.now() - started).toBeLessThan(500);

    release();
    await first;
  });
});

describe("step budget", () => {
  it("does not count free transitions against maxStepsPerRun", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { ...fixtureConfig(root).workflow, maxStepsPerRun: 1, tdd: true },
    });
    let implementerCalls = 0;
    const backend = createFakeBackend({
      implementer: () => {
        implementerCalls += 1;
        return { summary: "built", changedFiles: ["src/a.ts"] };
      },
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "message-writer": () => ({ subject: "feat: a", body: "" }),
    });
    const engine = new HarnessEngine(config, { backend });
    const task: BuildTask = {
      id: "t1",
      title: "Ship a",
      description: "Do a",
      acceptanceCriteria: ["a works"],
      affectedPaths: [],
      blockedBy: [],
      tdd: true,
      testCommand: 'node -e "process.exit(0)"',
      status: "active",
      step: "red",
      attempts: { tests: 1, implementation: 0, review: 0 },
      evidence: [],
      testPaths: ["tests/a.test.ts"],
      changedFiles: ["tests/a.test.ts"],
    };
    let state: RunState = {
      ...createRunState("budget-free", "idea", new Date().toISOString(), "hash", CONFIG_VERSION),
      phase: "executing",
      tasks: [task],
      reflectBrief: { draft: "d", confirmed: "confirmed", confirmedAt: new Date().toISOString() },
    };
    await engine.store.initialize();
    await engine.store.create(state);
    await engine.store.writeJson(state.runId, "config.json", {
      ...config,
      configVersion: CONFIG_VERSION,
    });
    // Align hash so resume checks pass.
    state = {
      ...state,
      configurationHash: (await import("node:crypto"))
        .createHash("sha256")
        .update(JSON.stringify(config))
        .digest("hex"),
    };
    await engine.store.writeJson(state.runId, "state.json", state);

    state = await engine.advance(state.runId, 1);
    expect(implementerCalls).toBe(1);
    expect(state.phase).not.toBe("blocked");
  });

  it("yields after the configured number of expensive steps", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { ...fixtureConfig(root).workflow, maxStepsPerRun: 1, tdd: false },
      commands: { test: 'node -e "process.exit(0)"', gates: [] },
    });
    let calls = 0;
    const backend = createFakeBackend({
      implementer: () => {
        calls += 1;
        return { summary: "built", changedFiles: [`src/a${calls}.ts`] };
      },
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "message-writer": () => ({ subject: "feat: a", body: "" }),
    });
    const engine = new HarnessEngine(config, { backend });
    const tasks: BuildTask[] = [1, 2].map((index) => ({
      id: `t${index}`,
      title: `Ship ${index}`,
      description: `Do ${index}`,
      acceptanceCriteria: ["works"],
      affectedPaths: [],
      blockedBy: [],
      tdd: false,
      testCommand: 'node -e "process.exit(0)"',
      status: "pending" as const,
      step: "pending" as const,
      attempts: { tests: 0, implementation: 0, review: 0 },
      evidence: [],
      testPaths: [],
      changedFiles: [],
    }));
    let state: RunState = {
      ...createRunState("budget-yield", "idea", new Date().toISOString(), "hash", CONFIG_VERSION),
      phase: "executing",
      tasks,
      reflectBrief: { draft: "d", confirmed: "confirmed", confirmedAt: new Date().toISOString() },
    };
    await engine.store.initialize();
    await engine.store.create(state);
    const { createHash } = await import("node:crypto");
    state = {
      ...state,
      configurationHash: createHash("sha256").update(JSON.stringify(config)).digest("hex"),
    };
    await engine.store.writeJson(state.runId, "state.json", state);
    await engine.store.writeJson(state.runId, "config.json", {
      ...config,
      configVersion: CONFIG_VERSION,
    });

    state = await engine.advance(state.runId, 1);
    expect(calls).toBe(1);
    expect(state.phase).toBe("executing");
    const events = await engine.store.readText(state.runId, "events.jsonl");
    expect(events).toContain("run.yielded");
  });
});
