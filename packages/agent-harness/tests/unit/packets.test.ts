import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/domain/settings.js";
import { createPacketService } from "../../src/plugins/packets.js";

describe("packet budgets", () => {
  it("passes guidance and input through unchanged and caps retrieval only", () => {
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
        budgets: { graphifyTokens: 10 },
      },
    });
    expect(packet.guidance.length).toBe(80_000);
    expect(packet.retrieval.length).toBe(40);
    expect(packet.input).toEqual({ idea: "x".repeat(80_000) });
    expect(packet.budget.truncated).toEqual(["retrieval"]);
    expect(packet.model).toBe(DEFAULT_SETTINGS.models.default);
    expect(packet.agentTimeoutMs).toBe(30 * 60_000);
  });

  it("applies the configured timeout to every role packet", () => {
    const packets = createPacketService();
    for (const role of ["reflector", "docs-writer", "implementer", "task-reviewer"]) {
      const packet = packets.build({
        role,
        runId: `run-${role}`,
        phase: "test",
        input: {},
        settings: {
          ...DEFAULT_SETTINGS,
          workflow: { ...DEFAULT_SETTINGS.workflow, agentTimeoutMinutes: 7 },
        },
      });
      expect(packet.agentTimeoutMs).toBe(7 * 60_000);
    }
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

  it("routes docs-writer to the configured small model", () => {
    const packet = createPacketService().build({
      role: "docs-writer",
      runId: "run-3",
      phase: "prd",
      input: {},
      settings: {
        ...DEFAULT_SETTINGS,
        models: { default: "large-model", small: "small-model" },
      },
    });
    expect(packet.model).toBe("small-model");
  });
});
