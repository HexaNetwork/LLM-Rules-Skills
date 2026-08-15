import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveHarnessPaths } from "../../src/application/paths.js";
import {
  RunStateArtifactError,
  RunStateConflictError,
  RunStateError,
  RunStateFencingError,
  RunStateIdempotencyConflictError,
  RunStateLeaseError,
  runArtifactPath,
  type MutationContext,
  type RunStatePort,
  type RunStateSnapshot,
} from "../../src/application/run-state-port.js";
import { createRunState, type RunState, type TransitionResult } from "../../src/domain.js";
import { FilesystemRunStatePort } from "../../src/infrastructure/state/filesystem-run-state-port.js";
import { RunStore } from "../../src/store.js";
import { createProjectFixture } from "../testkit/project-fixture.js";

const NOW = "2026-08-14T12:00:00.000Z";

/**
 * Adapter-agnostic RunStatePort contract (ADR 0016). Every adapter —
 * FilesystemRunStatePort must pass this suite so the host engine can rely on it.
 */
export type RunStatePortContractHarness = {
  port: RunStatePort;
  /** Create a run at its initial durable revision and return the snapshot. */
  createRun(runId: string): Promise<RunStateSnapshot>;
  cleanup(): Promise<void>;
};

let mutationCounter = 0;

function mutationContext(partial: Partial<MutationContext> = {}): MutationContext {
  mutationCounter += 1;
  return {
    requestId: `request-${mutationCounter}`,
    idempotencyKey: `key-${mutationCounter}`,
    ...partial,
  };
}

