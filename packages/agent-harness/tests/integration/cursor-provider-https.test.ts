import http from "node:http";
import https from "node:https";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerProviderCredentialIssuer } from "../../src/application/worker-provider-credentials.js";
import {
  UNPROVEN_CURSOR_PROVIDER_CONTRACT,
  type CursorProviderContract,
} from "../../src/infrastructure/provider-proxy/cursor-provider-contract.js";
import { startCursorProviderHttpsListener } from "../../src/infrastructure/provider-proxy/https-listener.js";
import { CursorProviderProxy } from "../../src/infrastructure/provider-proxy/cursor-provider-proxy.js";
import { ensureCursorProviderTlsMaterial } from "../../src/infrastructure/provider-proxy/tls.js";
import {
  PROVIDER_API_AUTH_HEADER,
  PROVIDER_API_PROTOCOL_HEADER,
  PROVIDER_API_PROTOCOL_VERSION,
  cursorProviderApiPath,
} from "../../src/worker/provider-protocol.js";

const CONTRACT: CursorProviderContract = {
  version: "test-contract",
  sdkVersion: "1.0.27",
  productionReady: true,
  operations: [
    {
      method: "POST",
      path: "/agent/run",
      operation: "agent-run",
      upstream: "agent-api",
    },
  ],
};

