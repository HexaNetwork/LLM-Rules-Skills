import { spawn } from "node:child_process";
import { resolveHarnessPaths } from "../../src/application/paths.js";
import { RepeatedTransitionCircuitBreaker } from "../../src/application/run-advancer.js";
import { createHash } from "node:crypto";
import { readFile, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { AgentBackendRunError } from "../../src/infrastructure/agents/types.js";
import { createFakeBackend } from "../../src/infrastructure/agents/fake-backend.js";
import { CONFIG_VERSION, configurationHash } from "../../src/config/schema.js";
import { runCommand } from "../../src/commands.js";
import { createRunState, type RunState } from "../../src/domain.js";
import { HarnessEngine } from "../../src/application/harness-engine.js";
import {
  HarnessFailure,
  classifyFailure} from "../../src/errors.js";
import { RunStore } from "../../src/store.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], {
    stdio: "ignore"});
  const pid = child.pid;
  if (pid == null) throw new Error("failed to spawn probe child");
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return pid;
}

describe("repeated-transition circuit breaker", () => {
  it("flags the second identical transition", () => {
    const breaker = new RepeatedTransitionCircuitBreaker();
    expect(() => breaker.observe("A", "B", "executing")).not.toThrow();
    expect(() => breaker.observe("A", "B", "executing")).toThrow(
      /Repeated workflow transition detected 2 times/,
    );
  });
});

describe("stall protection", () => {
  it("does not pass provider credentials to commands and redacts their output", async () => {
    const root = await fixtureRoot();
    const originalCursor = process.env.CURSOR_API_KEY;
    const originalVisible = process.env.HARNESS_VISIBLE_TEST_VALUE;
    const secret = "cursor-secret-value-123";
    process.env.CURSOR_API_KEY = secret;
    process.env.HARNESS_VISIBLE_TEST_VALUE = "allowed";
    try {
      const result = await runCommand(
        `node -e "console.log(process.env.CURSOR_API_KEY || 'absent'); console.log(process.env.HARNESS_VISIBLE_TEST_VALUE); console.log('${secret}')"`,
        { cwd: root, timeoutMs: 5_000, passEnv: ["HARNESS_VISIBLE_TEST_VALUE"] },
      );
      expect(result.stdout).toContain("absent");
      expect(result.stdout).toContain("allowed");
      expect(result.stdout).not.toContain(secret);
      expect(result.stdout).toContain("[REDACTED]");
    } finally {
      if (originalCursor == null) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = originalCursor;
      if (originalVisible == null) delete process.env.HARNESS_VISIBLE_TEST_VALUE;
      else process.env.HARNESS_VISIBLE_TEST_VALUE = originalVisible;
    }
  });

  it("kills a timed-out command tree and returns evidence", async () => {
    const root = await fixtureRoot();
    const started = performance.now();
    const result = await runCommand("node -e \"setTimeout(() => {}, 5000)\"", {
      cwd: root,
      timeoutMs: 30});

    expect(performance.now() - started).toBeLessThan(2_500);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("timed out");
  });

  it("rejects a concurrent runner instead of waiting on its lock", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root);
    const store = new RunStore(config, resolveHarnessPaths(config).stateRoot);
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

  it("requires an explicit unlock for a lock naming a dead pid", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root);
    const store = new RunStore(config, resolveHarnessPaths(config).stateRoot);
    await store.initialize();
    await store.create(createRunState("stale-dead", "Test locking", new Date().toISOString()));
    const lockPath = path.join(store.runDirectory("stale-dead"), "run.lock");
    await writeFile(
      lockPath,
      JSON.stringify({ pid: await deadPid(), hostname: hostname(), at: new Date().toISOString() }),
      "utf8",
    );

    await expect(store.withLock("stale-dead", async () => undefined)).rejects.toThrow(
      "already active",
    );
    expect((await store.unlock("stale-dead")).run).toBe(true);
    await store.withLock("stale-dead", async () => undefined);
  });

  it("refuses a lock naming the current process pid regardless of age", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root);
    const store = new RunStore(config, resolveHarnessPaths(config).stateRoot);
    await store.initialize();
    await store.create(createRunState("alive-pid", "Test locking", new Date().toISOString()));
    const lockPath = path.join(store.runDirectory("alive-pid"), "run.lock");
    const ancientMs = Date.now() - 2 * 60 * 60 * 1000;
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        at: new Date(ancientMs).toISOString()}),
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
    const store = new RunStore(config, resolveHarnessPaths(config).stateRoot);
    await store.initialize();
    await store.create(createRunState("garbage-lock", "Test locking", new Date().toISOString()));
    const lockPath = path.join(store.runDirectory("garbage-lock"), "run.lock");
    await writeFile(lockPath, "not-json{{{", "utf8");

    await expect(store.withLock("garbage-lock", async () => undefined)).rejects.toThrow(
      "already active",
    );
  });
});

