import http, { type IncomingHttpHeaders } from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { WorkerProviderCredentialIssuer } from "../../application/worker-provider-credentials.js";
import {
  PROVIDER_API_MAX_BODY_BYTES,
  PROVIDER_API_PROTOCOL_VERSION,
} from "../../worker/provider-protocol.js";
import {
  classifyCursorProviderOperation,
  type CursorProviderContract,
  type CursorProviderUpstream,
} from "./cursor-provider-contract.js";

const REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "content-type",
  "connect-accept-encoding",
  "connect-content-encoding",
  "connect-protocol-version",
  "connect-timeout-ms",
  "user-agent",
  "x-cursor-client-type",
  "x-cursor-client-version",
  // SDK 1.0.27's HTTP/1.1 bridge marks every request so Cursor's edge does
  // not buffer the RunSSE download; stripping it can reintroduce the stall.
  "x-cursor-streaming",
  "x-ghost-mode",
  "x-request-id",
]);
const RESPONSE_HEADERS = new Set([
  "content-type",
  "content-encoding",
  "connect-content-encoding",
  "connect-accept-encoding",
  "cache-control",
  "x-request-id",
]);

export type CursorProviderAuditRecord = {
  requestId: string;
  runId: string;
  workerInstanceId: string;
  method: string;
  relativePath: string;
  operation: string;
  status: number;
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
  streaming?: true;
  contentType?: "application/connect+proto" | "application/connect+json";
  failure?: string;
};

export type CursorProviderStreamingBody = AsyncIterable<Uint8Array>;

export type CursorProviderProxyRequest = {
  runId: string;
  workerInstanceId?: string;
  token?: string;
  protocolVersion?: number;
  requestId: string;
  method: string;
  relativePath: string;
  headers?: Record<string, string>;
  body?: Uint8Array | CursorProviderStreamingBody;
  signal?: AbortSignal;
};

export type CursorProviderProxyResult = {
  status: number;
  headers: Headers;
  body: Uint8Array | ReadableStream<Uint8Array>;
};

type CursorProviderStreamingUpstream = {
  status: number;
  headers: Headers;
  body?: ReadableStream<Uint8Array>;
  cancel(): Promise<void>;
};

type CursorProviderBufferedUpstream = {
  status: number;
  headers: Headers;
  body: Uint8Array;
};

export class CursorProviderProxy {
  private active = 0;
  private closed = false;
  private readonly upstreamSessions = new Map<string, string>();
  private readonly activeStreams = new Set<AbortController>();

  constructor(
    private readonly options: {
      credentials: WorkerProviderCredentialIssuer;
      upstreamOrigins: Readonly<Record<CursorProviderUpstream, string>>;
      upstreamApiKey: string;
      contract: CursorProviderContract;
      fetch?: typeof fetch;
      maxBodyBytes?: number;
      maxStreamRequestBytes?: number;
      maxStreamResponseBytes?: number;
      streamIdleTimeoutMs?: number;
      streamTotalTimeoutMs?: number;
      maxConcurrency?: number;
      audit?: (record: CursorProviderAuditRecord) => void;
      now?: () => number;
    },
  ) {
    for (const upstream of ["cloud-api", "agent-api"] as const) {
      const origin = new URL(options.upstreamOrigins[upstream]);
      if (origin.protocol !== "https:" && origin.hostname !== "127.0.0.1") {
        throw new Error("Cursor provider upstream must use HTTPS");
      }
      if (origin.pathname !== "/" || origin.search || origin.hash) {
        throw new Error("Cursor provider upstream must be a fixed origin");
      }
    }
    if (!options.upstreamApiKey.trim()) throw new Error("Cursor provider upstream key is empty");
  }

  close(): void {
    this.closed = true;
    for (const controller of this.activeStreams) {
      controller.abort(proxyError(503, "broker_unavailable"));
    }
    this.activeStreams.clear();
    this.upstreamSessions.clear();
  }

  isStreamingRoute(method: string, relativePath: string): boolean {
    return this.streamingMode(method, relativePath) !== undefined;
  }

  streamingMode(
    method: string,
    relativePath: string,
  ): "bidirectional" | "server" | undefined {
    try {
      return classifyCursorProviderOperation(this.options.contract, method, relativePath)
        ?.streaming;
    } catch {
      return undefined;
    }
  }

