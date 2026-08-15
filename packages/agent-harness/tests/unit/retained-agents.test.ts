import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRequest } from "../../src/infrastructure/agents/types.js";

type MockAgent = {
  agentId: string;
  send: ReturnType<typeof vi.fn>;
  [Symbol.asyncDispose]: ReturnType<typeof vi.fn>;
};

const disposeById = new Map<string, ReturnType<typeof vi.fn>>();
let createSeq = 0;
let emitToolCall = false;
let emittedToolArgs: Record<string, unknown> = {};
let latestCreateOptions: Record<string, unknown> | undefined;
let latestResumeOptions: Record<string, unknown> | undefined;
const originalBackendUrl = process.env.CURSOR_BACKEND_URL;

function mockRun(agentId: string, options?: Record<string, unknown>) {
  let cancelled = false;
  return {
    id: `run-${agentId}`,
    cancel: vi.fn(async () => {
      cancelled = true;
    }),
    wait: async () => {
      if (emitToolCall) {
        const onStep = options?.onStep as ((event: unknown) => void) | undefined;
        onStep?.({ step: { type: "toolCall", message: { type: "read", args: emittedToolArgs } } });
      }
      return {
        id: `run-${agentId}`,
        status: cancelled ? "cancelled" : "finished",
        result: "{}",
        usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 }};
    }};
}

vi.mock("@cursor/sdk", () => ({
  Cursor: {
    configure: vi.fn(),
  },
  Agent: {
    create: vi.fn(async (options: Record<string, unknown>) => {
      latestCreateOptions = options;
      createSeq += 1;
      const agentId = `agent-${createSeq}`;
      const dispose = vi.fn(async () => undefined);
      disposeById.set(agentId, dispose);
      const agent: MockAgent = {
        agentId,
        send: vi.fn(async (_prompt: string, options?: Record<string, unknown>) => mockRun(agentId, options)),
        [Symbol.asyncDispose]: dispose};
      return agent;
    }),
    resume: vi.fn(async (agentId: string, options?: Record<string, unknown>) => {
      latestResumeOptions = options;
      const dispose = disposeById.get(agentId) ?? vi.fn(async () => undefined);
      disposeById.set(agentId, dispose);
      return {
        agentId,
        send: vi.fn(async (_prompt: string, options?: Record<string, unknown>) => mockRun(agentId, options)),
        [Symbol.asyncDispose]: dispose};
    })}}));

import { createCursorBackend } from "../../src/infrastructure/agents/cursor-backend.js";

function request(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    role: "griller",
    model: "test-model",
    prompt: "probe",
    cwd: process.cwd(),
    signal: new AbortController().signal,
    retainProviderSession: true,
    ...overrides};
}

