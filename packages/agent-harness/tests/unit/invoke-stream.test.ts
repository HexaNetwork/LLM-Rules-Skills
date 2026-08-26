import { describe, expect, it } from "vitest";
import { parseWorkerStdout } from "../../src/worker/invoke.js";

describe("parseWorkerStdout", () => {
  it("reads the trailing result line from a JSONL worker stream", () => {
    const stdout = [
      JSON.stringify({ stream: "control", at: "2026-01-01T00:00:00.000Z", kind: "heartbeat" }),
      JSON.stringify({
        stream: "result",
        protocolVersion: 1,
        output: { summary: "done" },
        submittedPrompt: "prompt",
        telemetry: {
          provider: "cursor",
          model: "composer-2.5",
          agentId: "agent-1",
          providerRunId: "run-1",
        },
      }),
    ].join("\n");
    const parsed = parseWorkerStdout(stdout);
    expect(parsed?.output).toEqual({ summary: "done" });
    expect(parsed?.telemetry.agentId).toBe("agent-1");
  });

  it("falls back to a single legacy JSON object", () => {
    const stdout = JSON.stringify({
      protocolVersion: 1,
      output: { summary: "legacy" },
      submittedPrompt: "prompt",
      telemetry: {
        provider: "cursor",
        model: "composer-2.5",
        agentId: "agent-1",
        providerRunId: "run-1",
      },
    });
    const parsed = parseWorkerStdout(stdout);
    expect(parsed?.output).toEqual({ summary: "legacy" });
  });
});
