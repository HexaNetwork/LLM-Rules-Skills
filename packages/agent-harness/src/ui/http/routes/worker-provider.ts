import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { CursorProviderProxy } from "../../../infrastructure/provider-proxy/cursor-provider-proxy.js";
import {
  PROVIDER_API_AUTH_HEADER,
  PROVIDER_API_MAX_BODY_BYTES,
  PROVIDER_API_PREFIX,
  PROVIDER_API_PROTOCOL_HEADER,
  PROVIDER_API_REQUEST_ID_HEADER,
} from "../../../worker/provider-protocol.js";

export async function handleWorkerProviderRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  proxy: CursorProviderProxy,
): Promise<boolean> {
  if (!url.pathname.startsWith(`${PROVIDER_API_PREFIX}/`)) return false;
  const match = url.pathname.match(/^\/provider-api\/v1\/runs\/([^/]+)\/cursor(\/.*)$/);
  if (!match) {
    send(response, 404, new Headers({ "content-type": "application/json" }), {
      ok: false,
      error: "route_not_allowed",
    });
    return true;
  }
  const routeProtocolVersion = Number(url.pathname.match(/^\/provider-api\/v(\d+)\//)?.[1]);
  const relativePath = `${match[2]}${url.search}`;
  const streamingMode = proxy.streamingMode(request.method ?? "GET", relativePath);
  const controller = new AbortController();
  const abortFromClient = (): void => {
    if (!controller.signal.aborted) controller.abort(new Error("client_aborted"));
  };
  const abortOnResponseClose = (): void => {
    if (!response.writableEnded) abortFromClient();
  };
  // Every proxied request propagates client disconnects so no upstream hop
  // (buffered, server-streaming, or bidirectional) can outlive its caller.
  request.once("aborted", abortFromClient);
  request.once("error", abortFromClient);
  response.once("close", abortOnResponseClose);
  try {
    // Only the bidirectional upload channel forwards the raw request stream;
    // server-streaming and unary routes read one bounded request message.
    const body = streamingMode === "bidirectional" ? request : await readBody(request);
    const result = await proxy.forward({
      runId: decodeURIComponent(match[1]!),
      // SDK 1.0.27 accepts only an apiKey, not custom broker headers. It sends
      // that opaque value as Bearer auth. Explicit harness clients retain the
      // independently named header; neither form is forwarded upstream.
      token:
        headerValue(request, PROVIDER_API_AUTH_HEADER) ??
        bearerToken(headerValue(request, "authorization")),
      protocolVersion:
        Number(headerValue(request, PROVIDER_API_PROTOCOL_HEADER)) || routeProtocolVersion,
      requestId: headerValue(request, PROVIDER_API_REQUEST_ID_HEADER) ?? randomUUID(),
      method: request.method ?? "GET",
      relativePath,
      headers: requestHeaders(request),
      body,
      signal: controller.signal,
    });
    if (result.body instanceof Uint8Array) {
      send(response, result.status, result.headers, result.body);
    } else {
      await sendStream(response, result.status, result.headers, result.body, controller.signal);
    }
    return true;
  } finally {
    request.off("aborted", abortFromClient);
    request.off("error", abortFromClient);
    response.off("close", abortOnResponseClose);
  }
}

function bearerToken(value: string | undefined): string | undefined {
  const match = value?.match(/^Bearer ([^\s]+)$/i);
  return match?.[1];
}

async function readBody(request: IncomingMessage): Promise<Uint8Array | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > PROVIDER_API_MAX_BODY_BYTES) {
      // Preserve a bounded read; the proxy returns the stable error envelope.
      return new Uint8Array(PROVIDER_API_MAX_BODY_BYTES + 1);
    }
    chunks.push(buffer);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const raw = request.headers[name.toLowerCase()];
  return Array.isArray(raw) ? raw[0] : raw;
}

function requestHeaders(request: IncomingMessage): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) result[name] = first;
  }
  return result;
}

function send(
  response: ServerResponse,
  status: number,
  headers: Headers,
  body: Uint8Array | Record<string, unknown>,
): void {
  response.statusCode = status;
  for (const [name, value] of headers) response.setHeader(name, value);
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(body instanceof Uint8Array ? body : `${JSON.stringify(body)}\n`);
}

async function sendStream(
  response: ServerResponse,
  status: number,
  headers: Headers,
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<void> {
  response.statusCode = status;
  for (const [name, value] of headers) response.setHeader(name, value);
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.flushHeaders();
  await pipeline(Readable.from(body), response, { signal });
}
