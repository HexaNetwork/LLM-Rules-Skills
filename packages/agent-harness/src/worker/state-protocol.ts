/**
 * Versioned worker-facing host state API contract (ADR 0016, plan Phase 3).
 *
 * This durable-state protocol is versioned independently from the worker
 * control contract (`WORKER_RPC_PROTOCOL_VERSION` in ./protocol.ts). The host
 * fails closed on a protocol mismatch, and every credential is bound to
 * exactly one run ID and one protocol version.
 */

export const RUN_STATE_API_PROTOCOL_VERSION = 1 as const;

/** URL prefix for the worker-facing state API (separate from dashboard /api/). */
export const RUN_STATE_API_PREFIX = "/state-api" as const;

/** Header carrying the per-run state credential. */
export const RUN_STATE_API_AUTH_HEADER = "x-harness-state-token" as const;

/** Header for state-protocol version negotiation (required, fail closed). */
export const RUN_STATE_API_PROTOCOL_HEADER = "x-harness-state-protocol" as const;

/** Header for client-supplied request correlation ids. */
export const RUN_STATE_API_REQUEST_ID_HEADER = "x-request-id" as const;

/** Max JSON body size accepted by the state API (bytes). */
export const RUN_STATE_API_MAX_BODY_BYTES = 2_000_000 as const;

/** Error codes the host model-broker API can return. */
export type RunStateApiErrorCode =
  | "stale_revision"
  | "idempotency_conflict"
  | "lease_held"
  | "lease_required"
  | "lease_expired"
  | "stale_fencing_token"
  | "artifact_too_large"
  | "invalid_artifact_ref"
  | "invalid_mutation"
  | "unauthorized"
  | "forbidden"
  | "protocol_mismatch"
  | "body_too_large"
  | "bad_request"
  | "not_found"
  | "internal";

export type RunStateApiErrorBody = {
  ok: false;
  requestId: string;
  error: {
    code: RunStateApiErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
};

export type RunStateApiOkBody<T = unknown> = {
  ok: true;
  requestId: string;
  result: T;
};

export type RunStateApiResponse<T = unknown> = RunStateApiOkBody<T> | RunStateApiErrorBody;

/** Route path for one durable-state operation on a run. */
export function runStateApiPath(runId: string, operation: string): string {
  return `${RUN_STATE_API_PREFIX}/v1/runs/${encodeURIComponent(runId)}/${operation}`;
}
