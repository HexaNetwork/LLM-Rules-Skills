import {
  RunStateArtifactError,
  RunStateConflictError,
  RunStateError,
  RunStateFencingError,
  RunStateIdempotencyConflictError,
  RunStateLeaseError,
  type AcquireLeaseInput,
  type AppendEventMutation,
  type CasStateMutation,
  type MutationContext,
  type ReleaseLeaseInput,
  type RenewLeaseInput,
  type RunArtifactRef,
  type RunLease,
  type RunStatePort,
  type RunStateSnapshot,
} from "../../application/run-state-port.js";
import {
  RUN_STATE_API_AUTH_HEADER,
  RUN_STATE_API_PROTOCOL_HEADER,
  RUN_STATE_API_PROTOCOL_VERSION,
  RUN_STATE_API_REQUEST_ID_HEADER,
  runStateApiPath,
  type RunStateApiErrorBody,
  type RunStateApiResponse,
} from "../../worker/state-protocol.js";

export type RpcRunStatePortOptions = {
  endpoint: string;
  credential: string;
  fetch?: typeof globalThis.fetch;
};

/** Production worker adapter for the authenticated host-owned state API. */
export class RpcRunStatePort implements RunStatePort {
  private readonly endpoint: string;
  private readonly credential: string;
  private readonly request: typeof globalThis.fetch;

  constructor(options: RpcRunStatePortOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.credential = options.credential;
    this.request = options.fetch ?? globalThis.fetch;
  }

  loadSnapshot(runId: string): Promise<RunStateSnapshot> {
    return this.call(runId, "snapshot", "GET");
  }

  compareAndSwap(runId: string, mutation: CasStateMutation): Promise<RunStateSnapshot> {
    return this.call(runId, "compare-and-swap", "POST", mutation, mutation.requestId);
  }

  appendEvent(runId: string, mutation: AppendEventMutation): Promise<RunStateSnapshot> {
    return this.call(runId, "events", "POST", mutation, mutation.requestId);
  }

  async appendSessionSteps(
    runId: string,
    sessionId: string,
    steps: unknown[],
    context: MutationContext,
  ): Promise<void> {
    await this.call(runId, "session-steps", "POST", { sessionId, steps, ...context }, context.requestId);
  }

  async readArtifact(runId: string, ref: RunArtifactRef): Promise<string | undefined> {
    const result = await this.call<{ contents: string | null }>(runId, "artifacts/read", "POST", { ref });
    return result.contents ?? undefined;
  }

  async writeArtifact(
    runId: string,
    ref: RunArtifactRef,
    contents: string,
    context: MutationContext,
  ): Promise<void> {
    await this.call(runId, "artifacts/write", "POST", { ref, contents, ...context }, context.requestId);
  }

  async deleteArtifact(runId: string, ref: RunArtifactRef, context: MutationContext): Promise<void> {
    await this.call(runId, "artifacts/delete", "POST", { ref, ...context }, context.requestId);
  }

  async listArtifacts(runId: string, kind: "session"): Promise<RunArtifactRef[]> {
    return (await this.call<{ artifacts: RunArtifactRef[] }>(runId, "artifacts/list", "POST", { kind })).artifacts;
  }

  async requestCancellation(runId: string, context: MutationContext): Promise<void> {
    await this.call(runId, "cancellation/request", "POST", context, context.requestId);
  }

  async cancellationRequested(runId: string): Promise<boolean> {
    return (await this.call<{ requested: boolean }>(runId, "cancellation", "GET")).requested;
  }

  async clearCancellation(runId: string, context: MutationContext): Promise<void> {
    await this.call(runId, "cancellation/clear", "POST", context, context.requestId);
  }

  async requestStop(runId: string, context: MutationContext): Promise<void> {
    await this.call(runId, "stop/request", "POST", context, context.requestId);
  }

  async stopRequested(runId: string): Promise<boolean> {
    return (await this.call<{ requested: boolean }>(runId, "stop", "GET")).requested;
  }

  async clearStop(runId: string, context: MutationContext): Promise<void> {
    await this.call(runId, "stop/clear", "POST", context, context.requestId);
  }

  acquireLease(runId: string, input: AcquireLeaseInput): Promise<RunLease> {
    return this.call(runId, "lease/acquire", "POST", input, input.requestId);
  }

  renewLease(runId: string, input: RenewLeaseInput): Promise<RunLease> {
    return this.call(runId, "lease/renew", "POST", input, input.requestId);
  }

  async releaseLease(runId: string, input: ReleaseLeaseInput): Promise<void> {
    await this.call(runId, "lease/release", "POST", input, input.requestId);
  }

  async currentLease(runId: string): Promise<RunLease | undefined> {
    return (await this.call<{ lease: RunLease | null }>(runId, "lease", "GET")).lease ?? undefined;
  }

  /** Fetch the typed, path-free worker bootstrap document. */
  bootstrap<T>(runId: string): Promise<T> {
    return this.call<T>(runId, "bootstrap", "GET");
  }

  private async call<T>(
    runId: string,
    operation: string,
    method: "GET" | "POST",
    body?: unknown,
    requestId?: string,
  ): Promise<T> {
    const response = await this.request(`${this.endpoint}${runStateApiPath(runId, operation)}`, {
      method,
      headers: {
        [RUN_STATE_API_AUTH_HEADER]: this.credential,
        [RUN_STATE_API_PROTOCOL_HEADER]: String(RUN_STATE_API_PROTOCOL_VERSION),
        ...(requestId ? { [RUN_STATE_API_REQUEST_ID_HEADER]: requestId } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let envelope: RunStateApiResponse<T>;
    try {
      envelope = (await response.json()) as RunStateApiResponse<T>;
    } catch {
      throw new Error(`State service returned HTTP ${response.status} with a non-JSON response`);
    }
    if (!envelope.ok) throw rpcError(envelope);
    return envelope.result;
  }
}

function rpcError(body: RunStateApiErrorBody): Error {
  const { code, message, details = {} } = body.error;
  switch (code) {
    case "stale_revision":
      return new RunStateConflictError(
        String(details.runId ?? "unknown"),
        Number(details.expectedRevision ?? -1),
        Number(details.actualRevision ?? -1),
      );
    case "idempotency_conflict":
      return new RunStateIdempotencyConflictError(
        String(details.runId ?? "unknown"),
        String(details.idempotencyKey ?? "unknown"),
      );
    case "lease_held":
    case "lease_required":
    case "lease_expired":
      return new RunStateLeaseError(code, message, details);
    case "stale_fencing_token":
      return new RunStateFencingError(
        String(details.runId ?? "unknown"),
        Number(details.token ?? -1),
        message,
      );
    case "artifact_too_large":
    case "invalid_artifact_ref":
      return new RunStateArtifactError(code, message, details);
    case "invalid_mutation":
      return new RunStateError(code, message, details);
    default:
      return new Error(`State service ${code}: ${message}`);
  }
}
