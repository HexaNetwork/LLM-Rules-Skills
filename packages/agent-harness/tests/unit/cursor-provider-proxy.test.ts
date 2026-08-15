import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerProviderCredentialIssuer } from "../../src/application/worker-provider-credentials.js";
import { CursorProviderProxy } from "../../src/infrastructure/provider-proxy/cursor-provider-proxy.js";
import {
  UNPROVEN_CURSOR_PROVIDER_CONTRACT,
  type CursorProviderContract,
} from "../../src/infrastructure/provider-proxy/cursor-provider-contract.js";
import { PROVIDER_API_PROTOCOL_VERSION } from "../../src/worker/provider-protocol.js";

const HOST_KEY = "cursor_host_key_canary_never_log";
const UPSTREAM_ORIGINS = {
  "cloud-api": "https://api.cursor.com/",
  "agent-api": "https://api2.cursor.sh/",
} as const;
const CONTRACT: CursorProviderContract = {
  version: "fake-v1",
  sdkVersion: "1.0.27",
  productionReady: false,
  operations: [
    {
      method: "POST",
      path: "/agent/run",
      operation: "agent-run",
      upstream: "agent-api",
    },
  ],
};

describe("CursorProviderProxy", () => {
  let directory: string;
  let credentials: WorkerProviderCredentialIssuer;
  let token: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "cursor-provider-proxy-"));
    credentials = new WorkerProviderCredentialIssuer(directory);
    token = (await credentials.issue("run-a", { workerInstanceId: "worker-a" })).token;
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function request(overrides: Record<string, unknown> = {}) {
    return {
      runId: "run-a",
      workerInstanceId: "worker-a",
      token,
      protocolVersion: PROVIDER_API_PROTOCOL_VERSION,
      requestId: "request-a",
      method: "POST",
      relativePath: "/agent/run",
      headers: { authorization: "Bearer caller-controlled", cookie: "secret=caller" },
      body: new TextEncoder().encode("{}"),
      ...overrides,
    };
  }

  it("authenticates the broker token and substitutes exactly one host authorization", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${HOST_KEY}`);
      expect(headers.get("cookie")).toBeNull();
      expect([...headers.keys()].filter((name) => name === "authorization")).toHaveLength(1);
      return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
    });
    const proxy = new CursorProviderProxy({
      credentials,
      upstreamOrigins: UPSTREAM_ORIGINS,
      upstreamApiKey: HOST_KEY,
      contract: CONTRACT,
      fetch: fetcher as typeof fetch,
    });

    const result = await proxy.forward(request());
    expect(result.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("keeps exchanged Cursor access tokens on the host", async () => {
    const sessionToken = "cursor_upstream_session_never_deliver";
    const contract: CursorProviderContract = {
      ...CONTRACT,
      operations: [
        {
          method: "POST",
          path: "/auth/exchange_user_api_key",
          operation: "auth-exchange",
          upstream: "agent-api",
        },
        {
          method: "POST",
          path: "/agent.v1.AgentService/RunSSE",
          operation: "agent-service",
          upstream: "agent-api",
        },
      ],
    };
    const seenAuthorization: string[] = [];
    const proxy = new CursorProviderProxy({
      credentials,
      upstreamOrigins: UPSTREAM_ORIGINS,
      upstreamApiKey: HOST_KEY,
      contract,
      fetch: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        seenAuthorization.push(new Headers(init?.headers).get("authorization") ?? "");
        return new URL(String(url)).pathname.includes("exchange_user_api_key")
          ? new Response(JSON.stringify({ accessToken: sessionToken }))
          : new Response('{"ok":true}');
      }) as typeof fetch,
    });

    const exchange = await proxy.forward(
      request({ relativePath: "/auth/exchange_user_api_key" }),
    );
    const exchangeBody = new TextDecoder().decode(exchange.body);
    expect(exchangeBody).toContain(token);
    expect(exchangeBody).not.toContain(sessionToken);
    await proxy.forward(request({ relativePath: "/agent.v1.AgentService/RunSSE" }));
    expect(seenAuthorization).toEqual([`Bearer ${HOST_KEY}`, `Bearer ${sessionToken}`]);
  });

  it("allows only recorded agent bootstrap and write endpoints with exchanged auth", async () => {
    const sessionToken = "cursor_upstream_session_never_deliver";
    const seen: Array<{ path: string; authorization: string | null }> = [];
    const proxy = new CursorProviderProxy({
      credentials,
      upstreamOrigins: UPSTREAM_ORIGINS,
      upstreamApiKey: HOST_KEY,
      contract: UNPROVEN_CURSOR_PROVIDER_CONTRACT,
      fetch: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const target = new URL(String(url));
        seen.push({
          path: target.pathname,
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return target.pathname === "/auth/exchange_user_api_key"
          ? new Response(JSON.stringify({ accessToken: sessionToken }))
          : new Response('{"ok":true}');
      }) as typeof fetch,
    });

    expect(
      (
        await proxy.forward(
          request({ relativePath: "/auth/exchange_user_api_key" }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await proxy.forward(
          request({ relativePath: "/aiserver.v1.BidiService/BidiAppend" }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await proxy.forward(
          request({ relativePath: "/aiserver.v1.BidiService/Other" }),
        )
      ).status,
    ).toBe(404);
    // GetServerConfig only selects HTTP/2 versus the pinned HTTP/1.1 bridge;
    // denial is non-fatal in SDK 1.0.27 and keeps the bridge deterministic.
    expect(
      (
        await proxy.forward(
          request({ relativePath: "/aiserver.v1.ServerConfigService/GetServerConfig" }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await proxy.forward(
          request({ relativePath: "/aiserver.v1.DashboardService/GetUserPrivacyMode" }),
        )
      ).status,
    ).toBe(404);
    expect(seen).toEqual([
      {
        path: "/auth/exchange_user_api_key",
        authorization: `Bearer ${HOST_KEY}`,
      },
      {
        path: "/aiserver.v1.BidiService/BidiAppend",
        authorization: `Bearer ${sessionToken}`,
      },
    ]);
  });

  it("streams BidiAppend in both directions with bounded demand and metadata-only audit", async () => {
    const sessionToken = "cursor_upstream_session_never_deliver";
    const requestChunk = new TextEncoder().encode("request-payload-canary");
    const responseChunk = new TextEncoder().encode("response-payload-canary");
    let releaseRequest!: () => void;
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    let releaseResponse!: () => void;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    let observedFirstRequestChunk!: (chunk: Uint8Array) => void;
    const firstRequestChunk = new Promise<Uint8Array>((resolve) => {
      observedFirstRequestChunk = resolve;
    });
    let responsePulls = 0;
    const audit = vi.fn();
    const proxy = new CursorProviderProxy({
      credentials,
      upstreamOrigins: UPSTREAM_ORIGINS,
      upstreamApiKey: HOST_KEY,
      contract: UNPROVEN_CURSOR_PROVIDER_CONTRACT,
      audit,
      fetch: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const target = new URL(String(url));
        if (target.pathname === "/auth/exchange_user_api_key") {
          return new Response(JSON.stringify({ accessToken: sessionToken }));
        }
        const reader = (init?.body as ReadableStream<Uint8Array>).getReader();
        const first = await reader.read();
        observedFirstRequestChunk(first.value!);
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              responsePulls += 1;
              if (responsePulls === 1) {
                controller.enqueue(responseChunk);
                return;
              }
              await responseGate;
              controller.close();
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/connect+proto",
              "connect-content-encoding": "gzip",
            },
          },
        );
      }) as typeof fetch,
    });

    await proxy.forward(request({ relativePath: "/auth/exchange_user_api_key" }));
    const requestBody = (async function* (): AsyncGenerator<Uint8Array> {
      yield requestChunk;
      await requestGate;
    })();
    const resultPromise = proxy.forward(
      request({
        relativePath: "/aiserver.v1.BidiService/BidiAppend",
        headers: {
          "content-type": "application/connect+proto",
          "connect-protocol-version": "1",
        },
        body: requestBody,
      }),
    );

    await expect(firstRequestChunk).resolves.toEqual(requestChunk);
    const result = await resultPromise;
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toBe("application/connect+proto");
    expect(result.headers.get("connect-content-encoding")).toBe("gzip");
    // The source and pass-through each admit at most one queued pull; demand
    // must stop at that bounded pair while the downstream has not read.
    expect(responsePulls).toBeLessThanOrEqual(2);
    expect(audit).toHaveBeenCalledTimes(1);

    const reader = (result.body as ReadableStream<Uint8Array>).getReader();
    await expect(reader.read()).resolves.toEqual({ done: false, value: responseChunk });
    expect(responsePulls).toBeLessThanOrEqual(2);
    expect(audit).toHaveBeenCalledTimes(1);

    releaseRequest();
    releaseResponse();
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    expect(audit).toHaveBeenCalledTimes(2);
    expect(audit.mock.calls[1]?.[0]).toMatchObject({
      method: "POST",
      relativePath: "/aiserver.v1.BidiService/BidiAppend",
      operation: "agent-service",
      status: 200,
      requestBytes: requestChunk.byteLength,
      responseBytes: responseChunk.byteLength,
      streaming: true,
      contentType: "application/connect+proto",
    });
    expect(JSON.stringify(audit.mock.calls)).not.toContain("payload-canary");
    expect(JSON.stringify(audit.mock.calls)).not.toContain(HOST_KEY);
    expect(JSON.stringify(audit.mock.calls)).not.toContain(sessionToken);
  });

  it("fails closed when a BidiAppend upload exceeds its streaming byte budget", async () => {
    const sessionToken = "cursor_upstream_session_never_deliver";
    const audit = vi.fn();
    const proxy = new CursorProviderProxy({
      credentials,
      upstreamOrigins: UPSTREAM_ORIGINS,
      upstreamApiKey: HOST_KEY,
      contract: UNPROVEN_CURSOR_PROVIDER_CONTRACT,
      maxStreamRequestBytes: 4,
      audit,
      fetch: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (new URL(String(url)).pathname === "/auth/exchange_user_api_key") {
          return new Response(JSON.stringify({ accessToken: sessionToken }));
        }
        await (init?.body as ReadableStream<Uint8Array>).getReader().read();
        return new Response("unreachable");
      }) as typeof fetch,
    });

    await proxy.forward(request({ relativePath: "/auth/exchange_user_api_key" }));
    const result = await proxy.forward(
      request({
        relativePath: "/aiserver.v1.BidiService/BidiAppend",
        headers: { "content-type": "application/connect+proto" },
        body: (async function* (): AsyncGenerator<Uint8Array> {
          yield new TextEncoder().encode("oversized");
        })(),
      }),
    );

    expect(result.status).toBe(413);
    expect(new TextDecoder().decode(result.body as Uint8Array)).toContain("body_too_large");
    expect(audit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        streaming: true,
        requestBytes: 9,
        responseBytes: expect.any(Number),
        failure: "body_too_large",
      }),
    );
  });

  it.each([
    {
      name: "idle",
      streamIdleTimeoutMs: 5,
      streamTotalTimeoutMs: 1_000,
      failure: "stream_idle_timeout",
    },
    {
      name: "total",
      streamIdleTimeoutMs: 1_000,
      streamTotalTimeoutMs: 5,
      failure: "stream_total_timeout",
    },
  ])("aborts a BidiAppend stream at its $name limit", async (limits) => {
    const sessionToken = "cursor_upstream_session_never_deliver";
    const audit = vi.fn();
    const proxy = new CursorProviderProxy({
      credentials,
      upstreamOrigins: UPSTREAM_ORIGINS,
      upstreamApiKey: HOST_KEY,
      contract: UNPROVEN_CURSOR_PROVIDER_CONTRACT,
      streamIdleTimeoutMs: limits.streamIdleTimeoutMs,
      streamTotalTimeoutMs: limits.streamTotalTimeoutMs,
      audit,
      fetch: vi.fn(async (url: string | URL | Request) =>
        new URL(String(url)).pathname === "/auth/exchange_user_api_key"
          ? new Response(JSON.stringify({ accessToken: sessionToken }))
          : new Response(new ReadableStream<Uint8Array>()),
      ) as typeof fetch,
    });

    await proxy.forward(request({ relativePath: "/auth/exchange_user_api_key" }));
    const result = await proxy.forward(
      request({
        relativePath: "/aiserver.v1.BidiService/BidiAppend",
        headers: { "content-type": "application/connect+proto" },
        body: (async function* (): AsyncGenerator<Uint8Array> {
          await new Promise<never>(() => undefined);
        })(),
      }),
    );

    await expect((result.body as ReadableStream<Uint8Array>).getReader().read()).rejects.toThrow();
    expect(audit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        streaming: true,
        failure: limits.failure,
      }),
    );
  });

  it("streams the RunSSE download before upstream EOF instead of buffering it", async () => {
    const sessionToken = "cursor_upstream_session_never_deliver";
    const eventChunk = new TextEncoder().encode("run-event-chunk");
    let releaseUpstream!: () => void;
    const upstreamGate = new Promise<void>((resolve) => {
      releaseUpstream = resolve;
    });
    let responsePulls = 0;
    const audit = vi.fn();
    const proxy = new CursorProviderProxy({
      credentials,
      upstreamOrigins: UPSTREAM_ORIGINS,
      upstreamApiKey: HOST_KEY,
      contract: UNPROVEN_CURSOR_PROVIDER_CONTRACT,
      audit,
      fetch: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const target = new URL(String(url));
        if (target.pathname === "/auth/exchange_user_api_key") {
          return new Response(JSON.stringify({ accessToken: sessionToken }));
        }
        expect(target.pathname).toBe("/agent.v1.AgentService/RunSSE");
        // Server-streaming requests arrive as one buffered message, and the
        // SDK bridge's no-buffering edge marker must survive the proxy.
        expect(init?.body).toBeInstanceOf(Uint8Array);
        expect(new Headers(init?.headers).get("x-cursor-streaming")).toBe("true");
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              responsePulls += 1;
              if (responsePulls === 1) {
                controller.enqueue(eventChunk);
                return;
              }
              await upstreamGate;
              controller.close();
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/connect+proto" },
          },
        );
      }) as typeof fetch,
    });

    await proxy.forward(request({ relativePath: "/auth/exchange_user_api_key" }));
    const result = await proxy.forward(
      request({
        relativePath: "/agent.v1.AgentService/RunSSE",
        headers: {
          "content-type": "application/connect+proto",
          "connect-protocol-version": "1",
          "x-cursor-streaming": "true",
        },
      }),
    );

    // forward() must resolve with live headers while the upstream download is
    // still open; buffering to EOF is exactly the stall this guards against.
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toBe("application/connect+proto");
    const reader = (result.body as ReadableStream<Uint8Array>).getReader();
    await expect(reader.read()).resolves.toEqual({ done: false, value: eventChunk });
    expect(audit).toHaveBeenCalledTimes(1);

    releaseUpstream();
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    expect(audit).toHaveBeenCalledTimes(2);
    expect(audit.mock.calls[1]?.[0]).toMatchObject({
      method: "POST",
      relativePath: "/agent.v1.AgentService/RunSSE",
      operation: "agent-service",
      status: 200,
      requestBytes: 2,
      responseBytes: eventChunk.byteLength,
      streaming: true,
    });
    expect(JSON.stringify(audit.mock.calls)).not.toContain("run-event-chunk");
    expect(JSON.stringify(audit.mock.calls)).not.toContain(sessionToken);
  });

  it("rejects an incremental request body on the server-streaming RunSSE route", async () => {
    const sessionToken = "cursor_upstream_session_never_deliver";
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ accessToken: sessionToken })),
    );
    const proxy = new CursorProviderProxy({
      credentials,
      upstreamOrigins: UPSTREAM_ORIGINS,
      upstreamApiKey: HOST_KEY,
      contract: UNPROVEN_CURSOR_PROVIDER_CONTRACT,
      fetch: fetcher as typeof fetch,
    });
    await proxy.forward(request({ relativePath: "/auth/exchange_user_api_key" }));

    const result = await proxy.forward(
      request({
        relativePath: "/agent.v1.AgentService/RunSSE",
        body: (async function* (): AsyncGenerator<Uint8Array> {
          yield new TextEncoder().encode("streamed");
        })(),
      }),
    );
    expect(result.status).toBe(400);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("aborts in-flight buffered upstream requests on close instead of leaking them", async () => {
    const fetcher = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason ?? new Error("aborted")),
            { once: true },
          );
        }),
    );
    const proxy = new CursorProviderProxy({
      credentials,
      upstreamOrigins: UPSTREAM_ORIGINS,
      upstreamApiKey: HOST_KEY,
      contract: CONTRACT,
      fetch: fetcher as typeof fetch,
    });

    const pending = proxy.forward(request());
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    proxy.close();
    const result = await pending;
    expect(result.status).toBe(503);
    expect(new TextDecoder().decode(result.body as Uint8Array)).toContain(
      "broker_unavailable",
    );
  });

  it("routes the exact model list request to Cursor's cloud API with host auth", async () => {
    const contract: CursorProviderContract = {
      ...CONTRACT,
      operations: [
        {
          method: "GET",
          path: "/v1/models",
          operation: "model-list",
          upstream: "cloud-api",
        },
      ],
    };
    const modelList = JSON.stringify({
      models: [{ id: "cursor-model", displayName: "Cursor Model" }],
    });
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(new URL(String(url)).origin).toBe("https://api.cursor.com");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${HOST_KEY}`);
      expect(headers.get("cookie")).toBeNull();
      expect([...headers.keys()].filter((name) => name === "authorization")).toHaveLength(1);
      expect(init?.redirect).toBe("manual");
      return new Response(modelList, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "cache-control": "private, max-age=30",
        },
      });
    });
    const proxy = new CursorProviderProxy({
      credentials,
      upstreamOrigins: UPSTREAM_ORIGINS,
      upstreamApiKey: HOST_KEY,
      contract,
      fetch: fetcher as typeof fetch,
    });

    const result = await proxy.forward(
      request({
        method: "GET",
        relativePath: "/v1/models",
        body: undefined,
      }),
    );

    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toBe("application/json");
    expect(result.headers.get("cache-control")).toBe("private, max-age=30");
    expect(new TextDecoder().decode(result.body)).toBe(modelList);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(HOST_KEY);
  });

  it("rejects model-list method, path, and query variants", async () => {
    const contract: CursorProviderContract = {
      ...CONTRACT,
      operations: [
        {
          method: "GET",
          path: "/v1/models",
          operation: "model-list",
          upstream: "cloud-api",
        },
      ],
    };
    const fetcher = vi.fn();
    const proxy = new CursorProviderProxy({
      credentials,
      upstreamOrigins: UPSTREAM_ORIGINS,
      upstreamApiKey: HOST_KEY,
      contract,
      fetch: fetcher as typeof fetch,
    });

    expect(
      (await proxy.forward(request({ method: "POST", relativePath: "/v1/models" }))).status,
    ).toBe(404);
    expect(
      (await proxy.forward(request({ method: "GET", relativePath: "/v1/models/" }))).status,
    ).toBe(404);
    expect(
      (await proxy.forward(request({ method: "GET", relativePath: "/v1/models?limit=1" }))).status,
    ).toBe(404);
    expect(
      (await proxy.forward(request({ method: "GET", relativePath: "/v1/model" }))).status,
    ).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed for missing, cross-run, wrong-protocol, absolute, CONNECT, traversal, and unlisted routes", async () => {
    const fetcher = vi.fn();
    const proxy = new CursorProviderProxy({
      credentials,
      upstreamOrigins: UPSTREAM_ORIGINS,
      upstreamApiKey: HOST_KEY,
      contract: CONTRACT,
      fetch: fetcher as typeof fetch,
      maxBodyBytes: 4,
    });
    expect((await proxy.forward(request({ token: undefined }))).status).toBe(401);
    expect((await proxy.forward(request({ runId: "run-b" }))).status).toBe(403);
    expect((await proxy.forward(request({ protocolVersion: 999 }))).status).toBe(426);
    expect(
      (await proxy.forward(request({ relativePath: "https://evil.example/agent/run" }))).status,
    ).toBe(502);
    expect((await proxy.forward(request({ relativePath: "//evil.example/agent/run" }))).status).toBe(
      502,
    );
    expect((await proxy.forward(request({ method: "CONNECT" }))).status).toBe(404);
    expect((await proxy.forward(request({ relativePath: "/%2e%2e/admin" }))).status).toBe(502);
    expect((await proxy.forward(request({ relativePath: "/other" }))).status).toBe(404);
    expect(
      (await proxy.forward(request({ body: new TextEncoder().encode("oversized") }))).status,
    ).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("limits concurrent use of a stolen run-scoped capability", async () => {
    const fetcher = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason ?? new Error("aborted")),
            { once: true },
          );
        }),
    );
    const proxy = new CursorProviderProxy({
      credentials,
      upstreamOrigins: UPSTREAM_ORIGINS,
      upstreamApiKey: HOST_KEY,
      contract: CONTRACT,
      maxConcurrency: 1,
      fetch: fetcher as typeof fetch,
    });

    const first = proxy.forward(request({ requestId: "request-first" }));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const limited = await proxy.forward(request({ requestId: "request-second" }));
    expect(limited.status).toBe(429);
    expect(new TextDecoder().decode(limited.body as Uint8Array)).toContain(
      "concurrency_limited",
    );
    expect(fetcher).toHaveBeenCalledOnce();

    proxy.close();
    await expect(first).resolves.toMatchObject({ status: 503 });
  });

  it("rejects redirects and redacts exact host key bytes from responses and audit", async () => {
    const audit = vi.fn();
    const redirecting = new CursorProviderProxy({
      credentials,
      upstreamOrigins: UPSTREAM_ORIGINS,
      upstreamApiKey: HOST_KEY,
      contract: CONTRACT,
      fetch: vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } })) as typeof fetch,
      audit,
    });
    expect((await redirecting.forward(request())).status).toBe(502);
    expect(JSON.stringify(audit.mock.calls)).not.toContain(HOST_KEY);

    const echoing = new CursorProviderProxy({
      credentials,
      upstreamOrigins: UPSTREAM_ORIGINS,
      upstreamApiKey: HOST_KEY,
      contract: CONTRACT,
      fetch: vi.fn(async () =>
        new Response(`failure ${HOST_KEY} cursor_another_key_shaped_canary`, { status: 500 }),
      ) as typeof fetch,
    });
    const result = await echoing.forward(request());
    const body = new TextDecoder().decode(result.body);
    expect(body).toContain("[REDACTED]");
    expect(body).not.toContain(HOST_KEY);
    expect(body).not.toContain("cursor_another_key_shaped_canary");
  });
});