describe("durable transition journal", () => {
  it("recovers a state write and missing event after an interrupted transition", async () => {
    const config = fixtureConfig(await fixtureRoot());
    const store = new RunStore(config, resolveHarnessPaths(config).stateRoot);
    await store.initialize();
    await store.create(createRunState("journal-run", "Journal recovery", new Date().toISOString()));
    const state = await store.load("journal-run");
    const event = {
      sequence: state.lastEventSequence + 1,
      type: "test.recovered",
      detail: { source: "fault-injection" },
      at: new Date().toISOString()};
    const next = {
      ...state,
      phase: "awaiting_input" as const,
      lastEventSequence: event.sequence,
      revision: state.revision + 1,
      updatedAt: new Date().toISOString()};
    await writeFile(
      path.join(store.runDirectory("journal-run"), "transition.pending.json"),
      JSON.stringify({ expectedRevision: state.revision, state: next, event }),
      "utf8",
    );
    await writeFile(path.join(store.runDirectory("journal-run"), "events.jsonl"), '{"partial"', "utf8");

    const recovered = await store.load("journal-run");
    expect(recovered.revision).toBe(next.revision);
    expect(recovered.lastEventSequence).toBe(event.sequence);
    const events = await readFile(path.join(store.runDirectory("journal-run"), "events.jsonl"), "utf8");
    expect(events).toContain('"test.recovered"');
    // A second load is idempotent: recovery must not append a duplicate event.
    await store.load("journal-run");
    expect((await readFile(path.join(store.runDirectory("journal-run"), "events.jsonl"), "utf8")).match(/test\.recovered/g)).toHaveLength(1);
  });
});

