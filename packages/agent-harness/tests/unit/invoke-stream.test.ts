import { describe, expect, it } from "vitest";
import {
  parseWorkerStdout,
  selectUsageTelemetry,
  shellToolTimedOut,
} from "../../src/worker/invoke.js";

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

describe("shell timeout normalization", () => {
  it("recognizes a nominal success that reached the tool deadline", () => {
    expect(shellToolTimedOut({ timeout: 180_000 }, { executionTime: 180_034 })).toBe(true);
    expect(shellToolTimedOut({ timeout: 180_000 }, { executionTime: 12_000 })).toBe(false);
  });
});

describe("selectUsageTelemetry", () => {
  const reported = {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 50,
    cacheWriteTokens: 0,
    totalTokens: 170,
  };

  it("prefers reconciled billed usage", () => {
    const billed = { ...reported, inputTokens: 180, totalTokens: 250 };
    expect(selectUsageTelemetry(reported, billed)).toEqual({ usage: billed, source: "billed" });
  });

  it("keeps reported usage while billed telemetry is still lagging", () => {
    const billed = { ...reported, inputTokens: 30, totalTokens: 100 };
    expect(selectUsageTelemetry(reported, billed)).toEqual({ usage: reported, source: "reported" });
  });

  it("uses whichever single source is available", () => {
    expect(selectUsageTelemetry(reported, undefined)).toEqual({
      usage: reported,
      source: "reported",
    });
    expect(selectUsageTelemetry(undefined, reported)).toEqual({
      usage: reported,
      source: "billed",
    });
  });
});
