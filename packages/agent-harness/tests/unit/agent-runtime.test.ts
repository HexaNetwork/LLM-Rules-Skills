import { afterEach, describe, expect, it } from "vitest";
import { AgentRuntime, formatWorkerFailure } from "../../src/agent-runtime.js";

const original = process.env.CURSOR_API_KEY;
afterEach(() => { if (original === undefined) delete process.env.CURSOR_API_KEY; else process.env.CURSOR_API_KEY = original; });

describe("formatWorkerFailure", () => {
  it("extracts ConfigurationError messages and strips Node warnings", () => {
    const raw = "(node:1) ExperimentalWarning: SQLite is an experimental feature ConfigurationError: Local SDK agents require an explicit `model`. at gt.<anonymous> (file:///opt/harness/node_modules/@cursor/sdk/dist/esm/index.js:1:3298475)";
    expect(formatWorkerFailure(raw)).toBe("Local SDK agents require an explicit `model`.");
  });
});

describe("AgentRuntime", () => {
  it("accepts a canonical durable result even when cleanup exceeded the deadline", async () => {
    process.env.CURSOR_API_KEY = "test";
    const result = { protocolVersion: 1, result: { turnId: "turn", sessionId: "session", output: { ok: true } } };
    const containers = { invokeInRunner: async () => ({ actionId: "a", exitCode: 1, stdout: JSON.stringify(result), stderr: "cleanup failed", timedOut: true }) };
    const runtime = new AgentRuntime(containers as never);
    await expect(runtime.invoke({ turnId: "turn", role: "role", prompt: "p", outputSchema: { type: "object" } }, { runId: "run", workspace: "/workspace", deadlineMs: 1 })).resolves.toEqual(result.result);
  });

  it("surfaces structured worker errors without the invalid protocol JSON wrapper", async () => {
    process.env.CURSOR_API_KEY = "test";
    const containers = { invokeInRunner: async () => ({ actionId: "a", exitCode: 1, stdout: JSON.stringify({ protocolVersion: 1, error: { message: "Local SDK agents require an explicit `model`." } }), stderr: "" }) };
    const runtime = new AgentRuntime(containers as never);
    await expect(runtime.invoke({ turnId: "turn", role: "role", prompt: "p", outputSchema: { type: "object" } }, { runId: "run", workspace: "/workspace", deadlineMs: 1 })).rejects.toThrow("Local SDK agents require an explicit `model`.");
  });
});
