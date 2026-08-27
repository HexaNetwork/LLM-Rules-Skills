import { describe, expect, it } from "vitest";
import { summarizeSessionUsage } from "../../src/domain/session-usage.js";
import type { AgentInvocation } from "../../src/domain/types.js";

function session(overrides: Partial<AgentInvocation>): AgentInvocation {
  return {
    sessionId: "session-1",
    role: "implementer",
    packet: {
      role: "implementer",
      runId: "run-1",
      phase: "implement",
      model: "model-a",
      input: {},
      guidance: "",
      retrieval: "",
      budget: { graphifyTokens: 1, truncated: [] },
    },
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    at: "2026-01-01T00:00:01.000Z",
    status: "completed",
    ...overrides,
  };
}

describe("session usage report", () => {
  it("sums provider telemetry by model and agent type without estimating missing cost", () => {
    const report = summarizeSessionUsage([
      session({
        telemetry: {
          provider: "cursor",
          model: "model-a",
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 60,
            cacheWriteTokens: 5,
            totalTokens: 120,
            reasoningTokens: 7,
          },
          cost: { rawCostCents: 2, chargedCents: 1.5 },
        },
      }),
      session({
        sessionId: "session-2",
        role: "reviewer",
        status: "failed",
        telemetry: { provider: "cursor", model: "model-a" },
      }),
    ]);

    expect(report.total).toMatchObject({
      sessions: 2,
      failedSessions: 1,
      usageReportedSessions: 1,
      costReportedSessions: 1,
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, reasoningTokens: 7 },
      cost: { rawCostCents: 2, chargedCents: 1.5 },
    });
    expect(report.byModel).toHaveLength(1);
    expect(report.byAgentType.map((row) => row.key)).toEqual(["implementer", "reviewer"]);
  });
});