function transitionFrom(
  snapshot: RunStateSnapshot,
  eventType: string,
  change: Partial<RunState> = {},
): TransitionResult {
  return {
    state: { ...snapshot.state, ...change, updatedAt: NOW },
    events: [{ type: eventType, at: NOW, detail: {} }],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function describeRunStatePortContract(
  adapterName: string,
  makeHarness: () => Promise<RunStatePortContractHarness>,
): void {
  describe(`RunStatePort contract: ${adapterName}`, () => {
    let harness: RunStatePortContractHarness;
    let runCounter = 0;

    beforeEach(async () => {
      harness = await makeHarness();
    });

    afterEach(async () => {
      await harness.cleanup();
    });

    async function createRun(): Promise<{ runId: string; snapshot: RunStateSnapshot }> {
      runCounter += 1;
      const runId = `contract-run-${runCounter}`;
      return { runId, snapshot: await harness.createRun(runId) };
    }

    it("loads the current snapshot with its revision", async () => {
      const { runId, snapshot } = await createRun();
      const loaded = await harness.port.loadSnapshot(runId);
      expect(loaded.revision).toBe(snapshot.revision);
      expect(loaded.state).toEqual(snapshot.state);
    });

    it("applies a compare-and-swap transition with events and artifacts", async () => {
      const { runId, snapshot } = await createRun();
      const result = await harness.port.compareAndSwap(runId, {
        ...mutationContext(),
        expectedRevision: snapshot.revision,
        transition: transitionFrom(snapshot, "reflect.drafted", { phase: "reflecting" }),
        artifacts: [{ ref: { kind: "packet", id: "pkt-1" }, contents: "{\"role\":\"reflector\"}" }],
      });

      expect(result.revision).toBe(snapshot.revision + 1);
      expect(result.state.phase).toBe("reflecting");
      expect(result.state.lastEventSequence).toBe(snapshot.state.lastEventSequence + 1);

      const loaded = await harness.port.loadSnapshot(runId);
      expect(loaded.revision).toBe(result.revision);
      expect(loaded.state.phase).toBe("reflecting");
      expect(await harness.port.readArtifact(runId, { kind: "packet", id: "pkt-1" })).toBe(
        "{\"role\":\"reflector\"}",
      );
    });

    it("rejects a stale expected revision without changing state", async () => {
      const { runId, snapshot } = await createRun();
      await harness.port.compareAndSwap(runId, {
        ...mutationContext(),
        expectedRevision: snapshot.revision,
        transition: transitionFrom(snapshot, "reflect.drafted", { phase: "reflecting" }),
      });

      const stale = await harness.port
        .compareAndSwap(runId, {
          ...mutationContext(),
          expectedRevision: snapshot.revision,
          transition: transitionFrom(snapshot, "reflect.drafted", { phase: "planning" }),
        })
        .catch((error: unknown) => error);
      expect(stale).toBeInstanceOf(RunStateConflictError);
      expect((stale as RunStateError).code).toBe("stale_revision");

      const loaded = await harness.port.loadSnapshot(runId);
      expect(loaded.revision).toBe(snapshot.revision + 1);
      expect(loaded.state.phase).toBe("reflecting");
    });

    it("rejects a transition whose base revision differs from the expected revision", async () => {
      const { runId, snapshot } = await createRun();
      const transition = transitionFrom(snapshot, "reflect.drafted");
      const invalid = await harness.port
        .compareAndSwap(runId, {
          ...mutationContext(),
          expectedRevision: snapshot.revision + 5,
          transition,
        })
        .catch((error: unknown) => error);
      expect(invalid).toBeInstanceOf(RunStateError);
      expect((invalid as RunStateError).code).toBe("invalid_mutation");
    });

    it("replays an idempotent compare-and-swap retry without duplicating events or revisions", async () => {
      const { runId, snapshot } = await createRun();
      const context = mutationContext();
      const transition = transitionFrom(snapshot, "reflect.drafted", { phase: "reflecting" });
      const first = await harness.port.compareAndSwap(runId, {
        ...context,
        expectedRevision: snapshot.revision,
        transition,
      });

      // Lost response: the caller retries with a fresh request ID but the
      // same idempotency key and payload.
      const retry = await harness.port.compareAndSwap(runId, {
        ...mutationContext({ idempotencyKey: context.idempotencyKey }),
        expectedRevision: snapshot.revision,
        transition,
      });
      expect(retry).toEqual(first);

      const loaded = await harness.port.loadSnapshot(runId);
      expect(loaded.revision).toBe(first.revision);
      expect(loaded.state.lastEventSequence).toBe(first.state.lastEventSequence);
    });

    it("rejects reuse of an idempotency key with a different payload", async () => {
      const { runId, snapshot } = await createRun();
      const context = mutationContext();
      await harness.port.compareAndSwap(runId, {
        ...context,
        expectedRevision: snapshot.revision,
        transition: transitionFrom(snapshot, "reflect.drafted", { phase: "reflecting" }),
      });

      const conflict = await harness.port
        .compareAndSwap(runId, {
          ...mutationContext({ idempotencyKey: context.idempotencyKey }),
          expectedRevision: snapshot.revision,
          transition: transitionFrom(snapshot, "reflect.drafted", { phase: "planning" }),
        })
        .catch((error: unknown) => error);
      expect(conflict).toBeInstanceOf(RunStateIdempotencyConflictError);
      expect((conflict as RunStateError).code).toBe("idempotency_conflict");
    });

    it("appends events idempotently", async () => {
      const { runId, snapshot } = await createRun();
      const context = mutationContext();
      const first = await harness.port.appendEvent(runId, {
        ...context,
        type: "run.note_added",
        detail: { note: "hello" },
      });
      expect(first.revision).toBe(snapshot.revision + 1);
      expect(first.state.lastEventSequence).toBe(snapshot.state.lastEventSequence + 1);

      const retry = await harness.port.appendEvent(runId, {
        ...mutationContext({ idempotencyKey: context.idempotencyKey }),
        type: "run.note_added",
        detail: { note: "hello" },
      });
      expect(retry).toEqual(first);
      expect((await harness.port.loadSnapshot(runId)).revision).toBe(first.revision);

      const conflict = await harness.port
        .appendEvent(runId, {
          ...mutationContext({ idempotencyKey: context.idempotencyKey }),
          type: "run.note_added",
          detail: { note: "different" },
        })
        .catch((error: unknown) => error);
      expect(conflict).toBeInstanceOf(RunStateIdempotencyConflictError);
    });

    it("appends session steps idempotently and reads them back", async () => {
      const { runId } = await createRun();
      const context = mutationContext();
      const steps = [
        { kind: "marker", text: "start" },
        { kind: "line", text: "working on /t claim" },
      ];
      await harness.port.appendSessionSteps(runId, "session-1", steps, context);
      await harness.port.appendSessionSteps(runId, "session-1", steps, {
        ...mutationContext(),
        idempotencyKey: context.idempotencyKey,
      });

      const raw = await harness.port.readArtifact(runId, { kind: "session-steps", id: "session-1" });
      const lines = raw?.trim().split(/\r?\n/) ?? [];
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[1]!)).toEqual({ kind: "line", text: "working on /t claim" });
    });

    it("round-trips artifacts by typed identifier and reports absent ones", async () => {
      const { runId } = await createRun();
      expect(await harness.port.readArtifact(runId, { kind: "packet", id: "absent" })).toBeUndefined();

      await harness.port.writeArtifact(
        runId,
        { kind: "document", name: "brief" },
        "# Brief\n",
        mutationContext(),
      );
      expect(await harness.port.readArtifact(runId, { kind: "document", name: "brief" })).toBe(
        "# Brief\n",
      );

      // Whole-content writes are naturally idempotent.
      await harness.port.writeArtifact(
        runId,
        { kind: "document", name: "brief" },
        "# Brief\n",
        mutationContext(),
      );
      expect(await harness.port.readArtifact(runId, { kind: "document", name: "brief" })).toBe(
        "# Brief\n",
      );
    });

    it("rejects invalid identifiers, unknown documents, and oversize artifacts", async () => {
      const { runId } = await createRun();
      const invalidId = await harness.port
        .writeArtifact(runId, { kind: "packet", id: "../escape" }, "{}", mutationContext())
        .catch((error: unknown) => error);
      expect(invalidId).toBeInstanceOf(RunStateArtifactError);
      expect((invalidId as RunStateError).code).toBe("invalid_artifact_ref");

      const unknownDocument = await harness.port
        .writeArtifact(
          runId,
          { kind: "document", name: "secrets" as never },
          "nope",
          mutationContext(),
        )
        .catch((error: unknown) => error);
      expect(unknownDocument).toBeInstanceOf(RunStateArtifactError);

      const oversize = await harness.port
        .writeArtifact(runId, { kind: "activity" }, "x".repeat(256_001), mutationContext())
        .catch((error: unknown) => error);
      expect(oversize).toBeInstanceOf(RunStateArtifactError);
      expect((oversize as RunStateError).code).toBe("artifact_too_large");

      const appendOnly = await harness.port
        .writeArtifact(runId, { kind: "session-steps", id: "s-1" }, "{}", mutationContext())
        .catch((error: unknown) => error);
      expect(appendOnly).toBeInstanceOf(RunStateArtifactError);
      expect((appendOnly as RunStateError).code).toBe("invalid_artifact_ref");
    });

    it("records, observes, and clears cancellation and stop flags", async () => {
      const { runId } = await createRun();
      expect(await harness.port.cancellationRequested(runId)).toBe(false);
      expect(await harness.port.stopRequested(runId)).toBe(false);

      await harness.port.requestCancellation(runId, mutationContext());
      await harness.port.requestStop(runId, mutationContext());
      expect(await harness.port.cancellationRequested(runId)).toBe(true);
      expect(await harness.port.stopRequested(runId)).toBe(true);

      await harness.port.clearCancellation(runId, mutationContext());
      await harness.port.clearStop(runId, mutationContext());
      expect(await harness.port.cancellationRequested(runId)).toBe(false);
      expect(await harness.port.stopRequested(runId)).toBe(false);
    });

    it("issues one lease per run and renews on same-instance re-acquire", async () => {
      const { runId } = await createRun();
      const lease = await harness.port.acquireLease(runId, {
        workerInstanceId: "worker-a",
        ttlMs: 60_000,
        requestId: "req-lease-1",
      });
      expect(lease.fencingToken).toBe(1);
      expect(await harness.port.currentLease(runId)).toEqual(lease);

      const held = await harness.port
        .acquireLease(runId, {
          workerInstanceId: "worker-b",
          ttlMs: 60_000,
          requestId: "req-lease-2",
        })
        .catch((error: unknown) => error);
      expect(held).toBeInstanceOf(RunStateLeaseError);
      expect((held as RunStateError).code).toBe("lease_held");

      // Bootstrap retry by the same instance renews instead of failing.
      const renewed = await harness.port.acquireLease(runId, {
        workerInstanceId: "worker-a",
        ttlMs: 60_000,
        requestId: "req-lease-3",
      });
      expect(renewed.fencingToken).toBe(lease.fencingToken);
      expect(Date.parse(renewed.expiresAt)).toBeGreaterThanOrEqual(Date.parse(lease.expiresAt));
    });

    it("renews and releases a lease only with the matching token", async () => {
      const { runId } = await createRun();
      const lease = await harness.port.acquireLease(runId, {
        workerInstanceId: "worker-a",
        ttlMs: 60_000,
        requestId: "req-lease-1",
      });

      const wrongToken = await harness.port
        .renewLease(runId, {
          workerInstanceId: "worker-a",
          fencingToken: lease.fencingToken + 1,
          ttlMs: 60_000,
          requestId: "req-lease-2",
        })
        .catch((error: unknown) => error);
      expect(wrongToken).toBeInstanceOf(RunStateFencingError);

      const renewed = await harness.port.renewLease(runId, {
        workerInstanceId: "worker-a",
        fencingToken: lease.fencingToken,
        ttlMs: 120_000,
        requestId: "req-lease-3",
      });
      expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(lease.expiresAt));

      await harness.port.releaseLease(runId, {
        workerInstanceId: "worker-a",
        fencingToken: lease.fencingToken,
        requestId: "req-lease-4",
      });
      expect(await harness.port.currentLease(runId)).toBeUndefined();
      // Release is idempotent.
      await harness.port.releaseLease(runId, {
        workerInstanceId: "worker-a",
        fencingToken: lease.fencingToken,
        requestId: "req-lease-5",
      });
    });

    it("lets a replacement worker take over an expired lease with a greater fencing token", async () => {
      const { runId } = await createRun();
      const first = await harness.port.acquireLease(runId, {
        workerInstanceId: "worker-a",
        ttlMs: 30,
        requestId: "req-lease-1",
      });
      await sleep(80);
      expect(await harness.port.currentLease(runId)).toBeUndefined();

      const second = await harness.port.acquireLease(runId, {
        workerInstanceId: "worker-b",
        ttlMs: 60_000,
        requestId: "req-lease-2",
      });
      expect(second.fencingToken).toBeGreaterThan(first.fencingToken);
      expect(await harness.port.currentLease(runId)).toEqual(second);
    });

    it("fences stale-worker state mutations after lease replacement", async () => {
      const { runId, snapshot } = await createRun();
      const lease = await harness.port.acquireLease(runId, {
        workerInstanceId: "worker-a",
        ttlMs: 60_000,
        requestId: "req-lease-1",
      });

      // Mutations without the active lease's token are rejected.
      const noToken = await harness.port
        .compareAndSwap(runId, {
          ...mutationContext(),
          expectedRevision: snapshot.revision,
          transition: transitionFrom(snapshot, "reflect.drafted", { phase: "reflecting" }),
        })
        .catch((error: unknown) => error);
      expect(noToken).toBeInstanceOf(RunStateLeaseError);
      expect((noToken as RunStateError).code).toBe("lease_required");

      // The lease holder mutates with its fencing token.
      const advanced = await harness.port.compareAndSwap(runId, {
        ...mutationContext({ fencingToken: lease.fencingToken, workerInstanceId: "worker-a" }),
        expectedRevision: snapshot.revision,
        transition: transitionFrom(snapshot, "reflect.drafted", { phase: "reflecting" }),
      });
      expect(advanced.revision).toBe(snapshot.revision + 1);

      // Worker A is replaced: its lease expires and worker B takes over.
      await harness.port.releaseLease(runId, {
        workerInstanceId: "worker-a",
        fencingToken: lease.fencingToken,
        requestId: "req-lease-2",
      });
      const replacement = await harness.port.acquireLease(runId, {
        workerInstanceId: "worker-b",
        ttlMs: 60_000,
        requestId: "req-lease-3",
      });
      expect(replacement.fencingToken).toBeGreaterThan(lease.fencingToken);

      // The stale worker's mutations are now rejected by fencing.
      const stale = await harness.port
        .compareAndSwap(runId, {
          ...mutationContext({ fencingToken: lease.fencingToken, workerInstanceId: "worker-a" }),
          expectedRevision: advanced.revision,
          transition: transitionFrom(advanced, "run.note_added"),
        })
        .catch((error: unknown) => error);
      expect(stale).toBeInstanceOf(RunStateFencingError);
      expect((stale as RunStateError).code).toBe("stale_fencing_token");

      const staleEvent = await harness.port
        .appendEvent(runId, {
          ...mutationContext({ fencingToken: lease.fencingToken, workerInstanceId: "worker-a" }),
          type: "run.note_added",
        })
        .catch((error: unknown) => error);
      expect(staleEvent).toBeInstanceOf(RunStateFencingError);

      // The replacement worker advances normally.
      const current = await harness.port.loadSnapshot(runId);
      const resumed = await harness.port.compareAndSwap(runId, {
        ...mutationContext({ fencingToken: replacement.fencingToken, workerInstanceId: "worker-b" }),
        expectedRevision: current.revision,
        transition: transitionFrom(current, "run.note_added"),
      });
      expect(resumed.revision).toBe(advanced.revision + 1);
    });
  });
}