  async forward(input: CursorProviderProxyRequest): Promise<CursorProviderProxyResult> {
    const startedAt = (this.options.now ?? Date.now)();
    let requestBytes = input.body instanceof Uint8Array ? input.body.byteLength : 0;
    let operation = "unclassified";
    let workerInstanceId = input.workerInstanceId ?? "unknown";
    let status = 500;
    let responseBytes = 0;
    let failure: string | undefined;
    let streaming = false;
    let auditDeferred = false;
    const contentType = safeConnectContentType(input.headers);
    const emitAudit = (): void => {
      this.options.audit?.({
        requestId: input.requestId,
        runId: input.runId,
        workerInstanceId,
        method: input.method.toUpperCase(),
        relativePath: new URL(input.relativePath, "https://provider.invalid").pathname,
        operation,
        status,
        requestBytes,
        responseBytes,
        durationMs: Math.max(0, (this.options.now ?? Date.now)() - startedAt),
        ...(streaming ? { streaming: true as const } : {}),
        ...(contentType ? { contentType } : {}),
        ...(failure ? { failure } : {}),
      });
    };
    try {
      if (this.closed) throw proxyError(503, "broker_unavailable");
      if (input.protocolVersion !== PROVIDER_API_PROTOCOL_VERSION) {
        throw proxyError(426, "protocol_mismatch");
      }
      const verification = await this.options.credentials.verify({
        runId: input.runId,
        workerInstanceId: input.workerInstanceId,
        token: input.token,
        protocolVersion: input.protocolVersion,
        provider: "cursor",
      });
      if (!verification.ok) {
        const mapped =
          verification.reason === "wrong_run" ||
          verification.reason === "wrong_worker" ||
          verification.reason === "wrong_provider"
            ? [403, "forbidden"]
            : verification.reason === "expired"
              ? [401, "expired"]
              : verification.reason === "protocol_mismatch"
                ? [426, "protocol_mismatch"]
                : [401, "unauthorized"];
        throw proxyError(mapped[0] as number, mapped[1] as string);
      }
      workerInstanceId = verification.credential.workerInstanceId;
      const classified = classifyCursorProviderOperation(
        this.options.contract,
        input.method,
        input.relativePath,
      );
      if (!classified) throw proxyError(404, "route_not_allowed");
      operation = classified.operation;
      const streamingMode = classified.streaming;
      streaming = streamingMode !== undefined;
      // Only the bidirectional upload channel may deliver an unbounded
      // incremental request body. Server-streaming routes carry one small
      // buffered request message; only their responses stream.
      if (
        streamingMode !== "bidirectional" &&
        !(input.body === undefined || input.body instanceof Uint8Array)
      ) {
        throw proxyError(400, "upstream_failure");
      }
      if (
        streamingMode !== "bidirectional" &&
        requestBytes > (this.options.maxBodyBytes ?? PROVIDER_API_MAX_BODY_BYTES)
      ) {
        throw proxyError(413, "body_too_large");
      }
      // The pinned SDK bridge holds one RunSSE download open for the whole
      // run and issues up to 16 concurrent BidiAppend uploads beside it.
      if (this.active >= (this.options.maxConcurrency ?? 24)) {
        throw proxyError(429, "concurrency_limited");
      }

      const upstreamHeaders = new Headers();
      for (const [name, value] of new Headers(input.headers)) {
        if (REQUEST_HEADERS.has(name.toLowerCase())) upstreamHeaders.set(name, value);
      }
      // Caller authorization and broker headers are never forwarded.
      const upstreamCredential =
        operation === "agent-service"
          ? this.upstreamSessions.get(input.runId)
          : this.options.upstreamApiKey.trim();
      if (!upstreamCredential) throw proxyError(401, "upstream_session_missing");
      upstreamHeaders.set("authorization", `Bearer ${upstreamCredential}`);
      upstreamHeaders.set("x-request-id", input.requestId);
      const upstreamOrigin = this.options.upstreamOrigins[classified.upstream];
      const target = new URL(input.relativePath, upstreamOrigin);
      if (target.origin !== new URL(upstreamOrigin).origin) {
        throw proxyError(404, "route_not_allowed");
      }

      if (streaming) {
        const controller = new AbortController();
        this.activeStreams.add(controller);
        let abortError: ProviderProxyError | undefined;
        let idleTimer: NodeJS.Timeout | undefined;
        let totalTimer: NodeJS.Timeout | undefined;
        let released = false;
        const release = (): void => {
          if (released) return;
          released = true;
          if (idleTimer) clearTimeout(idleTimer);
          if (totalTimer) clearTimeout(totalTimer);
          input.signal?.removeEventListener("abort", abortFromClient);
          this.activeStreams.delete(controller);
          this.active -= 1;
        };
        const abortStream = (classification: string, abortStatus: number): void => {
          abortError ??= proxyError(abortStatus, classification);
          if (!controller.signal.aborted) controller.abort(abortError);
        };
        const resetIdleTimer = (): void => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(
            () => abortStream("stream_idle_timeout", 504),
            this.options.streamIdleTimeoutMs ?? 120_000,
          );
          idleTimer.unref();
        };
        const abortFromClient = (): void => abortStream("client_aborted", 499);
        if (input.signal?.aborted) abortFromClient();
        else input.signal?.addEventListener("abort", abortFromClient, { once: true });
        resetIdleTimer();
        totalTimer = setTimeout(
          () => abortStream("stream_total_timeout", 504),
          this.options.streamTotalTimeoutMs ?? 15 * 60_000,
        );
        totalTimer.unref();

        // Server-streaming requests are already buffered and counted; only
        // bidirectional uploads meter incremental request bytes here.
        const requestBody =
          input.body === undefined
            ? undefined
            : input.body instanceof Uint8Array
              ? input.body
              : createBoundedRequestStream(input.body, {
                  signal: controller.signal,
                  maxBytes: this.options.maxStreamRequestBytes ?? 64_000_000,
                  onBytes: (bytes) => {
                    requestBytes += bytes;
                    resetIdleTimer();
                  },
                  onLimit: () => abortStream("body_too_large", 413),
                });
        // Keep the opaque Connect frames and their response headers byte-for-byte
        // aligned. Connect's per-envelope compression headers remain intact.
        upstreamHeaders.set("accept-encoding", "identity");

        this.active += 1;
        let upstream: CursorProviderStreamingUpstream;
        try {
          upstream = await openStreamingUpstream({
            target,
            method: classified.method,
            headers: upstreamHeaders,
            body: requestBody,
            signal: controller.signal,
            fetch: this.options.fetch,
          });
        } catch (error) {
          release();
          throw abortError ?? error;
        }
        if (upstream.status >= 300 && upstream.status < 400) {
          await upstream.cancel();
          release();
          throw proxyError(502, "upstream_redirect");
        }
        status = upstream.status;
        const headers = safeResponseHeaders(upstream.headers);
        if (!upstream.body) {
          release();
          return { status, headers, body: new Uint8Array() };
        }

        const finalize = (streamFailure?: string): void => {
          if (released) return;
          failure = streamFailure ?? abortError?.classification;
          release();
          emitAudit();
        };
        const body = createTrackedResponseStream(upstream.body, {
          signal: controller.signal,
          maxBytes: this.options.maxStreamResponseBytes ?? 64_000_000,
          onBytes: (bytes) => {
            responseBytes += bytes;
            resetIdleTimer();
          },
          onLimit: () => abortStream("stream_response_too_large", 502),
          onCancel: () => abortStream("client_aborted", 499),
          failure: () => abortError?.classification,
          finalize,
        });
        auditDeferred = true;
        return { status, headers, body };
      }

      this.active += 1;
      // Registering buffered upstream hops lets close() and client aborts
      // destroy in-flight upstream sockets instead of leaking process handles.
      const bufferedController = new AbortController();
      const abortBuffered = (): void => {
        if (!bufferedController.signal.aborted) {
          bufferedController.abort(input.signal?.reason ?? proxyError(499, "client_aborted"));
        }
      };
      if (input.signal?.aborted) abortBuffered();
      else input.signal?.addEventListener("abort", abortBuffered, { once: true });
      this.activeStreams.add(bufferedController);
      let upstream: CursorProviderBufferedUpstream;
      try {
        upstream = await requestBufferedUpstream({
          target,
          method: classified.method,
          headers: upstreamHeaders,
          body: input.body instanceof Uint8Array ? input.body : undefined,
          signal: bufferedController.signal,
          fetch: this.options.fetch,
        });
      } catch (error) {
        const reason: unknown = bufferedController.signal.aborted
          ? bufferedController.signal.reason
          : undefined;
        throw reason instanceof ProviderProxyError ? reason : error;
      } finally {
        this.active -= 1;
        this.activeStreams.delete(bufferedController);
        input.signal?.removeEventListener("abort", abortBuffered);
      }
      if (upstream.status >= 300 && upstream.status < 400) {
        throw proxyError(502, "upstream_redirect");
      }
      const raw = upstream.body;
      const body =
        operation === "auth-exchange" && upstream.status >= 200 && upstream.status < 300
          ? this.captureUpstreamSession(input, raw)
          : redactBytes(
              raw,
              this.options.upstreamApiKey,
              this.upstreamSessions.get(input.runId),
            );
      responseBytes = body.byteLength;
      status = upstream.status;
      const headers = new Headers();
      for (const [name, value] of upstream.headers) {
        if (RESPONSE_HEADERS.has(name.toLowerCase())) headers.set(name, value);
      }
      return { status, headers, body };
    } catch (error) {
      const mapped = error instanceof ProviderProxyError ? error : proxyError(502, "upstream_failure");
      status = mapped.status;
      failure = mapped.classification;
      const body = new TextEncoder().encode(
        JSON.stringify({ ok: false, error: mapped.classification }),
      );
      responseBytes = body.byteLength;
      return {
        status,
        headers: new Headers({ "content-type": "application/json", "cache-control": "no-store" }),
        body,
      };
    } finally {
      if (!auditDeferred) emitAudit();
    }
  }

  private captureUpstreamSession(
    input: CursorProviderProxyRequest,
    raw: Uint8Array,
  ): Uint8Array {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw proxyError(502, "upstream_failure");
    }
    const accessToken =
      typeof parsed === "object" &&
      parsed !== null &&
      "accessToken" in parsed &&
      typeof parsed.accessToken === "string"
        ? parsed.accessToken
        : undefined;
    if (!accessToken || !input.token) throw proxyError(502, "upstream_failure");
    this.upstreamSessions.set(input.runId, accessToken);
    // SDK receives its already-scoped broker capability, never Cursor's
    // reusable exchanged access token.
    return new TextEncoder().encode(JSON.stringify({ accessToken: input.token }));
  }
}

