import { describe, expect, it } from "vitest";
import { summarizeUsage } from "../../src/telemetry.js";
import type { TurnRecord } from "../../src/types.js";

function turn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return { id: "turn-1", runId: "run-1", stepId: "implement", actionKey: "action-1", role: "implementer", request: { turnId: "turn-1", role: "implementer", prompt: "p", outputSchema: {} }, status: "completed", attempt: 0, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z", ...overrides };
}

describe("usage telemetry", () => {
  it("reports exact provider usage and coverage by role and step", () => {
    const report = summarizeUsage([
      turn({ usage: { inputTokens: 100, outputTokens: 25, cacheReadTokens: 40, totalTokens: 125, costUsd: 0.04, provider: "cursor", model: "composer-1" } }),
      turn({ id: "turn-2", actionKey: "action-2", role: "reviewer", status: "stalled" }),
    ]);
    expect(report.total).toMatchObject({ sessions: 2, completedSessions: 1, failedSessions: 1, usageReportedSessions: 1, usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125, costUsd: 0.04 } });
    expect(report.byRole.map((row) => row.key).sort()).toEqual(["implementer", "reviewer"]);
    expect(report.byStep).toHaveLength(1);
  });
});
