import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRequest } from "../../src/agent.js";

type MockAgent = {
  agentId: string;
  send: ReturnType<typeof vi.fn>;
  [Symbol.asyncDispose]: ReturnType<typeof vi.fn>;
};

const disposeById = new Map<string, ReturnType<typeof vi.fn>>();
let createSeq = 0;

vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: vi.fn(async () => {
      createSeq += 1;
      const agentId = `agent-${createSeq}`;
      const dispose = vi.fn(async () => undefined);
      disposeById.set(agentId, dispose);
      const agent: MockAgent = {
        agentId,
        send: vi.fn(async () => ({
          id: `run-${agentId}`,
          wait: async () => ({
            id: `run-${agentId}`,
            status: "finished",
            result: "{}",
          }),
        })),
        [Symbol.asyncDispose]: dispose,
      };
      return agent;
    }),
    resume: vi.fn(async (agentId: string) => {
      const dispose = disposeById.get(agentId) ?? vi.fn(async () => undefined);
      disposeById.set(agentId, dispose);
      return {
        agentId,
        send: vi.fn(async () => ({
          id: `run-${agentId}`,
          wait: async () => ({
            id: `run-${agentId}`,
            status: "finished",
            result: "{}",
          }),
        })),
        [Symbol.asyncDispose]: dispose,
      };
    }),
  },
}));

import { createCursorBackend } from "../../src/agent.js";

function request(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    role: "griller",
    model: "test-model",
    prompt: "probe",
    cwd: process.cwd(),
    signal: new AbortController().signal,
    retainProviderSession: true,
    ...overrides,
  };
}

describe("retained provider agent eviction", () => {
  beforeEach(() => {
    createSeq = 0;
    disposeById.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
});