describe("Cursor provider HTTPS listener", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("accepts a broker request only when the delivered public CA is trusted", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cursor-provider-https-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const tls = await ensureCursorProviderTlsMaterial(path.join(directory, "tls"));
    const credentials = new WorkerProviderCredentialIssuer(path.join(directory, "credentials"));
    const issued = await credentials.issue("run-a", { workerInstanceId: "worker-a" });
    const upstream = vi.fn(async () => new Response('{"ok":true}')) as typeof fetch;
    const proxy = new CursorProviderProxy({
      credentials,
      upstreamOrigins: {
        "cloud-api": "https://cursor.example/",
        "agent-api": "https://cursor.example/",
      },
      upstreamApiKey: "host-only-test-key",
      contract: CONTRACT,
      fetch: upstream,
    });
    const listener = await startCursorProviderHttpsListener({ proxy, tls });
    cleanups.push(() => listener.close());
    expect(new URL(listener.containerOrigin).hostname).toBe("host.docker.internal");
    expect(listener.tlsIdentity).toBe(tls.tlsIdentity);

    const result = await httpsRequest(
      `${listener.containerOrigin}${cursorProviderApiPath("run-a", "/agent/run")}`,
      tls.caCertificate,
      issued.token,
    );
    expect(result.status).toBe(200);
    expect(result.body).toBe('{"ok":true}');
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("proxies only the exact model-list route with status, type, and body intact", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cursor-provider-models-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const tls = await ensureCursorProviderTlsMaterial(path.join(directory, "tls"));
    const credentials = new WorkerProviderCredentialIssuer(path.join(directory, "credentials"));
    const issued = await credentials.issue("run-a", { workerInstanceId: "worker-a" });
    const modelList = '{"models":[{"id":"cursor-model"}]}';
    const upstream = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.cursor.com/v1/models");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer host-only-test-key",
      );
      return new Response(modelList, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const proxy = new CursorProviderProxy({
      credentials,
      upstreamOrigins: {
        "cloud-api": "https://api.cursor.com/",
        "agent-api": "https://api2.cursor.sh/",
      },
      upstreamApiKey: "host-only-test-key",
      contract: {
        ...CONTRACT,
        operations: [
          {
            method: "GET",
            path: "/v1/models",
            operation: "model-list",
            upstream: "cloud-api",
          },
        ],
      },
      fetch: upstream,
    });
    const listener = await startCursorProviderHttpsListener({ proxy, tls });
    cleanups.push(() => listener.close());

    const allowed = await httpsRequest(
      `${listener.containerOrigin}${cursorProviderApiPath("run-a", "/v1/models")}`,
      tls.caCertificate,
      issued.token,
      "GET",
    );
    expect(allowed).toEqual({
      status: 200,
      body: modelList,
      contentType: "application/json",
    });

    const unsupported = await httpsRequest(
      `${listener.containerOrigin}${cursorProviderApiPath("run-a", "/v1/agents")}`,
      tls.caCertificate,
      issued.token,
      "GET",
    );
    expect(unsupported.status).toBe(404);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("proxies the exact BidiAppend write channel with only the host-held session", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cursor-provider-bidi-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const tls = await ensureCursorProviderTlsMaterial(path.join(directory, "tls"));
    const credentials = new WorkerProviderCredentialIssuer(path.join(directory, "credentials"));
    const issued = await credentials.issue("run-a", { workerInstanceId: "worker-a" });
    const sessionToken = "cursor_upstream_session_never_deliver";
    const seen: Array<{ path: string; authorization: string | null }> = [];
    const upstream = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = new URL(String(url));
      seen.push({
        path: target.pathname,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return target.pathname === "/auth/exchange_user_api_key"
        ? new Response(JSON.stringify({ accessToken: sessionToken }), {
            headers: { "content-type": "application/json" },
          })
        : new Response('{"ok":true}', {
            headers: { "content-type": "application/connect+json" },
          });
    }) as typeof fetch;
    const proxy = new CursorProviderProxy({
      credentials,
      upstreamOrigins: {
        "cloud-api": "https://api.cursor.com/",
        "agent-api": "https://api2.cursor.sh/",
      },
      upstreamApiKey: "host-only-test-key",
      contract: UNPROVEN_CURSOR_PROVIDER_CONTRACT,
      fetch: upstream,
    });
    const listener = await startCursorProviderHttpsListener({ proxy, tls });
    cleanups.push(() => listener.close());

    expect(
      (
        await httpsRequest(
          `${listener.containerOrigin}${cursorProviderApiPath("run-a", "/auth/exchange_user_api_key")}`,
          tls.caCertificate,
          issued.token,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await httpsRequest(
          `${listener.containerOrigin}${cursorProviderApiPath("run-a", "/aiserver.v1.BidiService/BidiAppend")}`,
          tls.caCertificate,
          issued.token,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await httpsRequest(
          `${listener.containerOrigin}${cursorProviderApiPath("run-a", "/aiserver.v1.BidiService/Other")}`,
          tls.caCertificate,
          issued.token,
        )
      ).status,
    ).toBe(404);
    expect(seen).toEqual([
      {
        path: "/auth/exchange_user_api_key",
        authorization: "Bearer host-only-test-key",
      },
      {
        path: "/aiserver.v1.BidiService/BidiAppend",
        authorization: `Bearer ${sessionToken}`,
      },
    ]);
  });

  it("streams RunSSE download chunks before upstream EOF and aborts upstream on client disconnect", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cursor-provider-runsse-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const tls = await ensureCursorProviderTlsMaterial(path.join(directory, "tls"));
    const credentials = new WorkerProviderCredentialIssuer(path.join(directory, "credentials"));
    const issued = await credentials.issue("run-a", { workerInstanceId: "worker-a" });
    const sessionToken = "cursor_upstream_session_never_deliver";
    const eventChunk = Buffer.from("first-run-event-chunk");
    let observedUpstreamAbort!: () => void;
    const upstreamAborted = new Promise<void>((resolve) => {
      observedUpstreamAbort = resolve;
    });
    const seenAuthorization: string[] = [];
    // The fake upstream keeps the RunSSE response open forever after one
    // chunk, exactly like the live AgentService download channel. Before the
    // server-streaming fix the proxy buffered this response to EOF and hung.
    const upstreamServer = http.createServer((request, response) => {
      seenAuthorization.push(request.headers.authorization ?? "");
      if (request.url === "/auth/exchange_user_api_key") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ accessToken: sessionToken }));
        return;
      }
      response.writeHead(200, { "content-type": "application/connect+proto" });
      response.write(eventChunk);
      request.once("aborted", observedUpstreamAbort);
      response.once("close", observedUpstreamAbort);
    });
    await new Promise<void>((resolve, reject) => {
      upstreamServer.once("error", reject);
      upstreamServer.listen(0, "127.0.0.1", resolve);
    });
    const upstreamAddress = upstreamServer.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") {
      throw new Error("Fake Cursor upstream did not bind a TCP port");
    }
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) => {
          upstreamServer.closeAllConnections();
          upstreamServer.close((error) => (error ? reject(error) : resolve()));
        }),
    );
    const audit = vi.fn();
    const proxy = new CursorProviderProxy({
      credentials,
      upstreamOrigins: {
        "cloud-api": `http://127.0.0.1:${upstreamAddress.port}/`,
        "agent-api": `http://127.0.0.1:${upstreamAddress.port}/`,
      },
      upstreamApiKey: "host-only-test-key",
      contract: UNPROVEN_CURSOR_PROVIDER_CONTRACT,
      audit,
    });
    const listener = await startCursorProviderHttpsListener({ proxy, tls });
    cleanups.push(() => listener.close());

    expect(
      (
        await httpsRequest(
          `${listener.containerOrigin}${cursorProviderApiPath("run-a", "/auth/exchange_user_api_key")}`,
          tls.caCertificate,
          issued.token,
        )
      ).status,
    ).toBe(200);

    const stream = await openStreamingHttpsRequest(
      `${listener.containerOrigin}${cursorProviderApiPath("run-a", "/agent.v1.AgentService/RunSSE")}`,
      tls.caCertificate,
      issued.token,
      Buffer.from("{}"),
      { endRequest: true },
    );
    expect(stream.status).toBe(200);
    expect(stream.contentType).toBe("application/connect+proto");
    expect(stream.firstChunk).toEqual(eventChunk);

    stream.abort();
    await expect(upstreamAborted).resolves.toBeUndefined();
    await vi.waitFor(() =>
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          relativePath: "/agent.v1.AgentService/RunSSE",
          operation: "agent-service",
          status: 200,
          streaming: true,
          requestBytes: 2,
          responseBytes: eventChunk.byteLength,
        }),
      ),
    );
    expect(JSON.stringify(audit.mock.calls)).not.toContain(eventChunk.toString("utf8"));
    expect(JSON.stringify(audit.mock.calls)).not.toContain(sessionToken);
    expect(seenAuthorization).toEqual([
      "Bearer host-only-test-key",
      `Bearer ${sessionToken}`,
    ]);
  });

  it("forwards delayed BidiAppend chunks before EOF and aborts upstream on client disconnect", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cursor-provider-bidi-stream-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const tls = await ensureCursorProviderTlsMaterial(path.join(directory, "tls"));
    const credentials = new WorkerProviderCredentialIssuer(path.join(directory, "credentials"));
    const issued = await credentials.issue("run-a", { workerInstanceId: "worker-a" });
    const sessionToken = "cursor_upstream_session_never_deliver";
    const requestChunk = Buffer.from("delayed-request-chunk");
    const responseChunk = Buffer.from("immediate-response-chunk");
    let observedRequestChunk!: (chunk: Buffer) => void;
    const firstUpstreamRequestChunk = new Promise<Buffer>((resolve) => {
      observedRequestChunk = resolve;
    });
    let observedUpstreamAbort!: () => void;
    const upstreamAborted = new Promise<void>((resolve) => {
      observedUpstreamAbort = resolve;
    });
    const seenAuthorization: string[] = [];
    const upstreamServer = http.createServer((request, response) => {
      seenAuthorization.push(request.headers.authorization ?? "");
      if (request.url === "/auth/exchange_user_api_key") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ accessToken: sessionToken }));
        return;
      }
      request.once("data", (chunk) => {
        observedRequestChunk(Buffer.from(chunk));
        response.writeHead(200, {
          "content-type": "application/connect+proto",
          "connect-accept-encoding": "gzip",
        });
        response.write(responseChunk);
      });
      request.once("aborted", observedUpstreamAbort);
    });
    await new Promise<void>((resolve, reject) => {
      upstreamServer.once("error", reject);
      upstreamServer.listen(0, "127.0.0.1", resolve);
    });
    const upstreamAddress = upstreamServer.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") {
      throw new Error("Fake Cursor upstream did not bind a TCP port");
    }
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) => {
          upstreamServer.closeAllConnections();
          upstreamServer.close((error) => (error ? reject(error) : resolve()));
        }),
    );
    const audit = vi.fn();
    const proxy = new CursorProviderProxy({
      credentials,
      upstreamOrigins: {
        "cloud-api": `http://127.0.0.1:${upstreamAddress.port}/`,
        "agent-api": `http://127.0.0.1:${upstreamAddress.port}/`,
      },
      upstreamApiKey: "host-only-test-key",
      contract: UNPROVEN_CURSOR_PROVIDER_CONTRACT,
      audit,
    });
    const listener = await startCursorProviderHttpsListener({ proxy, tls });
    cleanups.push(() => listener.close());

    expect(
      (
        await httpsRequest(
          `${listener.containerOrigin}${cursorProviderApiPath("run-a", "/auth/exchange_user_api_key")}`,
          tls.caCertificate,
          issued.token,
        )
      ).status,
    ).toBe(200);

    const stream = await openStreamingHttpsRequest(
      `${listener.containerOrigin}${cursorProviderApiPath("run-a", "/aiserver.v1.BidiService/BidiAppend")}`,
      tls.caCertificate,
      issued.token,
      requestChunk,
    );
    await expect(firstUpstreamRequestChunk).resolves.toEqual(requestChunk);
    expect(stream.status).toBe(200);
    expect(stream.contentType).toBe("application/connect+proto");
    expect(stream.firstChunk).toEqual(responseChunk);

    stream.abort();
    await expect(upstreamAborted).resolves.toBeUndefined();
    await vi.waitFor(() =>
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          relativePath: "/aiserver.v1.BidiService/BidiAppend",
          failure: "client_aborted",
          streaming: true,
        }),
      ),
    );
    expect(JSON.stringify(audit.mock.calls)).not.toContain(requestChunk.toString("utf8"));
    expect(JSON.stringify(audit.mock.calls)).not.toContain(responseChunk.toString("utf8"));
    expect(JSON.stringify(audit.mock.calls)).not.toContain(sessionToken);
    expect(seenAuthorization).toEqual([
      "Bearer host-only-test-key",
      `Bearer ${sessionToken}`,
    ]);
  });
});