class ProviderProxyError extends Error {
  constructor(
    readonly status: number,
    readonly classification: string,
  ) {
    super(classification);
  }
}

function proxyError(status: number, classification: string): ProviderProxyError {
  return new ProviderProxyError(status, classification);
}

function redactBytes(
  input: Uint8Array,
  apiKey: string,
  upstreamSession?: string,
): Uint8Array {
  const text = new TextDecoder().decode(input);
  const redacted = text
    .replaceAll(apiKey, "[REDACTED]")
    .replaceAll(upstreamSession ?? "\0", "[REDACTED]")
    .replace(/\b(?:cursor_|key_)[A-Za-z0-9_-]{12,}\b/gi, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9]{12,}\b/g, "[REDACTED]");
  return redacted === text ? input : new TextEncoder().encode(redacted);
}

function safeResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of upstream) {
    if (RESPONSE_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  return headers;
}

async function openStreamingUpstream(input: {
  target: URL;
  method: string;
  headers: Headers;
  body?: Uint8Array | ReadableStream<Uint8Array>;
  signal: AbortSignal;
  fetch?: typeof fetch;
}): Promise<CursorProviderStreamingUpstream> {
  if (input.fetch) {
    const response = await input.fetch(input.target, {
      method: input.method,
      headers: input.headers,
      ...(input.body === undefined
        ? {}
        : input.body instanceof Uint8Array
          ? { body: input.body as RequestInit["body"] }
          : { body: input.body as RequestInit["body"], duplex: "half" as const }),
      redirect: "manual",
      signal: input.signal,
    } as RequestInit & { duplex?: "half" });
    return {
      status: response.status,
      headers: response.headers,
      body: response.body ?? undefined,
      async cancel() {
        await response.body?.cancel().catch(() => undefined);
      },
    };
  }

  return await new Promise<CursorProviderStreamingUpstream>((resolve, reject) => {
    const transport = input.target.protocol === "https:" ? https : http;
    let settled = false;
    const request = transport.request(
      input.target,
      {
        method: input.method,
        headers: Object.fromEntries(input.headers),
        signal: input.signal,
        agent: false,
      },
      (response) => {
        settled = true;
        resolve({
          status: response.statusCode ?? 502,
          headers: incomingHeaders(response.headers),
          body: Readable.toWeb(response) as ReadableStream<Uint8Array>,
          async cancel() {
            response.destroy();
          },
        });
      },
    );
    request.once("error", (error) => {
      if (!settled) reject(error);
    });
    if (!input.body) {
      request.end();
      return;
    }
    if (input.body instanceof Uint8Array) {
      request.end(input.body);
      return;
    }
    void pipeline(
      Readable.from(input.body as AsyncIterable<Uint8Array>),
      request,
      { signal: input.signal },
    ).catch((error: unknown) => {
      request.destroy(error instanceof Error ? error : new Error(String(error)));
      if (!settled) reject(error);
    });
  });
}

async function requestBufferedUpstream(input: {
  target: URL;
  method: string;
  headers: Headers;
  body?: Uint8Array;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}): Promise<CursorProviderBufferedUpstream> {
  if (input.fetch) {
    const response = await input.fetch(input.target, {
      method: input.method,
      headers: input.headers,
      body: input.body,
      redirect: "manual",
      signal: input.signal,
    });
    return {
      status: response.status,
      headers: response.headers,
      body: new Uint8Array(await response.arrayBuffer()),
    };
  }

  return await new Promise<CursorProviderBufferedUpstream>((resolve, reject) => {
    const transport = input.target.protocol === "https:" ? https : http;
    const request = transport.request(
      input.target,
      {
        method: input.method,
        headers: Object.fromEntries(input.headers),
        signal: input.signal,
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 502,
            headers: incomingHeaders(response.headers),
            body: Buffer.concat(chunks),
          }),
        );
        response.once("error", reject);
      },
    );
    request.once("error", reject);
    request.end(input.body);
  });
}

