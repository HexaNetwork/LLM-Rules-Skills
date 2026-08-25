import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/domain/settings.js";
import { createPacketService } from "../../src/plugins/packets.js";

describe("packet budgets", () => {
  it("truncates guidance, input, and retrieval independently", () => {
    const packets = createPacketService();
    const packet = packets.build({
      role: "reflector",
      runId: "run-1",
      phase: "reflect",
      input: { idea: "x".repeat(80_000) },
      guidance: "g".repeat(80_000),
      retrieval: "r".repeat(80_000),
      settings: {
        ...DEFAULT_SETTINGS,
        budgets: { guidanceTokens: 10, inputTokens: 10, graphifyTokens: 10 },
      },
    });
    expect(packet.guidance.length).toBe(40);
    expect(packet.retrieval.length).toBe(40);
    expect(typeof packet.input === "string" ? packet.input.length : 0).toBe(40);
    expect(packet.budget.truncated).toEqual(["guidance", "retrieval", "input"]);
    expect(packet.model).toBe(DEFAULT_SETTINGS.models.default);
  });

  it("routes non-authoritative message writing to the configured small model", () => {
    const packet = createPacketService().build({
      role: "message-writer",
      runId: "run-2",
      phase: "publish",
      input: {},
      settings: {
        ...DEFAULT_SETTINGS,
        models: { default: "large-model", small: "small-model" },
      },
    });
    expect(packet.model).toBe("small-model");
  });
});
