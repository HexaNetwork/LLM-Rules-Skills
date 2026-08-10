import { describe, expect, it } from "vitest";
import { RunJobConflictError, RunJobService } from "../../src/ui/run-job-service.js";

describe("RunJobService per-run queues", () => {
  it("runs jobs for different run IDs concurrently", async () => {
    const jobs = new RunJobService();
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

    let finishedA = false;
    let finishedB = false;
    jobs.enqueue("run-a", "advance", async () => {
      startedA();
      await aHold;
      finishedA = true;
    });
    jobs.enqueue("run-b", "advance", async () => {
      startedB();
      await bHold;
      finishedB = true;
    });

    await Promise.all([aStarted, bStarted]);
    expect(jobs.get("run-a")?.status).toBe("running");
    expect(jobs.get("run-b")?.status).toBe("running");
    expect(finishedA).toBe(false);
    expect(finishedB).toBe(false);

    releaseA();
    releaseB();
    await waitFor(() => jobs.get("run-a") === undefined && jobs.get("run-b") === undefined);
    expect(finishedA).toBe(true);
    expect(finishedB).toBe(true);
  });

  it("rejects a second active mutation for the same run", async () => {
    const jobs = new RunJobService();
    let releaseFirst!: () => void;
    let startedFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      startedFirst = resolve;
    });
    const firstHold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    jobs.enqueue("run-a", "advance", async () => {
      startedFirst();
      await firstHold;
    });
    await firstStarted;

    expect(() => jobs.enqueue("run-a", "retry", async () => undefined)).toThrow(
      RunJobConflictError,
    );

    releaseFirst();
    await waitFor(() => jobs.get("run-a") === undefined);

    let releaseSecond!: () => void;
    let startedSecond!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      startedSecond = resolve;
    });
    const secondHold = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    jobs.enqueue("run-a", "advance", async () => {
      startedSecond();
      await secondHold;
    });
    await secondStarted;
    expect(() => jobs.enqueue("run-a", "retry", async () => undefined)).toThrow(
      /already has queued work/i,
    );
    releaseSecond();
    await waitFor(() => jobs.get("run-a") === undefined);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
