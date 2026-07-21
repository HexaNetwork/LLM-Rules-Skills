import { afterEach, describe, expect, it, vi } from "vitest";
import {
  waitWithHeartbeat,
  WorkerRunTimeoutError,
  WorkerStuckNoCodeError,
} from "../../src/agents/cursor-sdk.js";
import * as git from "../../src/util/git.js";

describe("waitWithHeartbeat worktree-progress watchdog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("cancels when worktree fingerprint is unchanged past threshold", async () => {
    vi.spyOn(git, "worktreeFingerprint").mockResolvedValue("same-fp");
    const cancel = vi.fn().mockResolvedValue(undefined);
    let resolveWait: (value: { status: string }) => void = () => {};
    const wait = vi.fn(
      () =>
        new Promise<{ status: string }>((resolve) => {
          resolveWait = resolve;
        }),
    );

    const run = {
      id: "run-stuck",
      wait,
      cancel,
      supports: (op: string) => op === "cancel",
    };

    const pending = waitWithHeartbeat(run, "worker/test", {
      cwd: "/tmp/repo",
      requireCodeAfterMs: 50,
    });

    await expect(pending).rejects.toBeInstanceOf(WorkerStuckNoCodeError);
    expect(cancel).toHaveBeenCalledOnce();
    resolveWait({ status: "cancelled" });
  });

  it("stays armed after progress and cancels on later stagnation", async () => {
    const fingerprint = vi
      .spyOn(git, "worktreeFingerprint")
      .mockResolvedValueOnce("baseline") // initial arm
      .mockResolvedValueOnce("changed") // first check: progress
      .mockResolvedValue("changed"); // later checks: stagnant

    const cancel = vi.fn().mockResolvedValue(undefined);
    let resolveWait: (value: { status: string }) => void = () => {};
    const run = {
      id: "run-stagnate",
      wait: () =>
        new Promise<{ status: string }>((resolve) => {
          resolveWait = resolve;
        }),
      cancel,
      supports: () => true,
    };

    const pending = waitWithHeartbeat(run, "worker/test", {
      cwd: "/tmp/repo",
      requireCodeAfterMs: 40,
    });

    await expect(pending).rejects.toBeInstanceOf(WorkerStuckNoCodeError);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fingerprint.mock.calls.length).toBeGreaterThanOrEqual(3);
    resolveWait({ status: "cancelled" });
  });

  it("allows finish while watchdog stays armed if progress continues", async () => {
    let n = 0;
    vi.spyOn(git, "worktreeFingerprint").mockImplementation(async () => {
      n += 1;
      return `fp-${n}`;
    });

    const run = {
      id: "run-ok",
      wait: () =>
        new Promise<{ status: string }>((resolve) => {
          setTimeout(() => resolve({ status: "finished" }), 100);
        }),
      cancel: vi.fn(),
      supports: () => true,
    };

    const result = await waitWithHeartbeat(run, "worker/test", {
      cwd: "/tmp/repo",
      requireCodeAfterMs: 40,
    });

    expect(result.status).toBe("finished");
    expect(run.cancel).not.toHaveBeenCalled();
  });

  it("skips watchdog when requireCodeAfterMs is 0", async () => {
    const fingerprint = vi.spyOn(git, "worktreeFingerprint");
    const run = {
      id: "run-fast",
      wait: async () => ({ status: "finished" }),
    };

    const result = await waitWithHeartbeat(run, "verifier/test", {
      cwd: "/tmp/repo",
      requireCodeAfterMs: 0,
    });

    expect(result.status).toBe("finished");
    expect(fingerprint).not.toHaveBeenCalled();
  });

  it("cancels at the absolute worker runtime limit despite code progress", async () => {
    let n = 0;
    vi.spyOn(git, "worktreeFingerprint").mockImplementation(async () => {
      n += 1;
      return `fp-${n}`;
    });
    const cancel = vi.fn().mockResolvedValue(undefined);
    let resolveWait: (value: { status: string }) => void = () => {};
    const run = {
      id: "run-too-long",
      wait: () =>
        new Promise<{ status: string }>((resolve) => {
          resolveWait = resolve;
        }),
      cancel,
      supports: () => true,
    };

    const pending = waitWithHeartbeat(run, "worker/test", {
      cwd: "/tmp/repo",
      requireCodeAfterMs: 20,
      maxRunMs: 70,
    });

    await expect(pending).rejects.toBeInstanceOf(WorkerRunTimeoutError);
    expect(cancel).toHaveBeenCalledOnce();
    resolveWait({ status: "cancelled" });
  });
});
