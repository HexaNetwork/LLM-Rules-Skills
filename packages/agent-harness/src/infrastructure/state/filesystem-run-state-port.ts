import { createHash } from "node:crypto";
import {
  APPEND_ONLY_ARTIFACT_KINDS,
  assertArtifactSize,
  runArtifactPath,
  RunStateArtifactError,
  RunStateConflictError,
  RunStateError,
  RunStateFencingError,
  RunStateIdempotencyConflictError,
  RunStateLeaseError,
  type AppendEventMutation,
  type AcquireLeaseInput,
  type CasStateMutation,
  type MutationContext,
  type ReleaseLeaseInput,
  type RenewLeaseInput,
  type RunArtifactRef,
  type RunLease,
  type RunStatePort,
  type RunStateSnapshot,
} from "../../application/run-state-port.js";
import type { RunStore } from "../../store.js";

/**
 * Host-side RunStatePort over the durable RunStore (ADR 0016). State
 * mutations serialize on the per-run lock and reuse the store's transition
 * journal and atomic replace; session steps, artifacts, flags, and leases are
 * deliberately lock-free because they flow while the advancing worker holds
 * the run lock. Lease acquisition is serialized by the host's container
 * lifecycle (one worker created at a time); the fencing token — not the lease
 * file write — is what fences a stale worker's mutations.
 */
export class FilesystemRunStatePort implements RunStatePort {
  private readonly now: () => Date;

