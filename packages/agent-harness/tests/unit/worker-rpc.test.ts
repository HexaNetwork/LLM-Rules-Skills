import { createServer } from "node:http";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessConfigSchema } from "../../src/config/schema.js";
import { createFakeDockerClient } from "../../src/infrastructure/container/fake-docker-client.js";
import {
  WorkerRpcClient,
  WorkerRpcClientError,
  createFakeWorkerRpcClient,
} from "../../src/infrastructure/worker-rpc/client.js";
import {
  ensureDockerWorkerSession,
  waitForDockerWorkerHealth,
  workerRpcActionForHostAction,
} from "../../src/application/docker-worker-session.js";
import { mapHostActionToWorkerRpc } from "../../src/application/docker-run-proxy.js";
import { writeRunExecutionState } from "../../src/application/execution-state-io.js";
import {
  generateWorkerRpcToken,
  tokensEqual,
  redactSecrets,
  writeWorkerRpcTokenFile,
  workerRpcTokenFingerprint,
} from "../../src/worker/auth.js";
import { startWorkerRpcServer } from "../../src/worker/rpc-server.js";
import {
  HARNESS_PACKAGE_VERSION,
  WORKER_RPC_PROTOCOL_VERSION,
  WORKER_RPC_SECRET_RELATIVE_PATH,
} from "../../src/worker/protocol.js";
import type { HarnessEngine } from "../../src/application/harness-engine.js";
import type { WorkerHandlerContext } from "../../src/worker/handlers.js";

const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    await server?.close().catch(() => undefined);
  }
});

function stubEngine(overrides: Partial<HarnessEngine> = {}): HarnessEngine {
  return {
    status: async () => ({ runId: "run-1", phase: "awaiting_input", revision: 1 }),
    advance: async () => ({ runId: "run-1", phase: "awaiting_input", revision: 2 }),
    cancel: async () => ({
      pending: true,
      state: { runId: "run-1", phase: "awaiting_input", revision: 1 },
    }),
    ...overrides,
  } as unknown as HarnessEngine;
}

function handlerContext(engine: HarnessEngine): WorkerHandlerContext {
  return {
    runId: "run-1",
    engine,
    startedAtMs: Date.now(),
    isAdvancing: () => false,
    isCancelRequested: async () => false,
    requestShutdown: () => undefined,
  };
}

describe("worker RPC auth and protocol", () => {
  it("polls through the normal worker startup race", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await waitForDockerWorkerHealth(
      {
        health: async () => {
          calls += 1;
          if (calls < 3) throw new Error("fetch failed");
          return { status: "ok" } as never;
        },
      },
      {
        attempts: 4,
        intervalMs: 25,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    expect(result).toEqual({ status: "ok" });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([25, 25]);
  });

  it("rejects missing/invalid tokens", async () => {
    const token = generateWorkerRpcToken();
    const server = await startWorkerRpcServer({
      host: "127.0.0.1",
      port: 0,
      token,
      handlers: handlerContext(stubEngine()),
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
      handlers: handlerContext(stubEngine()),
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
      handlers: handlerContext(stubEngine()),
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
      body: JSON.stringify({ padding: "x".repeat(200) }),
    });
    expect(response.status).toBe(413);
  });

  it("cancels through the RPC cancel path", async () => {
    let cancelled = false;
    const token = generateWorkerRpcToken();
    const server = await startWorkerRpcServer({
      host: "127.0.0.1",
      port: 0,
      token,
      handlers: handlerContext(
        stubEngine({
          cancel: async () => {
            cancelled = true;
            return {
              pending: true,
              state: { runId: "run-1", phase: "awaiting_input", revision: 1 },
            } as never;
          },
        }),
      ),
    });
    servers.push(server);

    const client = new WorkerRpcClient({ baseUrl: server.url, token });
    const result = (await client.cancel()) as { pending: boolean };
    expect(cancelled).toBe(true);
    expect(result.pending).toBe(true);
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
  it("maps host UI actions onto worker RPC actions", () => {
    expect(workerRpcActionForHostAction("continue")).toBe("advance");
    expect(workerRpcActionForHostAction("cancel")).toBe("cancel");
    expect(mapHostActionToWorkerRpc("cleanup")).toBeUndefined();
    expect(mapHostActionToWorkerRpc("confirm_grill")).toBe("confirm_grill");
  });

  it("proxies via fake worker client without Docker", async () => {
    const fake = createFakeWorkerRpcClient({
      results: {
        advance: { runId: "run-1", phase: "grilling", revision: 3 },
        cancel: { pending: true, phase: "grilling" },
      },
    });
    await fake.invoke("advance", {});
    await fake.invoke("cancel", {});
    expect(fake.calls.map((call) => call.action)).toEqual(["advance", "cancel"]);
  });

  it("reattaches using execution.json + secret metadata and fake Docker inspect", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ah-worker-session-"));
    const runId = "run-reattach";
    const projectConfig = HarnessConfigSchema.parse({
      repositoryRoot: root,
      stateDirectory: path.join(root, "state"),
      execution: { runtime: "docker" },
    });
    const workerInstanceId = "worker-reattach-1";
    const bootstrapDir = path.join(root, "state", "worker-bootstrap", runId, workerInstanceId);
    await mkdir(bootstrapDir, { recursive: true });
    const token = generateWorkerRpcToken();
    await writeWorkerRpcTokenFile(path.join(bootstrapDir, "worker-rpc.token"), token);

    const containerName = "ah-project-run-reattach";
    const hostPort = await listenHealthStub(token);

    await writeRunExecutionState(projectConfig, runId, {
      version: 1,
      runtime: "docker",
      lifecycle: "running",
      containerName,
      workerInstanceId,
      hostPort,
      containerPort: 8787,
      rpcSecretRelativePath: WORKER_RPC_SECRET_RELATIVE_PATH,
      rpcTokenFingerprint: workerRpcTokenFingerprint(token),
      updatedAt: new Date().toISOString(),
    });

    const docker = createFakeDockerClient({
      containers: new Map([
        [
          containerName,
          {
            id: "cid-1",
            name: containerName,
            state: "running",
            labels: {},
            image: "img",
            publishedPorts: [{ hostPort, containerPort: 8787, hostIp: "127.0.0.1" }],
          },
        ],
      ]),
    });

    const session = await ensureDockerWorkerSession({
      projectConfig,
      runId,
      docker,
      startIfMissing: false,
    });
    expect(session.execution.containerName).toBe(containerName);
    expect(session.execution.hostPort).toBe(hostPort);
    expect(session.execution.rpcTokenFingerprint).toBe(workerRpcTokenFingerprint(token));
    const health = (await session.client.health()) as { status: string };
    expect(health.status).toBe("ok");
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

async function listenHealthStub(token: string): Promise<number> {
  const server = createServer((request, response) => {
    if (request.headers["x-harness-worker-token"] !== token) {
      response.statusCode = 401;
      response.end(JSON.stringify({ ok: false, requestId: "x", error: { code: "unauthorized", message: "no" } }));
      return;
    }
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        ok: true,
        requestId: "x",
        result: {
          status: "ok",
          runId: "run-reattach",
          protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
          harnessVersion: HARNESS_PACKAGE_VERSION,
          uptimeMs: 1,
        },
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  servers.push({
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}
