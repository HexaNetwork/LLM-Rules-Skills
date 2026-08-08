import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { AgentBackendRunError, createFakeBackend } from "../../src/agent.js";
import { CONFIG_VERSION } from "../../src/config.js";
import { runCommand } from "../../src/commands.js";
import { createRunState, type BuildTask, type RunState } from "../../src/domain.js";
import { HarnessEngine } from "../../src/engine.js";
import {
  HarnessFailure,
  classifyFailure,
} from "../../src/errors.js";
import { RunStore } from "../../src/store.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], {
    stdio: "ignore",
  });
  const pid = child.pid;
  if (pid == null) throw new Error("failed to spawn probe child");
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return pid;
}

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

  it("breaks a lock naming a dead pid on the local hostname immediately", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root);
    const store = new RunStore(config);
    await store.initialize();
    await store.create(createRunState("stale-dead", "Test locking", new Date().toISOString()));
    const lockPath = path.join(store.runDirectory("stale-dead"), "run.lock");
    await writeFile(
      lockPath,
      JSON.stringify({ pid: await deadPid(), hostname: hostname(), at: new Date().toISOString() }),
      "utf8",
    );

    const started = performance.now();
    await store.withLock("stale-dead", async () => undefined);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("refuses a lock naming the current process pid regardless of age", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root);
    const store = new RunStore(config);
    await store.initialize();
    await store.create(createRunState("alive-pid", "Test locking", new Date().toISOString()));
    const lockPath = path.join(store.runDirectory("alive-pid"), "run.lock");
    const ancientMs = Date.now() - 2 * 60 * 60 * 1000;
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        at: new Date(ancientMs).toISOString(),
      }),
      "utf8",
    );
    // Age the file past the 30-minute stale threshold so only liveness can refuse.
    await utimes(lockPath, new Date(ancientMs), new Date(ancientMs));

    await expect(store.withLock("alive-pid", async () => undefined)).rejects.toThrow(
      "already active",
    );
  });

  it("refuses an unparseable lock younger than 30 minutes", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root);
    const store = new RunStore(config);
    await store.initialize();
    await store.create(createRunState("garbage-lock", "Test locking", new Date().toISOString()));
    const lockPath = path.join(store.runDirectory("garbage-lock"), "run.lock");
    await writeFile(lockPath, "not-json{{{", "utf8");

    await expect(store.withLock("garbage-lock", async () => undefined)).rejects.toThrow(
      "already active",
    );
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

describe("failure classification", () => {
  it("returns HarnessFailure fields and falls back via message patterns for legacy errors", () => {
    const harness = new HarnessFailure("provider down", "provider", true);
    expect(classifyFailure(harness)).toEqual({ kind: "provider", retriable: true });

    expect(classifyFailure(new AgentBackendRunError("Cursor run x error"))).toEqual({
      kind: "provider",
      retriable: true,
    });

    expect(classifyFailure(new Error("The working tree has uncommitted changes: a.ts"))).toEqual({
      kind: "workspace",
      retriable: true,
    });
    expect(classifyFailure(new Error("Run configuration changed; resume with the persisted run config"))).toEqual({
      kind: "config",
      retriable: false,
    });
    expect(classifyFailure(new Error("unexpected boom"))).toEqual({
      kind: "internal",
      retriable: false,
    });
  });

  it("retries a provider failure twice then succeeds, emitting run.provider_retry events", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { ...fixtureConfig(root).workflow, maxProviderRetries: 2 },
    });
    let calls = 0;
    const backend = createFakeBackend({
      reflector: () => {
        calls += 1;
        if (calls <= 2) throw new AgentBackendRunError(`Cursor run failed attempt ${calls}`);
        return {
          summary: "ok",
          restatement: "Ship it",
          goal: "Ship",
          users: ["ops"],
          inScope: ["a"],
          outOfScope: [],
          assumptions: [],
          unknowns: [],
        };
      },
    });
    const sleeps: number[] = [];
    const engine = new HarnessEngine(config, {
      backend,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    let state = await engine.start("provider retry");
    state = await engine.advance(state.runId);
    expect(state.phase).toBe("awaiting_input");
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1000, 4000]);
    const events = await engine.store.readText(state.runId, "events.jsonl");
    const retryEvents = events
      .split("\n")
      .filter((line) => line.includes("run.provider_retry"));
    expect(retryEvents).toHaveLength(2);
  });

  it("blocks with blockedKind provider when the backend always throws", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { ...fixtureConfig(root).workflow, maxProviderRetries: 2 },
    });
    const backend = createFakeBackend({
      reflector: () => {
        throw new AgentBackendRunError("Cursor run always-fails error");
      },
    });
    const engine = new HarnessEngine(config, {
      backend,
      sleep: async () => undefined,
    });
    let state = await engine.start("always fail");
    state = await engine.advance(state.runId);
    expect(state.phase).toBe("blocked");
    expect(state.blockedKind).toBe("provider");
    expect(state.blockedRetriable).toBe(true);
    expect(state.failure).toMatch(/always-fails/i);
  });

  it("refuses retry on a config-kind block without force, and allows it with force", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root);
    const engine = new HarnessEngine(config, {
      backend: createFakeBackend({}),
    });
    await engine.store.initialize();
    const now = new Date().toISOString();
    let state: RunState = {
      ...createRunState("cfg-block", "idea", now, "hash", CONFIG_VERSION),
      phase: "blocked",
      blockedFrom: "reflecting",
      failure: "Run configuration changed; resume with the persisted run config",
      blockedKind: "config",
      blockedRetriable: false,
    };
    await engine.store.create(state);
    await engine.store.writeJson(state.runId, "config.json", {
      ...config,
      configVersion: CONFIG_VERSION,
    });

    await expect(engine.retry(state.runId)).rejects.toThrow(/config/i);
    await expect(engine.retry(state.runId, { force: true })).resolves.toMatchObject({
      phase: "reflecting",
      blockedKind: undefined,
      blockedRetriable: undefined,
      failure: undefined,
    });
  });

  it("keeps retry permissive when blockedRetriable is undefined (legacy runs)", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root);
    const engine = new HarnessEngine(config, {
      backend: createFakeBackend({}),
    });
    await engine.store.initialize();
    const state: RunState = {
      ...createRunState("legacy-block", "idea", new Date().toISOString(), "hash", CONFIG_VERSION),
      phase: "blocked",
      blockedFrom: "reflecting",
      failure: "something old",
    };
    await engine.store.create(state);
    await expect(engine.retry(state.runId)).resolves.toMatchObject({ phase: "reflecting" });
  });

  it("records blockedKind config when ensureCompatibleConfiguration detects a hash mismatch", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root);
    const backend = createFakeBackend({
      reflector: () => ({
        summary: "ok",
        restatement: "Ship it",
        goal: "Ship",
        users: ["ops"],
        inScope: ["a"],
        outOfScope: [],
        assumptions: [],
        unknowns: [],
      }),
    });
    const engine = new HarnessEngine(config, { backend });
    let state = await engine.start("hash drift");
    state = {
      ...state,
      configurationHash: createHash("sha256").update("different").digest("hex"),
      configVersion: CONFIG_VERSION,
    };
    await engine.store.writeJson(state.runId, "state.json", state);
    state = await engine.advance(state.runId);
    expect(state.phase).toBe("blocked");
    expect(state.blockedKind).toBe("config");
    expect(state.blockedRetriable).toBe(false);
  });
});
