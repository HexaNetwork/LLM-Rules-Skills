import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { HarnessFailure } from "../errors.js";
import { tokensEqual } from "./auth.js";
import { dispatchWorkerAction, type WorkerHandlerContext } from "./handlers.js";
import {
  HARNESS_PACKAGE_VERSION,
  WORKER_RPC_AUTH_HEADER,
  WORKER_RPC_HARNESS_VERSION_HEADER,
  WORKER_RPC_MAX_BODY_BYTES,
  WORKER_RPC_PROTOCOL_HEADER,
  WORKER_RPC_PROTOCOL_VERSION,
  WORKER_RPC_REQUEST_ID_HEADER,
  isWorkerRpcAction,
  type WorkerRpcAction,
  type WorkerRpcErrorCode,
  type WorkerRpcResponse,
} from "./protocol.js";

export type WorkerRpcServerOptions = {
  host: string;
  port: number;
  token: string;
  handlers: WorkerHandlerContext;
  /** Override body size limit (tests). */
  maxBodyBytes?: number;
};

export type WorkerRpcServer = {
  server: Server;
  url: string;
  close(): Promise<void>;
};

/**
 * Authenticated loopback-oriented HTTP/JSON control plane for one run worker.
 * Binds to the given host/port (container typically 0.0.0.0:8787; host publishes 127.0.0.1).
 */
export async function startWorkerRpcServer(
  options: WorkerRpcServerOptions,
): Promise<WorkerRpcServer> {
  const maxBody = options.maxBodyBytes ?? WORKER_RPC_MAX_BODY_BYTES;
  const server = createServer((request, response) => {
    void handleRequest(request, response, options, maxBody);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });

  const address = server.address();
  const port =
    address && typeof address === "object" ? address.port : options.port;
  const url = `http://${options.host === "0.0.0.0" ? "127.0.0.1" : options.host}:${port}`;

  return {
    server,
    url,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: WorkerRpcServerOptions,
  maxBodyBytes: number,
): Promise<void> {
  const requestId =
    headerValue(request, WORKER_RPC_REQUEST_ID_HEADER) ?? randomUUID();

  try {
    if (!tokensEqual(options.token, headerValue(request, WORKER_RPC_AUTH_HEADER))) {
      sendJson(response, 401, errorBody("unauthorized", "Invalid or missing RPC token", requestId));
      return;
    }

    const protocolHeader = headerValue(request, WORKER_RPC_PROTOCOL_HEADER);
    if (protocolHeader != null && protocolHeader !== String(WORKER_RPC_PROTOCOL_VERSION)) {
      sendJson(
        response,
        426,
        errorBody(
          "protocol_mismatch",
          `Unsupported RPC protocol ${protocolHeader}; worker speaks ${WORKER_RPC_PROTOCOL_VERSION}`,
          requestId,
        ),
      );
      return;
    }

    const harnessHeader = headerValue(request, WORKER_RPC_HARNESS_VERSION_HEADER);
    if (harnessHeader != null && harnessHeader !== HARNESS_PACKAGE_VERSION) {
      sendJson(
        response,
        426,
        errorBody(
          "harness_version_mismatch",
          `Harness version mismatch: client ${harnessHeader}, worker ${HARNESS_PACKAGE_VERSION}`,
          requestId,
        ),
      );
      return;
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const action = resolveAction(request.method ?? "GET", url.pathname);
    if (!action) {
      sendJson(response, 404, errorBody("not_found", `Unknown path ${url.pathname}`, requestId));
      return;
    }

    let body: Record<string, unknown> = {};
    if (request.method === "POST" || request.method === "PUT") {
      body = await readJsonBody(request, maxBodyBytes);
    }

    const result = await dispatchWorkerAction(options.handlers, action, body);
    sendJson(response, 200, { ok: true, requestId, result } satisfies WorkerRpcResponse);
  } catch (error) {
    const mapped = mapError(error, requestId);
    sendJson(response, mapped.status, mapped.body);
  }
}

function resolveAction(method: string, pathname: string): WorkerRpcAction | undefined {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  // Versioned routes: /v1/<action>
  const match = normalized.match(/^\/v1\/([a-z0-9_-]+)$/i);
  if (!match) return undefined;
  const name = match[1]!;
  if (!isWorkerRpcAction(name)) return undefined;
  if (name === "health" || name === "status") {
    if (method !== "GET" && method !== "POST") return undefined;
  } else if (method !== "POST") {
    return undefined;
  }
  return name;
}

async function readJsonBody(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) {
      const error = new Error("Request body is too large");
      error.name = "WorkerBodyTooLarge";
      throw error;
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const error = new Error("JSON body must be an object");
    error.name = "WorkerBadRequest";
    throw error;
  }
  return parsed as Record<string, unknown>;
}

function mapError(
  error: unknown,
  requestId: string,
): { status: number; body: WorkerRpcResponse } {
  if (error && typeof error === "object" && (error as { name?: string }).name === "WorkerBodyTooLarge") {
    return {
      status: 413,
      body: errorBody("body_too_large", "Request body is too large", requestId),
    };
  }
  if (error && typeof error === "object" && (error as { name?: string }).name === "WorkerBadRequest") {
    return {
      status: 400,
      body: errorBody(
        "bad_request",
        error instanceof Error ? error.message : "Bad request",
        requestId,
      ),
    };
  }
  if (error instanceof HarnessFailure) {
    const status = error.kind === "execution" && !error.retriable ? 501 : 409;
    return {
      status,
      body: errorBody(
        error.kind === "execution" && !error.retriable ? "not_implemented" : "conflict",
        error.message,
        requestId,
      ),
    };
  }
  return {
    status: 500,
    body: errorBody(
      "internal",
      error instanceof Error ? error.message : String(error),
      requestId,
    ),
  };
}

function errorBody(
  code: WorkerRpcErrorCode,
  message: string,
  requestId: string,
): WorkerRpcResponse {
  return { ok: false, requestId, error: { code, message } };
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const raw = request.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(`${JSON.stringify(value)}\n`);
}
