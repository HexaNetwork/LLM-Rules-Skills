/**
 * Versioned worker liveness contract. Workflow, export, and durable state
 * stay on the host. Host and worker negotiate protocol + harness versions
 * on every request.
 */

export const WORKER_RPC_PROTOCOL_VERSION = 1 as const;

/** Default listen port inside the container (published to a random host loopback port). */
export const WORKER_RPC_CONTAINER_PORT = 8787 as const;
export const WORKER_IMAGE_CLI_PATH = "/opt/agent-harness/cli" as const;
export const WORKER_ISOLATION_SELF_CHECK_PATH =
  "/opt/agent-harness/sandbox-isolation-self-check" as const;

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

/**
 * Allowlisted worker liveness actions. Host UI/CLI mutations never map here.
 */
export const WORKER_RPC_ACTIONS = ["health", "status", "shutdown"] as const;

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
