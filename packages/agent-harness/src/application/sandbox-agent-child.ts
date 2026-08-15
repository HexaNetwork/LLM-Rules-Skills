import { createCursorBackend, type CursorBrokerConnection } from "../infrastructure/agents/cursor-backend.js";
import type { AgentRequest } from "../infrastructure/agents/types.js";
import { HARNESS_RPC_URL_ENV, HARNESS_WORKER_TOKEN_ENV } from "../sandbox/types.js";
import {
  RUN_STATE_API_AUTH_HEADER,
  RUN_STATE_API_PROTOCOL_HEADER,
  RUN_STATE_API_PROTOCOL_VERSION,
  runStateApiPath,
  type RunStateApiResponse,
} from "../worker/state-protocol.js";
import type { WorkerProviderBootstrap } from "../worker/provider-protocol.js";

export type SandboxAgentRequest = Omit<
  AgentRequest,
  "signal" | "onStep" | "onInstallObserved" | "cwd"
>;

export async function runSandboxAgentChild(
  request: SandboxAgentRequest,
): Promise<unknown> {
  const rpcUrl = requiredEnv(HARNESS_RPC_URL_ENV);
  const workerToken = requiredEnv(HARNESS_WORKER_TOKEN_ENV);
  rejectDurableCredentials();
  const bootstrap = await callBroker<WorkerProviderBootstrap>(
    rpcUrl,
    workerToken,
    request.runId,
    "provider/cursor/bootstrap",
    {},
  );
  if (bootstrap.tls?.caCertificatePath) {
    process.env.NODE_EXTRA_CA_CERTS = bootstrap.tls.caCertificatePath;
  }
  const connection: CursorBrokerConnection = {
    brokerToken: bootstrap.token,
    backendUrl: bootstrap.endpoint,
    compatibility: bootstrap.compatibility,
    expiresAt: bootstrap.expiresAt,
    renew: async (token) => {
      const renewed = await callBroker<WorkerProviderBootstrap>(
        rpcUrl,
        workerToken,
        request.runId,
        "provider/cursor/renew",
        { token },
      );
      return {
        brokerToken: renewed.token,
        expiresAt: renewed.expiresAt,
        backendUrl: renewed.endpoint,
        compatibility: renewed.compatibility,
      };
    },
  };
  return createCursorBackend(connection).run({
    ...request,
    cwd: "/workspace",
    signal: new AbortController().signal,
  });
}

async function callBroker<T>(
  rpcUrl: string,
  token: string,
  runId: string,
  operation: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(
    new URL(runStateApiPath(runId, operation), `${rpcUrl.replace(/\/$/, "")}/`),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [RUN_STATE_API_AUTH_HEADER]: token,
        [RUN_STATE_API_PROTOCOL_HEADER]: String(RUN_STATE_API_PROTOCOL_VERSION),
      },
      body: JSON.stringify(body),
    },
  );
  const envelope = (await response.json()) as RunStateApiResponse<T>;
  if (!response.ok || !envelope.ok) {
    const message = envelope.ok ? `HTTP ${response.status}` : envelope.error.message;
    throw new Error(`Host broker ${operation} failed: ${message}`);
  }
  return envelope.result;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Sandbox agent requires ${name}`);
  return value;
}

function rejectDurableCredentials(): void {
  const forbidden = [
    "CURSOR_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GH_TOKEN",
    "GITHUB_TOKEN",
  ];
  const leaked = forbidden.filter((name) => process.env[name]);
  if (leaked.length > 0) {
    throw new Error(`Sandbox agent received forbidden durable credentials: ${leaked.join(", ")}`);
  }
}
