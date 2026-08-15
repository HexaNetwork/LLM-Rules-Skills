import { randomUUID } from "node:crypto";
import {
  HARNESS_PACKAGE_VERSION,
  WORKER_RPC_AUTH_HEADER,
  WORKER_RPC_HARNESS_VERSION_HEADER,
  WORKER_RPC_MAX_BODY_BYTES,
  WORKER_RPC_PROTOCOL_HEADER,
  WORKER_RPC_PROTOCOL_VERSION,
  WORKER_RPC_REQUEST_ID_HEADER,
  type WorkerRpcAction,
  type WorkerRpcErrorCode,
  type WorkerRpcResponse,
} from "../../worker/protocol.js";

export type WorkerRpcClientOptions = {
  /** Base URL, e.g. http://127.0.0.1:41234 */
  baseUrl: string;
  token: string;
  /** Override fetch (tests). */
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  harnessVersion?: string;
  protocolVersion?: number;
};

export class WorkerRpcClientError extends Error {
  readonly status: number;
  readonly code: WorkerRpcErrorCode;
  readonly requestId: string;

  constructor(input: {
    status: number;
    code: WorkerRpcErrorCode;
    message: string;
    requestId: string;
  }) {
    super(input.message);
    this.name = "WorkerRpcClientError";
    this.status = input.status;
    this.code = input.code;
    this.requestId = input.requestId;
  }
}

/**
 * Host-side authenticated client for a per-run worker RPC server.
 * Never logs the token; callers must not print options.token.
 */
export class WorkerRpcClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly requestTimeoutMs: number;
  private readonly harnessVersion: string;
  private readonly protocolVersion: number;

  constructor(options: WorkerRpcClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.harnessVersion = options.harnessVersion ?? HARNESS_PACKAGE_VERSION;
    this.protocolVersion = options.protocolVersion ?? WORKER_RPC_PROTOCOL_VERSION;
  }

  async health(): Promise<unknown> {
    return this.invoke("health", undefined, "GET");
  }

  async status(): Promise<unknown> {
    return this.invoke("status", undefined, "GET");
  }

  async invoke(
    action: WorkerRpcAction,
    body?: Record<string, unknown>,
    method: "GET" | "POST" = "POST",
  ): Promise<unknown> {
    const requestId = randomUUID();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/${action}`, {
        method,
        headers: {
          "content-type": "application/json; charset=utf-8",
          [WORKER_RPC_AUTH_HEADER]: this.token,
          [WORKER_RPC_REQUEST_ID_HEADER]: requestId,
          [WORKER_RPC_PROTOCOL_HEADER]: String(this.protocolVersion),
          [WORKER_RPC_HARNESS_VERSION_HEADER]: this.harnessVersion,
        },
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
        signal: controller.signal,
      });

      const text = await response.text();
      if (text.length > WORKER_RPC_MAX_BODY_BYTES * 2) {
        throw new WorkerRpcClientError({
          status: 502,
          code: "internal",
          message: "Worker response body is too large",
          requestId,
        });
      }
      let parsed: WorkerRpcResponse;
      try {
        parsed = JSON.parse(text) as WorkerRpcResponse;
      } catch {
        throw new WorkerRpcClientError({
          status: response.status,
          code: "internal",
          message: `Worker returned non-JSON (${response.status})`,
          requestId,
        });
      }
      if (!parsed.ok) {
        throw new WorkerRpcClientError({
          status: response.status,
          code: parsed.error.code,
          message: parsed.error.message,
          requestId: parsed.requestId || requestId,
        });
      }
      return parsed.result;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Test double that records invokes and returns scripted results. */
export function createFakeWorkerRpcClient(options?: {
  results?: Partial<Record<WorkerRpcAction, unknown>>;
  errors?: Partial<Record<WorkerRpcAction, WorkerRpcClientError>>;
}): WorkerRpcClient & {
  calls: Array<{ action: WorkerRpcAction; body?: Record<string, unknown> }>;
} {
  const calls: Array<{ action: WorkerRpcAction; body?: Record<string, unknown> }> = [];
  const client = new WorkerRpcClient({
    baseUrl: "http://127.0.0.1:9",
    token: "fake-token-not-used",
    fetch: async () => new Response("{}", { status: 500 }),
  }) as WorkerRpcClient & {
    calls: Array<{ action: WorkerRpcAction; body?: Record<string, unknown> }>;
  };
  client.calls = calls;
  client.invoke = async (action, body) => {
    calls.push({ action, body });
    const error = options?.errors?.[action];
    if (error) throw error;
    return options?.results?.[action] ?? { ok: true, action };
  };
  return client;
}