describe("retained provider agent eviction", () => {
  beforeEach(() => {
    createSeq = 0;
    emitToolCall = false;
    emittedToolArgs = {};
    latestCreateOptions = undefined;
    latestResumeOptions = undefined;
    disposeById.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalBackendUrl === undefined) delete process.env.CURSOR_BACKEND_URL;
    else process.env.CURSOR_BACKEND_URL = originalBackendUrl;
  });

  it("with retainTtlMs: 0, a second run() disposes the first retained agent", async () => {
    const backend = createCursorBackend("test-key", { retainTtlMs: 0 });

    const first = await backend.run(request());
    expect(first.providerSessionId).toBe("agent-1");
    const firstDispose = disposeById.get("agent-1");
    expect(firstDispose).toBeDefined();
    expect(firstDispose).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 1));
    await backend.run(request({ prompt: "second" }));

    expect(firstDispose).toHaveBeenCalled();
  });

  it("with maxRetained: 1, retaining a second agent disposes the first", async () => {
    const backend = createCursorBackend("test-key", { maxRetained: 1 });

    const first = await backend.run(request({ prompt: "one" }));
    expect(first.providerSessionId).toBe("agent-1");
    const firstDispose = disposeById.get("agent-1");
    expect(firstDispose).toBeDefined();
    expect(firstDispose).not.toHaveBeenCalled();

    const second = await backend.run(request({ prompt: "two" }));
    expect(second.providerSessionId).toBe("agent-2");
    expect(firstDispose).toHaveBeenCalled();
    expect(disposeById.get("agent-2")).not.toHaveBeenCalled();
  });

  it("cancels and rejects a prohibited tool call", async () => {
    emitToolCall = true;
    const backend = createCursorBackend("test-key");

    await expect(
      backend.run(request({ role: "config-fixer", allowTools: false, retainProviderSession: false })),
    ).rejects.toThrow("config-fixer attempted prohibited tool call: read");
  });

  it("enables Cursor's cross-platform local sandbox by default", async () => {
    const backend = createCursorBackend("test-key");

    await backend.run(request({ retainProviderSession: false }));

    expect(latestCreateOptions).toMatchObject({
      local: { cwd: process.cwd(), sandboxOptions: { enabled: true } },
    });
  });

  it("does not cancel slash-prefixed brief text or path-shaped args via host heuristics", async () => {
    emitToolCall = true;
    emittedToolArgs = { contents: "Use /t claim", path: "C:\\Users\\person\\.cursor\\projects\\repo\\agent-transcripts\\run.json" };
    const backend = createCursorBackend("test-key");

    await expect(
      backend.run(request({ allowTools: true, retainProviderSession: false })),
    ).resolves.toMatchObject({ output: "{}" });
  });

  it("can disable the provider sandbox explicitly for an incompatible host", async () => {
    const backend = createCursorBackend("test-key");

    await backend.run(request({ sandboxEnabled: false, retainProviderSession: false }));

    expect(latestCreateOptions).toMatchObject({
      local: { sandboxOptions: { enabled: false } },
    });
  });

  it("supplies only the broker token and uses the SDK backend environment seam", async () => {
    const connection = {
      brokerToken: "run-scoped-broker-token",
      backendUrl: "https://host.docker.internal:9443/provider-api/v1/runs/run-a/cursor",
      compatibility: {
        sdkVersion: "1.0.27",
        contractVersion: "contract-v1",
        proxyVersion: "1",
        tlsIdentity: "sha256:test",
      },
    };
    const backend = createCursorBackend(connection);
    const created = await backend.run(request());
    expect(latestCreateOptions).toMatchObject({
      apiKey: connection.brokerToken,
    });
    expect(latestCreateOptions).not.toHaveProperty("backendUrl");
    expect(process.env.CURSOR_BACKEND_URL).toBe(connection.backendUrl);

    await backend.release?.(created.providerSessionId!);
    await backend.run(
      request({ providerSessionId: created.providerSessionId, retainProviderSession: false }),
    );
    expect(latestResumeOptions).toMatchObject({
      apiKey: connection.brokerToken,
    });
    expect(latestResumeOptions).not.toHaveProperty("backendUrl");
    expect(JSON.stringify(latestResumeOptions)).not.toContain("CURSOR_API_KEY");
  });

  it("renews an expiring broker token before creating the next SDK agent", async () => {
    const renew = vi.fn(async () => ({
      brokerToken: "replacement-broker-token",
      backendUrl: "https://host.docker.internal:9443/provider-api/v1/runs/run-a/cursor",
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      compatibility: {
        sdkVersion: "1.0.27",
        contractVersion: "contract-v1",
        proxyVersion: "1",
        tlsIdentity: "sha256:test",
      },
    }));
    const backend = createCursorBackend({
      brokerToken: "expiring-broker-token",
      backendUrl: "https://host.docker.internal:9443/provider-api/v1/runs/run-a/cursor",
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      compatibility: {
        sdkVersion: "1.0.27",
        contractVersion: "contract-v1",
        proxyVersion: "1",
        tlsIdentity: "sha256:test",
      },
      renew,
    });
    await backend.run(request({ retainProviderSession: false }));
    expect(renew).toHaveBeenCalledWith("expiring-broker-token");
    expect(latestCreateOptions).toMatchObject({
      apiKey: "replacement-broker-token",
    });
  });
});