describe("failure classification", () => {
  it("returns HarnessFailure fields and falls back via message patterns for legacy errors", () => {
    const harness = new HarnessFailure("provider down", "provider", true);
    expect(classifyFailure(harness)).toEqual({ kind: "provider", retriable: true });

    expect(classifyFailure(new AgentBackendRunError("Cursor run x error"))).toEqual({
      kind: "provider",
      retriable: true});

    expect(classifyFailure(new Error("The working tree has uncommitted changes: a.ts"))).toEqual({
      kind: "workspace",
      retriable: true});
    expect(classifyFailure(new Error("git.enabled is true but /tmp/x is not a git repository"))).toEqual({
      kind: "workspace",
      retriable: true});
    expect(classifyFailure(new Error("Run configuration changed; resume with the persisted run config"))).toEqual({
      kind: "config",
      retriable: false});
    expect(classifyFailure(new Error("unexpected boom"))).toEqual({
      kind: "internal",
      retriable: false});
  });

  it("retries a provider failure twice then succeeds, emitting run.provider_retry events", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { ...fixtureConfig(root).workflow, maxProviderRetries: 2 }});
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
          unknowns: []};
      }});
    const sleeps: number[] = [];
    const engine = new HarnessEngine(config, {
      backend,
      sleep: async (ms) => {
        sleeps.push(ms);
      }});
    let state = await engine.start("provider retry");
    state = await engine.advance(state.runId);
    expect(state.phase).toBe("awaiting_input");
    expect(calls).toBe(3);
    // Backoff is chunked into 100ms polls (1s + 4s).
    expect(sleeps.every((ms) => ms === 100)).toBe(true);
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(5_000);
    const events = await engine.store.readText(state.runId, "events.jsonl");
    const retryEvents = events
      .split("\n")
      .filter((line) => line.includes("run.provider_retry"));
    expect(retryEvents).toHaveLength(2);
  });

  it("does not clobber mid-step persisted state when recording run.provider_retry", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { ...fixtureConfig(root).workflow, maxProviderRetries: 1 }});
    let calls = 0;
    const phasesDuringBackoff: string[] = [];
    let runId = "";
    const backend = createFakeBackend({
      reflector: () => {
        calls += 1;
        if (calls === 1) throw new AgentBackendRunError("Cursor run failed mid-step");
        return {
          summary: "ok",
          restatement: "Ship it",
          goal: "Ship",
          users: ["ops"],
          inScope: ["a"],
          outOfScope: [],
          assumptions: [],
          unknowns: []};
      }});
    const engine = new HarnessEngine(config, {
      backend,
      sleep: async () => {
        // reflect.started persists phase=reflecting before the provider throws. Without
        // reloading before run.provider_retry, the stale in-memory phase ("new") would
        // overwrite state.json.
        const mid = await engine.store.load(runId);
        phasesDuringBackoff.push(mid.phase);
      }});
    const started = await engine.start("mid-step retry");
    runId = started.runId;
    expect(started.phase).toBe("new");
    const state = await engine.advance(runId);
    expect(phasesDuringBackoff.length).toBeGreaterThan(0);
    expect(phasesDuringBackoff.every((phase) => phase === "reflecting")).toBe(true);
    expect(state.phase).toBe("awaiting_input");
    expect(calls).toBe(2);
    const events = await engine.store.readText(runId, "events.jsonl");
    expect(events).toContain("reflect.started");
    expect(events).toContain("run.provider_retry");
  });

  it("short-circuits provider retry backoff when cancel.request appears", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { ...fixtureConfig(root).workflow, maxProviderRetries: 2 }});
    let runId = "";
    const sleeps: number[] = [];
    const backend = createFakeBackend({
      reflector: () => {
        throw new AgentBackendRunError("Cursor run flaky during backoff");
      }});
    const engine = new HarnessEngine(config, {
      backend,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 1) {
          await writeFile(
            path.join(engine.store.runDirectory(runId), "cancel.request"),
            JSON.stringify({ at: new Date().toISOString(), by: "test" }),
            "utf8",
          );
        }
      }});
    const started = await engine.start("cancel during backoff");
    runId = started.runId;
    const state = await engine.advance(runId);
    // One 100ms chunk, then cancel.request is noticed — not the full 1s backoff.
    expect(sleeps).toEqual([100]);
    expect(state.phase).toBe("cancelled");
    expect(state.blockedKind).toBeUndefined();
  });

  it("blocks with blockedKind provider when the backend always throws", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { ...fixtureConfig(root).workflow, maxProviderRetries: 2 }});
    const backend = createFakeBackend({
      reflector: () => {
        throw new AgentBackendRunError("Cursor run always-fails error");
      }});
    const engine = new HarnessEngine(config, {
      backend,
      sleep: async () => undefined});
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
      backend: createFakeBackend({})});
    await engine.store.initialize();
    const now = new Date().toISOString();
    let state: RunState = {
      ...createRunState("cfg-block", "idea", now, "hash", CONFIG_VERSION),
      phase: "blocked",
      blockedFrom: "reflecting",
      failure: "Run configuration changed; resume with the persisted run config",
      blockedKind: "config",
      blockedRetriable: false};
    await engine.store.create(state);
    await engine.store.writeJson(state.runId, "config.json", {
      ...config,
      configVersion: CONFIG_VERSION});

    await expect(engine.retry(state.runId)).rejects.toThrow(/config/i);
    await expect(engine.retry(state.runId, { force: true })).resolves.toMatchObject({
      phase: "reflecting",
      blockedKind: undefined,
      blockedRetriable: undefined,
      failure: undefined});
  });

  it("keeps retry permissive when blockedRetriable is undefined (legacy runs)", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root);
    const engine = new HarnessEngine(config, {
      backend: createFakeBackend({})});
    await engine.store.initialize();
    const state: RunState = {
      ...createRunState("legacy-block", "idea", new Date().toISOString(), "hash", CONFIG_VERSION),
      phase: "blocked",
      blockedFrom: "reflecting",
      failure: "something old"};
    await engine.store.create(state);
    await expect(engine.retry(state.runId)).resolves.toMatchObject({ phase: "reflecting" });
  });

  it("re-stamps a stale configurationHash when the frozen policy still matches", async () => {
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
        unknowns: []})});
    const engine = new HarnessEngine(config, { backend });
    let state = await engine.start("hash drift");
    state = {
      ...state,
      configurationHash: createHash("sha256").update("different").digest("hex"),
      configVersion: CONFIG_VERSION};
    await engine.store.writeJson(state.runId, "state.json", state);
    state = await engine.advance(state.runId);
    expect(state.phase).toBe("awaiting_input");
    expect(state.configurationHash).toBe(configurationHash(config));
    const events = await readFile(
      path.join(root, ".agent-harness", "runs", state.runId, "events.jsonl"),
      "utf8",
    );
    expect(events).toContain("run.config_restamped");
  });

  it("records blockedKind config when frozen hashed policy differs", async () => {
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
        unknowns: []})});
    const engine = new HarnessEngine(config, { backend });
    const state = await engine.start("hash drift");

    engine.config.commands.verification = [{ id: "test", command: "npm run changed-test", timeoutMs: 600_000 }];
    const blocked = await engine.advance(state.runId);

    expect(blocked.phase).toBe("blocked");
    expect(blocked.blockedKind).toBe("config");
    expect(blocked.blockedRetriable).toBe(false);
    expect(blocked.failure).toMatch(/Differing hashed policy vs frozen snapshot: commands\.verification/i);
  });
});