function incomingHeaders(input: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

function safeConnectContentType(
  headers: Record<string, string> | undefined,
): "application/connect+proto" | "application/connect+json" | undefined {
  const value = new Headers(headers).get("content-type")?.trim().toLowerCase();
  return value === "application/connect+proto" || value === "application/connect+json"
    ? value
    : undefined;
}

function createBoundedRequestStream(
  body: Uint8Array | CursorProviderStreamingBody,
  options: {
    signal: AbortSignal;
    maxBytes: number;
    onBytes(bytes: number): void;
    onLimit(): void;
  },
): ReadableStream<Uint8Array> {
  const iterable: CursorProviderStreamingBody =
    body instanceof Uint8Array
      ? (async function* (): AsyncGenerator<Uint8Array> {
          yield body;
        })()
      : body;
  const iterator = iterable[Symbol.asyncIterator]();
  let ended = false;
  let total = 0;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stop = async (): Promise<void> => {
    if (ended) return;
    ended = true;
    await iterator.return?.();
  };
  const abort = (): void => {
    if (ended) return;
    ended = true;
    void iterator.return?.();
    streamController?.error(options.signal.reason);
  };
  options.signal.addEventListener("abort", abort, { once: true });
  return new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      if (options.signal.aborted) abort();
    },
    async pull(controller) {
      if (ended) return;
      try {
        const next = await iterator.next();
        if (ended) return;
        if (next.done) {
          ended = true;
          options.signal.removeEventListener("abort", abort);
          controller.close();
          return;
        }
        const chunk = Buffer.isBuffer(next.value)
          ? next.value
          : new Uint8Array(next.value);
        total += chunk.byteLength;
        options.onBytes(chunk.byteLength);
        if (total > options.maxBytes) {
          options.onLimit();
          await stop();
          controller.error(proxyError(413, "body_too_large"));
          return;
        }
        controller.enqueue(chunk);
      } catch (error) {
        if (!ended) {
          ended = true;
          controller.error(error);
        }
      }
    },
    async cancel() {
      options.signal.removeEventListener("abort", abort);
      await stop();
    },
  });
}

