import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WorkerStateCredentialIssuer } from "../../../application/worker-state-credentials.js";
import type { WorkerProviderBootstrap } from "../../../worker/provider-protocol.js";
import {
  RUN_STATE_API_AUTH_HEADER,
  RUN_STATE_API_MAX_BODY_BYTES,
  RUN_STATE_API_PREFIX,
  RUN_STATE_API_PROTOCOL_HEADER,
  RUN_STATE_API_PROTOCOL_VERSION,
  RUN_STATE_API_REQUEST_ID_HEADER,
  type RunStateApiErrorCode,
  type RunStateApiResponse,
} from "../../../worker/state-protocol.js";

export type WorkerStateApiContext = {
  credentials: WorkerStateCredentialIssuer;
  issueCursorProviderBootstrap?: (
    runId: string,
    workerInstanceId: string,
  ) => Promise<WorkerProviderBootstrap>;
  renewCursorProviderBootstrap?: (
    runId: string,
    workerInstanceId: string,
    token: string,
  ) => Promise<WorkerProviderBootstrap>;
};

class BrokerApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: RunStateApiErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Exchange the short-lived sandbox token for a model-provider capability. */
export async function handleWorkerStateRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  ctx: WorkerStateApiContext,
): Promise<boolean> {
  if (!url.pathname.startsWith(`${RUN_STATE_API_PREFIX}/`)) return false;
  const requestId = headerValue(request, RUN_STATE_API_REQUEST_ID_HEADER) ?? randomUUID();
  try {
    const result = await dispatch(request, url, ctx);
    sendJson(response, 200, { ok: true, requestId, result } satisfies RunStateApiResponse);
  } catch (error) {
    const mapped =
      error instanceof BrokerApiError
        ? error
        : new BrokerApiError(500, "internal", "Worker model broker failed");
    sendJson(response, mapped.status, {
      ok: false,
      requestId,
      error: { code: mapped.code, message: mapped.message, details: mapped.details },
    } satisfies RunStateApiResponse);
  }
  return true;
}

async function dispatch(
  request: IncomingMessage,
  url: URL,
  ctx: WorkerStateApiContext,
): Promise<WorkerProviderBootstrap> {
  const match = url.pathname.match(
    /^\/state-api\/v1\/runs\/([^/]+)\/provider\/cursor\/(bootstrap|renew)$/,
  );
  if (!match) {
    throw new BrokerApiError(404, "not_found", `Unknown model broker path ${url.pathname}`);
  }
  if (request.method !== "POST") {
    throw new BrokerApiError(405, "bad_request", "Model broker operations require POST");
  }
  const protocol = headerValue(request, RUN_STATE_API_PROTOCOL_HEADER);
  if (protocol !== String(RUN_STATE_API_PROTOCOL_VERSION)) {
    throw new BrokerApiError(426, "protocol_mismatch", "Unsupported worker broker protocol", {
      expected: RUN_STATE_API_PROTOCOL_VERSION,
      presented: protocol ?? null,
    });
  }

  const runId = decodeURIComponent(match[1]!);
  const verification = await ctx.credentials.verify(
    runId,
    headerValue(request, RUN_STATE_API_AUTH_HEADER),
  );
  if (!verification.ok) {
    const status = verification.reason === "wrong_run" ? 403 : 401;
    throw new BrokerApiError(
      status,
      status === 403 ? "forbidden" : "unauthorized",
      "Invalid worker model-broker credential",
    );
  }
  const workerInstanceId = verification.credential.workerInstanceId;
  if (!workerInstanceId) {
    throw new BrokerApiError(403, "forbidden", "Worker credential lacks sandbox identity");
  }

  const body = await readBody(request);
  if (match[2] === "bootstrap") {
    if (!ctx.issueCursorProviderBootstrap) {
      throw new BrokerApiError(503, "internal", "Host Cursor provider proxy is unavailable");
    }
    return ctx.issueCursorProviderBootstrap(runId, workerInstanceId);
  }
  if (!ctx.renewCursorProviderBootstrap) {
    throw new BrokerApiError(503, "internal", "Host Cursor provider renewal is unavailable");
  }
  return ctx.renewCursorProviderBootstrap(
    runId,
    workerInstanceId,
    requiredString(body.token, "token", 200),
  );
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > RUN_STATE_API_MAX_BODY_BYTES) {
      throw new BrokerApiError(413, "body_too_large", "Request body exceeds limit");
    }
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new BrokerApiError(400, "bad_request", "Request body must be a JSON object");
  }
}

function requiredString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || !value || value.length > maxLength) {
    throw new BrokerApiError(400, "bad_request", `${field} must be a non-empty string`);
  }
  return value;
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const raw = request.headers[name.toLowerCase()];
  return Array.isArray(raw) ? raw[0] : raw;
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: RunStateApiResponse,
): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(`${JSON.stringify(body)}\n`);
}
