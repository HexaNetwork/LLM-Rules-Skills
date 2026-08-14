/**
 * Versioned per-run worker RPC contract (ADR 0015 §6).
 * Host and worker negotiate protocol + harness versions on every request.
 */

export const WORKER_RPC_PROTOCOL_VERSION = 1 as const;

/** Default listen port inside the container (published to a random host loopback port). */
export const WORKER_RPC_CONTAINER_PORT = 8787 as const;

/** Max JSON body size accepted by the worker (bytes). */
export const WORKER_RPC_MAX_BODY_BYTES = 1_000_000 as const;

/** Header carrying the per-run RPC bearer token. */
export const WORKER_RPC_AUTH_HEADER = "x-harness-worker-token" as const;

/** Header for client-supplied request correlation ids. */
export const WORKER_RPC_REQUEST_ID_HEADER = "x-request-id" as const;

/** Header for protocol version negotiation. */
export const WORKER_RPC_PROTOCOL_HEADER = "x-harness-rpc-protocol" as const;

/** Header for harness package/config version negotiation. */
export const WORKER_RPC_HARNESS_VERSION_HEADER = "x-harness-version" as const;

/**
 * Package version string used for worker↔host negotiation.
 * Keep in sync with package.json / CLI `.version()`.
 */
export const HARNESS_PACKAGE_VERSION = "0.3.2" as const;

/** Relative path under the run directory for the RPC secret file (never logged). */
export const WORKER_RPC_SECRET_RELATIVE_PATH = "execution-secrets/rpc.token" as const;

/** Absolute path of the RPC secret inside the container (/run-state mount). */
export const WORKER_RPC_SECRET_CONTAINER_PATH =
  `/run-state/${WORKER_RPC_SECRET_RELATIVE_PATH}` as const;

/** Relative path under the run directory for the worker-only Cursor API key file. */
export const CURSOR_API_KEY_SECRET_RELATIVE_PATH =
  "execution-secrets/cursor-api-key" as const;

/** Absolute path of the Cursor API key inside the container (/run-state mount). */
export const CURSOR_API_KEY_SECRET_CONTAINER_PATH =
  `/run-state/${CURSOR_API_KEY_SECRET_RELATIVE_PATH}` as const;

/**
 * Allowlisted mutation/control actions exposed over RPC.
 * Host UI action names map onto these (see host proxy).
 */
export const WORKER_RPC_ACTIONS = [
  "health",
  "status",
  "advance",
  "initial_setup",
  "cancel",
  "retry",
  "answer",
  "note",
  "confirm_grill",
  "confirm_plan",
  "confirm_verification",
  "retry_verification_baseline",
  "resolve_installs",
  "propose_fix",
  "apply_fix",
  "accept_tree",
  "set_rag",
  "set_repository_intelligence",
  "stop",
  "prepare-export",
  "shutdown",
] as const;

export type WorkerRpcAction = (typeof WORKER_RPC_ACTIONS)[number];

export const WORKER_RPC_ACTION_SET: ReadonlySet<string> = new Set(WORKER_RPC_ACTIONS);

export type WorkerRpcErrorCode =
  | "unauthorized"
  | "protocol_mismatch"
  | "harness_version_mismatch"
  | "body_too_large"
  | "bad_request"
  | "not_found"
  | "conflict"
  | "internal"
  | "not_implemented";

export type WorkerRpcErrorBody = {
  ok: false;
  error: {
    code: WorkerRpcErrorCode;
    message: string;
  };
  requestId: string;
};

export type WorkerRpcOkBody<T = unknown> = {
  ok: true;
  requestId: string;
  result: T;
};

export type WorkerRpcResponse<T = unknown> = WorkerRpcOkBody<T> | WorkerRpcErrorBody;

export type WorkerHealthResult = {
  status: "ok";
  runId: string;
  protocolVersion: typeof WORKER_RPC_PROTOCOL_VERSION;
  harnessVersion: string;
  uptimeMs: number;
};

export type WorkerStatusResult = {
  runId: string;
  phase?: string;
  advancing: boolean;
  cancelRequested: boolean;
  protocolVersion: typeof WORKER_RPC_PROTOCOL_VERSION;
  harnessVersion: string;
};

export type WorkerCancelResult = {
  pending: boolean;
  phase?: string;
};

export type WorkerPrepareExportResult = {
  ok: true;
  noChange: boolean;
  tipSha: string;
  baseSha: string;
  treeSha: string;
  bundleHash: string;
  commitCount: number;
  manifestRelativePath: string;
  resultBundleRelativePath?: string;
};

export function isWorkerRpcAction(value: string): value is WorkerRpcAction {
  return WORKER_RPC_ACTION_SET.has(value);
}