function createTrackedResponseStream(
  source: ReadableStream<Uint8Array>,
  options: {
    signal: AbortSignal;
    maxBytes: number;
    onBytes(bytes: number): void;
    onLimit(): void;
    onCancel(): void;
    failure(): string | undefined;
    finalize(failure?: string): void;
  },
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let total = 0;
  let finished = false;
  const finish = (failure?: string): void => {
    if (finished) return;
    finished = true;
    options.signal.removeEventListener("abort", abort);
    options.finalize(failure);
  };
  const abort = (): void => {
    void reader
      .cancel(options.signal.reason)
      .catch(() => undefined)
      .finally(() => finish(options.failure() ?? "upstream_failure"));
  };
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) abort();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) {
        controller.error(options.signal.reason ?? proxyError(502, "upstream_failure"));
        return;
      }
      try {
        const next = await reader.read();
        if (next.done) {
          const streamFailure = options.failure();
          finish(streamFailure);
          if (streamFailure) controller.error(options.signal.reason);
          else controller.close();
          return;
        }
        total += next.value.byteLength;
        if (total > options.maxBytes) {
          options.onLimit();
          await reader.cancel(options.signal.reason).catch(() => undefined);
          const streamFailure = options.failure() ?? "stream_response_too_large";
          finish(streamFailure);
          controller.error(options.signal.reason);
          return;
        }
        options.onBytes(next.value.byteLength);
        controller.enqueue(next.value);
      } catch (error) {
        const streamFailure = options.failure() ?? "upstream_failure";
        finish(streamFailure);
        controller.error(error);
      }
    },
    async cancel(reason) {
      options.onCancel();
      await reader.cancel(reason).catch(() => undefined);
      finish(options.failure() ?? "client_aborted");
    },
  });
}
