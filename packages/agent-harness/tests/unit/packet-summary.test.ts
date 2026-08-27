import { describe, expect, it } from "vitest";
import { summarizePacket, summarizeTelemetry } from "../../src/plugins/agents.js";
import type { WorkPacket } from "../../src/domain/types.js";

function packet(overrides: Partial<WorkPacket> = {}): WorkPacket {
  return {
    role: "implementer",
    runId: "run-1",
    phase: "implement",
    model: "composer-2.5",
    input: { idea: "ship it", fog: [] },
    guidance: "be brief",
    retrieval: "",
    budget: {
      guidanceTokens: 100,
      inputTokens: 200,
      graphifyTokens: 50,
      truncated: ["guidance"],
    },
    maxAgentTokens: 40_000,
    agentTimeoutMs: 600_000,
    ...overrides,
  };
}

describe("summarizePacket", () => {
  it("captures model, input keys, sizes, and truncation without the payload body", () => {
    expect(summarizePacket(packet())).toEqual({
      model: "composer-2.5",
      inputKind: "object",
      inputKeys: ["idea", "fog"],
      inputChars: JSON.stringify({ idea: "ship it", fog: [] }).length,
      guidanceChars: "be brief".length,
      retrievalChars: 0,
      budgetInputTokens: 200,
      budgetGuidanceTokens: 100,
      budgetGraphifyTokens: 50,
      truncated: ["guidance"],
      maxAgentTokens: 40_000,
      agentTimeoutMs: 600_000,
    });
  });
});

describe("summarizeTelemetry", () => {
  it("keeps usage and cost for activity events", () => {
    expect(
      summarizeTelemetry({
        provider: "cursor",
        model: "composer-2.5",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0 },
        cost: { rawCostCents: 2, chargedCents: 1.5 },
      }),
    ).toEqual({
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0 },
      cost: { rawCostCents: 2, chargedCents: 1.5 },
    });
  });

  it("returns undefined when no usage or cost is present", () => {
    expect(summarizeTelemetry({ provider: "fake", model: "fake" })).toBeUndefined();
  });
});