function httpsRequest(
  url: string,
  ca: string,
  token: string,
  method = "POST",
): Promise<{ status: number; body: string; contentType: string | undefined }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = https.request(
      {
        hostname: "127.0.0.1",
        port: target.port,
        path: `${target.pathname}${target.search}`,
        servername: target.hostname,
        method,
        ca,
        headers: {
          [PROVIDER_API_AUTH_HEADER]: token,
          [PROVIDER_API_PROTOCOL_HEADER]: String(PROVIDER_API_PROTOCOL_VERSION),
          "content-type": "application/json",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            contentType: response.headers["content-type"],
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(method === "POST" ? "{}" : undefined);
  });
}

function openStreamingHttpsRequest(
  url: string,
  ca: string,
  token: string,
  firstRequestChunk: Buffer,
  options: { endRequest?: boolean } = {},
): Promise<{
  status: number;
  contentType: string | undefined;
  firstChunk: Buffer;
  abort(): void;
}> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = https.request(
      {
        hostname: "127.0.0.1",
        port: target.port,
        path: `${target.pathname}${target.search}`,
        servername: target.hostname,
        method: "POST",
        ca,
        headers: {
          [PROVIDER_API_AUTH_HEADER]: token,
          [PROVIDER_API_PROTOCOL_HEADER]: String(PROVIDER_API_PROTOCOL_VERSION),
          "content-type": "application/connect+proto",
          "connect-protocol-version": "1",
        },
      },
      (response) => {
        response.once("data", (chunk) => {
          resolve({
            status: response.statusCode ?? 0,
            contentType: response.headers["content-type"],
            firstChunk: Buffer.from(chunk),
            abort: () => {
              response.destroy();
              request.destroy();
            },
          });
        });
        response.on("error", (error) => {
          if (!response.destroyed) reject(error);
        });
      },
    );
    request.on("error", (error) => {
      if (!request.destroyed) reject(error);
    });
    request.flushHeaders();
    // Server-streaming callers send one complete request message; the
    // bidirectional upload channel keeps its request body open.
    if (options.endRequest) request.end(firstRequestChunk);
    else request.write(firstRequestChunk);
  });
}
