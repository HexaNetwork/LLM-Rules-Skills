import { afterEach, describe, expect, it } from "vitest";
import { AgentRuntime } from "../../src/agent-runtime.js";

const original = process.env.CURSOR_API_KEY;
afterEach(() => { if (original === undefined) delete process.env.CURSOR_API_KEY; else process.env.CURSOR_API_KEY = original; });

describe("AgentRuntime", () => {
  it("accepts a canonical durable result even when cleanup exceeded the deadline", async () => {
    process.env.CURSOR_API_KEY = "test";
    const result = { protocolVersion: 1, result: { turnId: "turn", sessionId: "session", output: { ok: true } } };
    const containers = { invokeInRunner: async () => ({ actionId: "a", exitCode: 1, stdout: JSON.stringify(result), stderr: "cleanup failed", timedOut: true }) };
    const runtime = new AgentRuntime(containers as never);
    await expect(runtime.invoke({ turnId: "turn", role: "role", prompt: "p", outputSchema: { type: "object" } }, { runId: "run", workspace: "/workspace", deadlineMs: 1 })).resolves.toEqual(result.result);
  });
});
