import path from "node:path";
import { access, readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { AgentBackendRunError, createFakeBackend, type AgentRequest } from "../../src/agent.js";
import { runCommand } from "../../src/commands.js";
import { CONFIG_VERSION, configurationHash } from "../../src/config.js";
import { createRunState, type BuildTask, type RunState } from "../../src/domain.js";
import { HarnessEngine } from "../../src/engine.js";
import { startUiServer, type UiServer } from "../../src/ui/server.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

describe("out-of-band cancellation", () => {
  let ui: UiServer | undefined;

  afterEach(async () => {
    await ui?.close();
    ui = undefined;
  });

  it("kills a long-running runCommand when its signal aborts", async () => {
    const root = await fixtureRoot();
    const controller = new AbortController();
    const started = performance.now();
    const running = runCommand('node -e "setTimeout(() => {}, 30_000)"', {
      cwd: root,
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    const result = await running;

    expect(performance.now() - started).toBeLessThan(5_000);
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(130);
  });

  it("cancels a mid-flight agent invocation without blocking or provider-retry", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { ...fixtureConfig(root).workflow, maxProviderRetries: 2 },
      agent: { ...fixtureConfig(root).agent, timeoutMs: 30_000 },
    });
    let seenSignal: AbortSignal | undefined;
    let signalAborted = false;
    const backend = createFakeBackend({
      reflector: (request: AgentRequest) =>
        new Promise((_resolve, reject) => {
          seenSignal = request.signal;
          const onAbort = (): void => {
            signalAborted = true;
            reject(new AgentBackendRunError("Cursor run failed: cancelled"));
          };
          if (request.signal.aborted) {
            onAbort();
            return;
          }
          request.signal.addEventListener("abort", onAbort, { once: true });
        }),
    });
    const engine = new HarnessEngine(config, {
      backend,
      sleep: async () => undefined,
    });
    const started = await engine.start("cancel mid-flight");
    const advancing = engine.advance(started.runId);

    await waitFor(() => seenSignal != null, 5_000);
    const cancelResult = await engine.cancel(started.runId);
    const state = await advancing;

    expect(signalAborted).toBe(true);
    expect(seenSignal?.aborted).toBe(true);
    expect(state.phase).toBe("cancelled");
    expect(state.phase).not.toBe("blocked");
    expect(cancelResult.state.phase === "cancelled" || cancelResult.pending).toBe(true);

    const sessions = (await engine.store.listFiles(started.runId, "sessions")).filter((file) =>
      file.endsWith(".json"),
    );
    const bodies = await Promise.all(
      sessions.map((file) => engine.store.readJson(started.runId, file)),
    );
    const aborted = bodies.find(
      (body) =>
        typeof body === "object" &&
        body != null &&
        "status" in body &&
        (body as { status?: string }).status !== "running",
    ) as { status?: string } | undefined;
    expect(aborted?.status).toBe("cancelled");

    const events = await engine.store.readText(started.runId, "events.jsonl");
    expect(events).toContain("run.cancelled");
    expect(events).not.toContain("run.provider_retry");
  });

  it("cancel during provider-retry backoff completes cancelled without retrying again", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { ...fixtureConfig(root).workflow, maxProviderRetries: 2 },
    });
    let calls = 0;
    let runId = "";
    const backend = createFakeBackend({
      reflector: () => {
        calls += 1;
        throw new AgentBackendRunError(`Cursor run failed attempt ${calls}`);
      },
    });
    const engine = new HarnessEngine(config, {
      backend,
      sleep: async () => {
        if (calls === 1) {
          await engine.cancel(runId);
        }
      },
    });
    const started = await engine.start("cancel during retry");
    runId = started.runId;
    const state = await engine.advance(runId);

    expect(state.phase).toBe("cancelled");
    // First failure may schedule a retry, but cancel during backoff must not invoke again.
    expect(calls).toBe(1);
  });

  it("POST cancel returns 2xx while another job is running for that run", async () => {
    const root = await fixtureRoot();
    let release!: () => void;
    let enteredReflect = false;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backend = createFakeBackend({
      reflector: async (request: AgentRequest) => {
        enteredReflect = true;
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => reject(new AgentBackendRunError("Cursor run failed: cancelled"));
          if (request.signal.aborted) {
            onAbort();
            return;
          }
          request.signal.addEventListener("abort", onAbort, { once: true });
          void held.then(resolve);
        });
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
    ui = await startUiServer({
      config: fixtureConfig(root, {
        agent: { ...fixtureConfig(root).agent, timeoutMs: 30_000 },
      }),
      backend,
      port: 0,
      token: "cancel-ui",
    });

    const created = await request(ui, "/api/runs", {
      method: "POST",
      body: { idea: "cancel while advancing" },
    });
    expect(created.status).toBe(202);
    const { run } = (await created.json()) as { run: { runId: string } };
    const runId = run.runId;

    await waitFor(() => enteredReflect, 10_000);

    // A non-cancel action would 409 here; cancel must bypass the queue.
    const conflicted = await request(ui, `/api/runs/${encodeURIComponent(runId)}/actions`, {
      method: "POST",
      body: { action: "continue" },
    });
    expect(conflicted.status).toBe(409);

    const cancelStarted = performance.now();
    const cancelled = await request(ui, `/api/runs/${encodeURIComponent(runId)}/actions`, {
      method: "POST",
      body: { action: "cancel" },
    });
    expect(performance.now() - cancelStarted).toBeLessThan(2_000);
    expect(cancelled.status).toBe(202);
    const cancelBody = (await cancelled.json()) as {
      pending?: boolean;
      accepted?: boolean;
      state?: { phase: string };
    };
    expect(cancelBody.pending).toBe(true);

    release();
    const deadline = Date.now() + 15_000;
    let phase = "";
    while (Date.now() < deadline) {
      const detail = await request(ui, `/api/runs/${encodeURIComponent(runId)}`);
      const body = (await detail.json()) as { state?: { phase: string }; job?: unknown };
      phase = body.state?.phase ?? "";
      if (phase === "cancelled" && !body.job) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(phase).toBe("cancelled");
  });

  it("cancel during yield exit drains cancel.request and ends cancelled", async () => {
    // Race: cancel after the last post-step check / during run.yielded must not leave
    // cancel.request pending forever with the UI stuck on "Cancelling…".
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { ...fixtureConfig(root).workflow, maxStepsPerRun: 1, tdd: false },
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
    let seed: RunState = {
      ...createRunState("cancel-yield", "idea", new Date().toISOString(), "hash", CONFIG_VERSION),
      phase: "executing",
      tasks,
      reflectBrief: { draft: "d", confirmed: "confirmed", confirmedAt: new Date().toISOString() },
    };
    await engine.store.initialize();
    await engine.store.create(seed);
    seed = {
      ...seed,
      configurationHash: configurationHash(config),
    };
    await engine.store.writeJson(seed.runId, "state.json", seed);
    await engine.store.writeJson(seed.runId, "config.json", {
      ...config,
      configVersion: CONFIG_VERSION,
    });

    const originalRecord = engine.store.record.bind(engine.store);
    let cancelDuringYield: Awaited<ReturnType<HarnessEngine["cancel"]>> | undefined;
    engine.store.record = async (state, type, detail) => {
      if (type === "run.yielded") {
        cancelDuringYield = await engine.cancel(state.runId);
      }
      return originalRecord(state, type, detail);
    };

    const state = await engine.advance(seed.runId, 1);

    expect(cancelDuringYield?.pending).toBe(true);
    expect(state.phase).toBe("cancelled");
    const cancelPath = path.join(engine.store.runDirectory(seed.runId), "cancel.request");
    await expect(access(cancelPath)).rejects.toMatchObject({ code: "ENOENT" });
    const events = await engine.store.readText(seed.runId, "events.jsonl");
    expect(events).toContain("run.cancelled");
  });

  it("writes cancel.request for cross-process cancellation at step boundaries", async () => {
    // tryWithLock waits up to ~5s when another holder has the run lock.
    const root = await fixtureRoot();
    const config = fixtureConfig(root);
    const engine = new HarnessEngine(config, {
      backend: createFakeBackend({
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
      }),
    });
    const started = await engine.start("cross-process cancel file");
    // Hold the run lock as another process would during advance.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = engine.store.withLock(started.runId, async () => {
      await held;
    });

    const cancelResult = await engine.cancel(started.runId);
    expect(cancelResult.pending).toBe(true);
    const cancelPath = path.join(engine.store.runDirectory(started.runId), "cancel.request");
    await expect(access(cancelPath)).resolves.toBeUndefined();
    const body = JSON.parse(await readFile(cancelPath, "utf8")) as { at?: string; by?: string };
    expect(typeof body.at).toBe("string");
    expect(typeof body.by).toBe("string");

    release();
    await locked;
    // After lock releases without an advancing process completing cancel, request remains.
    // A subsequent cancel (or advance) should complete the transition.
    const completed = await engine.cancel(started.runId);
    expect(completed.pending).toBe(false);
    expect(completed.state.phase).toBe("cancelled");
    await expect(access(cancelPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}

async function request(
  ui: UiServer,
  pathname: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${ui.port}${pathname}`, {
    method: init.method ?? "GET",
    headers: {
      "X-Harness-Token": ui.token,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
}