  constructor(
    private readonly store: RunStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async loadSnapshot(runId: string): Promise<RunStateSnapshot> {
    const state = await this.store.load(runId);
    return { state, revision: state.revision };
  }

  async compareAndSwap(runId: string, mutation: CasStateMutation): Promise<RunStateSnapshot> {
    if (mutation.transition.state.revision !== mutation.expectedRevision) {
      throw new RunStateError(
        "invalid_mutation",
        `Transition for run ${runId} is based on revision ${mutation.transition.state.revision}; expected revision is ${mutation.expectedRevision}`,
        { runId, expectedRevision: mutation.expectedRevision },
      );
    }
    // requestId is excluded: a retry correlates by idempotency key, not request.
    const payload = [
      mutation.expectedRevision,
      mutation.transition,
      mutation.artifacts ?? [],
      mutation.fencingToken,
    ];
    return this.store.withLock(runId, async () => {
      const replayed = await this.replayIdempotent(
        runId,
        "compare-and-swap",
        mutation,
        payload,
      );
      if (replayed) return replayed.snapshot as RunStateSnapshot;

      await this.assertMutationFencing(runId, mutation.fencingToken);
      const current = await this.store.load(runId);
      if (current.revision !== mutation.expectedRevision) {
        throw new RunStateConflictError(runId, mutation.expectedRevision, current.revision);
      }
      const next = await this.store.persistTransition(
        runId,
        mutation.transition,
        (mutation.artifacts ?? []).map((artifact) => {
          assertArtifactSize(artifact.ref, artifact.contents);
          return { relativePath: runArtifactPath(artifact.ref), contents: artifact.contents };
        }),
      );
      const snapshot: RunStateSnapshot = { state: next, revision: next.revision };
      await this.recordIdempotent(runId, "compare-and-swap", mutation, payload, snapshot);
      return snapshot;
    });
  }

  async appendEvent(runId: string, mutation: AppendEventMutation): Promise<RunStateSnapshot> {
    const payload = [mutation.type, mutation.detail ?? {}, mutation.fencingToken];
    return this.store.withLock(runId, async () => {
      const replayed = await this.replayIdempotent(runId, "append-event", mutation, payload);
      if (replayed) return replayed.snapshot as RunStateSnapshot;

      await this.assertMutationFencing(runId, mutation.fencingToken);
      const current = await this.store.load(runId);
      const next = await this.store.record(current, mutation.type, mutation.detail ?? {});
      const snapshot: RunStateSnapshot = { state: next, revision: next.revision };
      await this.recordIdempotent(runId, "append-event", mutation, payload, snapshot);
      return snapshot;
    });
  }

  async appendSessionSteps(
    runId: string,
    sessionId: string,
    steps: unknown[],
    context: MutationContext,
  ): Promise<void> {
    const ref: RunArtifactRef = { kind: "session-steps", id: sessionId };
    const path = runArtifactPath(ref);
    if (steps.length === 0) return;
    const payload = [sessionId, steps];
    const replayed = await this.replayIdempotent(runId, "append-session-steps", context, payload);
    if (replayed) return;
    for (const step of steps) {
      const line = JSON.stringify(step);
      assertArtifactSize(ref, line);
      await this.store.appendJsonl(runId, path, step);
    }
    // A crash between the append and this record can duplicate lines on
    // retry; the window is one file write and callers treat steps as a log.
    await this.recordIdempotent(runId, "append-session-steps", context, payload);
  }

  async readArtifact(runId: string, ref: RunArtifactRef): Promise<string | undefined> {
    const path = runArtifactPath(ref);
    try {
      return await this.store.readText(runId, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async writeArtifact(
    runId: string,
    ref: RunArtifactRef,
    contents: string,
    context: MutationContext,
  ): Promise<void> {
    if (APPEND_ONLY_ARTIFACT_KINDS.has(ref.kind)) {
      throw new RunStateArtifactError(
        "invalid_artifact_ref",
        `Artifact kind "${ref.kind}" is append-only; use appendSessionSteps`,
        { kind: ref.kind },
      );
    }
    assertArtifactSize(ref, contents);
    if (context.fencingToken !== undefined) {
      await this.assertMutationFencing(runId, context.fencingToken);
    }
    await this.store.writeText(runId, runArtifactPath(ref), contents);
  }

  async requestCancellation(runId: string, context: MutationContext): Promise<void> {
    await this.store.writeJson(runId, "cancel.request", {
      at: this.now().toISOString(),
      by: context.workerInstanceId ?? "host",
      requestId: context.requestId,
    });
  }

  async cancellationRequested(runId: string): Promise<boolean> {
    return this.flagPresent(runId, "cancel.request");
  }

  async clearCancellation(runId: string, _context: MutationContext): Promise<void> {
    await this.store.remove(runId, "cancel.request");
  }

  async requestStop(runId: string, context: MutationContext): Promise<void> {
    await this.store.writeJson(runId, "stop.request", {
      at: this.now().toISOString(),
      by: context.workerInstanceId ?? "host",
      requestId: context.requestId,
    });
  }

  async stopRequested(runId: string): Promise<boolean> {
    return this.flagPresent(runId, "stop.request");
  }

  async clearStop(runId: string, _context: MutationContext): Promise<void> {
    await this.store.remove(runId, "stop.request");
  }

  async acquireLease(runId: string, input: AcquireLeaseInput): Promise<RunLease> {
    const existing = await this.readLease(runId);
    if (existing && !this.leaseExpired(existing)) {
      if (existing.workerInstanceId !== input.workerInstanceId) {
        throw new RunStateLeaseError(
          "lease_held",
          `Run ${runId} lease is held by worker ${existing.workerInstanceId} until ${existing.expiresAt}`,
          { runId, workerInstanceId: existing.workerInstanceId, expiresAt: existing.expiresAt },
        );
      }
      // Same-instance re-acquire is a bootstrap retry: renew in place.
      return this.renewLease(runId, {
        workerInstanceId: input.workerInstanceId,
        fencingToken: existing.fencingToken,
        ttlMs: input.ttlMs,
        requestId: input.requestId,
      });
    }
    const fencing = await this.readFencing(runId);
    const lease: RunLease = {
      runId,
      workerInstanceId: input.workerInstanceId,
      fencingToken: fencing.latestToken + 1,
      acquiredAt: this.now().toISOString(),
      expiresAt: new Date(this.now().getTime() + Math.max(0, input.ttlMs)).toISOString(),
    };
    await this.writeFencing(runId, { latestToken: lease.fencingToken });
    await this.store.writeJson(runId, "lease.json", lease);
    return lease;
  }

  async renewLease(runId: string, input: RenewLeaseInput): Promise<RunLease> {
    const existing = await this.readLease(runId);
    if (!existing) {
      throw new RunStateLeaseError("lease_required", `Run ${runId} has no lease to renew`, {
        runId,
        workerInstanceId: input.workerInstanceId,
      });
    }
    if (existing.workerInstanceId !== input.workerInstanceId) {
      throw new RunStateLeaseError(
        "lease_held",
        `Run ${runId} lease is held by worker ${existing.workerInstanceId}`,
        { runId, workerInstanceId: existing.workerInstanceId },
      );
    }
    if (existing.fencingToken !== input.fencingToken) {
      throw new RunStateFencingError(
        runId,
        input.fencingToken,
        `Run ${runId} lease token is ${existing.fencingToken}; renewal presented ${input.fencingToken}`,
      );
    }
    if (this.leaseExpired(existing)) {
      throw new RunStateLeaseError(
        "lease_expired",
        `Run ${runId} lease expired at ${existing.expiresAt}; reacquire instead of renewing`,
        { runId, expiresAt: existing.expiresAt },
      );
    }
    const renewed: RunLease = {
      ...existing,
      expiresAt: new Date(this.now().getTime() + Math.max(0, input.ttlMs)).toISOString(),
    };
    await this.store.writeJson(runId, "lease.json", renewed);
    return renewed;
  }

  async releaseLease(runId: string, input: ReleaseLeaseInput): Promise<void> {
    const existing = await this.readLease(runId);
    if (!existing) return;
    if (existing.workerInstanceId !== input.workerInstanceId) {
      throw new RunStateLeaseError(
        "lease_held",
        `Run ${runId} lease is held by worker ${existing.workerInstanceId}`,
        { runId, workerInstanceId: existing.workerInstanceId },
      );
    }
    if (existing.fencingToken !== input.fencingToken) {
      throw new RunStateFencingError(
        runId,
        input.fencingToken,
        `Run ${runId} lease token is ${existing.fencingToken}; release presented ${input.fencingToken}`,
      );
    }
    await this.store.remove(runId, "lease.json");
  }

  async currentLease(runId: string): Promise<RunLease | undefined> {
    const lease = await this.readLease(runId);
    if (!lease || this.leaseExpired(lease)) return undefined;
    return lease;
  }

  /**
   * Fencing gate for state mutations. A presented token must not be older
   * than the latest issued token and must equal the active lease's token.
   * When a lease is active, mutations without its token are rejected: the
   * host records cancellation through the unfenced flag operations instead.
   */
  private async assertMutationFencing(runId: string, token: number | undefined): Promise<void> {
    const fencing = await this.readFencing(runId);
    const lease = await this.readLease(runId);
    const active = lease && !this.leaseExpired(lease) ? lease : undefined;
    if (token === undefined) {
      if (active) {
        throw new RunStateLeaseError(
          "lease_required",
          `Run ${runId} lease is held by worker ${active.workerInstanceId}; mutations must carry fencing token ${active.fencingToken}`,
          { runId, workerInstanceId: active.workerInstanceId },
        );
      }
      return;
    }
    if (!Number.isInteger(token) || token <= 0) {
      throw new RunStateFencingError(runId, token, `Invalid fencing token ${token} for run ${runId}`);
    }
    if (token < fencing.latestToken) {
      throw new RunStateFencingError(
        runId,
        token,
        `Fencing token ${token} is stale for run ${runId}; latest issued token is ${fencing.latestToken}`,
      );
    }
    if (active && active.fencingToken !== token) {
      throw new RunStateFencingError(
        runId,
        token,
        `Run ${runId} lease is held by worker ${active.workerInstanceId} with token ${active.fencingToken}; mutation presented ${token}`,
      );
    }
  }

  private async flagPresent(runId: string, name: string): Promise<boolean> {
    try {
      await this.store.readText(runId, name);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private leaseExpired(lease: RunLease): boolean {
    return Date.parse(lease.expiresAt) <= this.now().getTime();
  }

  private async readLease(runId: string): Promise<RunLease | undefined> {
    return this.readJsonOrUndefined(runId, "lease.json") as Promise<RunLease | undefined>;
  }

  private async readFencing(runId: string): Promise<{ latestToken: number }> {
    const value = await this.readJsonOrUndefined(runId, "fencing.json");
    if (
      typeof value === "object" &&
      value != null &&
      Number.isInteger((value as { latestToken?: unknown }).latestToken)
    ) {
      return value as { latestToken: number };
    }
    return { latestToken: 0 };
  }

  private async writeFencing(runId: string, fencing: { latestToken: number }): Promise<void> {
    await this.store.writeJson(runId, "fencing.json", fencing);
  }

  private async readJsonOrUndefined(runId: string, relativePath: string): Promise<unknown> {
    try {
      return await this.store.readJson(runId, relativePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private idempotencyPath(context: MutationContext): string {
    const digest = createHash("sha256").update(context.idempotencyKey).digest("hex");
    return `idempotency/${digest}.json`;
  }

  /**
   * Returns the recorded result when this exact mutation already applied,
   * throws when the key was reused for a different payload, and returns
   * undefined when the key is new.
   */
  private async replayIdempotent(
    runId: string,
    operation: string,
    context: MutationContext,
    payload: unknown,
  ): Promise<{ snapshot?: RunStateSnapshot } | undefined> {
    const existing = await this.readJsonOrUndefined(runId, this.idempotencyPath(context));
    if (existing === undefined) return undefined;
    const record = existing as {
      operation?: unknown;
      fingerprint?: unknown;
      snapshot?: RunStateSnapshot;
    };
    if (record.operation === operation && record.fingerprint === fingerprint(payload)) {
      return { ...(record.snapshot ? { snapshot: record.snapshot } : {}) };
    }
    throw new RunStateIdempotencyConflictError(runId, context.idempotencyKey);
  }

  private async recordIdempotent(
    runId: string,
    operation: string,
    context: MutationContext,
    payload: unknown,
    snapshot?: RunStateSnapshot,
  ): Promise<void> {
    await this.store.writeJson(runId, this.idempotencyPath(context), {
      key: context.idempotencyKey,
      operation,
      fingerprint: fingerprint(payload),
      recordedAt: this.now().toISOString(),
      ...(snapshot ? { snapshot } : {}),
    });
  }
}

/** Stable JSON with sorted object keys, hashed for payload comparison. */
function fingerprint(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
