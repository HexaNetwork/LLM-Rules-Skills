import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { runCommand } from "../../src/commands.js";
import { createRunState } from "../../src/domain.js";
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