describeRunStatePortContract("FilesystemRunStatePort", async () => {
  const fixture = await createProjectFixture();
  const store = new RunStore(fixture.config, resolveHarnessPaths(fixture.config).stateRoot);
  await store.initialize();
  const port = new FilesystemRunStatePort(store);
  return {
    port,
    async createRun(runId: string) {
      await store.create(createRunState(runId, "Contract idea", NOW));
      return port.loadSnapshot(runId);
    },
    cleanup: () => fixture.cleanup(),
  };
});

describe("FilesystemRunStatePort storage layout", () => {
  it("writes artifacts only at their fixed run-relative paths", async () => {
    const fixture = await createProjectFixture();
    try {
      const store = new RunStore(fixture.config, resolveHarnessPaths(fixture.config).stateRoot);
      await store.initialize();
      const port = new FilesystemRunStatePort(store);
      const runId = "layout-run";
      await store.create(createRunState(runId, "Layout idea", NOW));

      await port.writeArtifact(runId, { kind: "packet", id: "pkt-9" }, "{}", mutationContext());
      await port.writeArtifact(
        runId,
        { kind: "task-artifact", taskId: "task-1", name: "diff.patch" },
        "patch",
        mutationContext(),
      );
      expect(runArtifactPath({ kind: "packet", id: "pkt-9" })).toBe("packets/pkt-9.json");
      expect(await store.readText(runId, "packets/pkt-9.json")).toBe("{}");
      expect(await store.readText(runId, "tasks/task-1/diff.patch")).toBe("patch");

      // Cancellation flags keep the existing on-disk contract.
      await port.requestCancellation(runId, mutationContext());
      expect(await store.readText(runId, "cancel.request")).toContain("request-");
    } finally {
      await fixture.cleanup();
    }
  });
});
