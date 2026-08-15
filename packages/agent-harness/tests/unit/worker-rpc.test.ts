import { afterEach, describe, expect, it } from "vitest";
import {
  WorkerRpcClient,
  WorkerRpcClientError,
  createFakeWorkerRpcClient,
} from "../../src/infrastructure/worker-rpc/client.js";
import { hostOwnerForAction } from "../../src/application/host-run-dispatch.js";
import {
  generateWorkerRpcToken,
  tokensEqual,
  redactSecrets,
  workerRpcTokenFingerprint,
} from "../../src/worker/auth.js";
import { startWorkerRpcServer } from "../../src/worker/rpc-server.js";
import {
  HARNESS_PACKAGE_VERSION,
  WORKER_RPC_ACTIONS,
  WORKER_RPC_PROTOCOL_VERSION,
} from "../../src/worker/protocol.js";
import type { WorkerHandlerContext } from "../../src/worker/handlers.js";

const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    await server?.close().catch(() => undefined);
  }
});

function handlerContext(): WorkerHandlerContext {
  return {
    runId: "run-1",
    startedAtMs: Date.now(),
    requestShutdown: () => undefined,
  };
}

describe("worker RPC auth and protocol", () => {
  it("exposes only worker liveness actions", () => {
    expect(WORKER_RPC_ACTIONS).toEqual(["health", "status", "shutdown"]);
  });

  it("rejects missing/invalid tokens", async () => {
    const token = generateWorkerRpcToken();
    const server = await startWorkerRpcServer({
      host: "127.0.0.1",
      port: 0,
      token,
      handlers: handlerContext(),
    });
    servers.push(server);

    const unauthorized = await fetch(`${server.url}/v1/health`, {
      headers: { "x-harness-rpc-protocol": String(WORKER_RPC_PROTOCOL_VERSION) },
    });
    expect(unauthorized.status).toBe(401);

    const bad = await fetch(`${server.url}/v1/health`, {
      headers: {
        "x-harness-worker-token": "wrong-token-wrong-token-wrong-token-xx",
        "x-harness-rpc-protocol": String(WORKER_RPC_PROTOCOL_VERSION),
      },
    });
    expect(bad.status).toBe(401);
  });

  it("enforces protocol and harness version negotiation", async () => {
    const token = generateWorkerRpcToken();
    const server = await startWorkerRpcServer({
      host: "127.0.0.1",
      port: 0,
      token,
      handlers: handlerContext(),
    });
    servers.push(server);

    const protocol = await fetch(`${server.url}/v1/health`, {
      headers: {
        "x-harness-worker-token": token,
        "x-harness-rpc-protocol": "999",
      },
    });
    expect(protocol.status).toBe(426);

    const harness = await fetch(`${server.url}/v1/health`, {
      headers: {
        "x-harness-worker-token": token,
        "x-harness-rpc-protocol": String(WORKER_RPC_PROTOCOL_VERSION),
        "x-harness-version": "0.0.0",
      },
    });
    expect(harness.status).toBe(426);

    const ok = await fetch(`${server.url}/v1/health`, {
      headers: {
        "x-harness-worker-token": token,
        "x-harness-rpc-protocol": String(WORKER_RPC_PROTOCOL_VERSION),
        "x-harness-version": HARNESS_PACKAGE_VERSION,
      },
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { ok: boolean; result: { status: string } };
    expect(body.ok).toBe(true);
    expect(body.result.status).toBe("ok");
  });

  it("rejects oversized bodies", async () => {
    const token = generateWorkerRpcToken();
    const server = await startWorkerRpcServer({
      host: "127.0.0.1",
      port: 0,
      token,
      maxBodyBytes: 64,
      handlers: handlerContext(),
    });
    servers.push(server);

    const response = await fetch(`${server.url}/v1/shutdown`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-harness-worker-token": token,
        "x-harness-rpc-protocol": String(WORKER_RPC_PROTOCOL_VERSION),
        "x-harness-version": HARNESS_PACKAGE_VERSION,
      },
      body: JSON.stringify({ padding: "x".repeat(200) }),
    });
    expect(response.status).toBe(413);
  });

  it("rejects workflow actions that now belong on the host", async () => {
    const token = generateWorkerRpcToken();
    const server = await startWorkerRpcServer({
      host: "127.0.0.1",
      port: 0,
      token,
      handlers: handlerContext(),
    });
    servers.push(server);

    const response = await fetch(`${server.url}/v1/advance`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-harness-worker-token": token,
        "x-harness-rpc-protocol": String(WORKER_RPC_PROTOCOL_VERSION),
        "x-harness-version": HARNESS_PACKAGE_VERSION,
      },
      body: "{}",
    });
    expect(response.status).toBe(404);
  });

  it("delivers shutdown through worker control without a state mutation", async () => {
    let shutdownRequested = false;
    const token = generateWorkerRpcToken();
    const context = handlerContext();
    context.requestShutdown = () => {
      shutdownRequested = true;
    };
    const server = await startWorkerRpcServer({
      host: "127.0.0.1",
      port: 0,
      token,
      handlers: context,
    });
    servers.push(server);

    const client = new WorkerRpcClient({ baseUrl: server.url, token });
    await expect(client.invoke("shutdown", {})).resolves.toEqual({ shuttingDown: true });
    expect(shutdownRequested).toBe(true);
  });
});

describe("token helpers", () => {
  it("compares tokens in constant time and redacts secrets", () => {
    const token = generateWorkerRpcToken();
    expect(tokensEqual(token, token)).toBe(true);
    expect(tokensEqual(token, `${token}x`)).toBe(false);
    expect(redactSecrets(`token=${token}`, [token])).toContain("[REDACTED]");
    expect(workerRpcTokenFingerprint(token)).toHaveLength(16);
  });
});

describe("host proxy routing and session affinity", () => {
  it("routes host UI actions onto host owners, not worker RPC", () => {
    expect(hostOwnerForAction("continue")).toBe("lifecycle");
    expect(hostOwnerForAction("cancel")).toBe("control");
    expect(hostOwnerForAction("cleanup")).toBe("control");
    expect(hostOwnerForAction("confirm_grill")).toBe("engine");
  });

  it("records liveness invokes on the fake worker client", async () => {
    const fake = createFakeWorkerRpcClient({
      results: {
        health: { status: "ok" },
        shutdown: { shuttingDown: true },
      },
    });
    await fake.invoke("health", {});
    await fake.invoke("shutdown", {});
    expect(fake.calls.map((call) => call.action)).toEqual(["health", "shutdown"]);
  });

  it("surfaces WorkerRpcClientError codes from failed responses", async () => {
    const error = new WorkerRpcClientError({
      status: 401,
      code: "unauthorized",
      message: "nope",
      requestId: "r1",
    });
    const fake = createFakeWorkerRpcClient({ errors: { health: error } });
    await expect(fake.invoke("health")).rejects.toMatchObject({
      code: "unauthorized",
      status: 401,
    });
  });
});
