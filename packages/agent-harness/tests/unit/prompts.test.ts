import { describe, expect, it } from "vitest";
import type { WorkPacket } from "../../src/domain.js";
import {
  DECISION_EXPECTED_OUTPUT,
  DecisionKindSchema,
  InteractionSchema,
  NAVIGATOR_EXPECTED_OUTPUT,
  proposedTicketOutputSketch,
} from "../../src/domain.js";
import { renderContinuationPrompt, renderPrompt, renderPromptBuilderPrompt } from "../../src/prompts.js";

const packet: WorkPacket = {
  contractVersion: "2",
  invocationId: "invocation",
  runId: "run",
  role: "implementer",
  objective: "Implement login validation",
  constraints: [],
  input: { affectedPaths: ["src/login.ts"] },
  guidance: [
    {
      source: "General/rules/login.mdc",
      title: "Login validation",
      kind: "rule",
      excerpt: "Reject blank credentials.",
      reason: "path matches src/**/*.ts; lexical relevance",
      score: 81,
    },
  ],
  context: [],
  priorArtifacts: [],
  expectedOutput: "{summary,changedFiles}",
  createdAt: "2026-08-06T00:00:00.000Z",
};

describe("prompt rendering", () => {
  it("renders auditable selected guidance for fresh and resumed workers", () => {
    expect(renderPrompt(packet)).toContain("General/rules/login.mdc");
    expect(renderPrompt(packet)).toContain("Reject blank credentials.");
    expect(renderContinuationPrompt(packet)).toContain("Apply this deterministic, scoped selection");
  });

  it("allows wayfinding roles to deliver JSON via CreatePlan or assistant result", () => {
    const navigatorPacket: WorkPacket = { ...packet, role: "navigator" };
    expect(renderPrompt(navigatorPacket)).toContain("CreatePlan body");
    expect(renderContinuationPrompt(navigatorPacket)).toContain("CreatePlan body");
    expect(renderPrompt(packet)).not.toContain("CreatePlan body");
  });

  it("tells the navigator the allowed ticket kind enum values", () => {
    const navigatorPacket: WorkPacket = {
      ...packet,
      role: "navigator",
      expectedOutput: NAVIGATOR_EXPECTED_OUTPUT,
    };
    const prompt = renderPrompt(navigatorPacket);
    for (const kind of DecisionKindSchema.options) {
      expect(prompt).toContain(`'${kind}'`);
    }
    expect(prompt).toContain("Ticket kind must be exactly one of");
    expect(prompt).not.toMatch(/kind,interaction:'AFK'/);
  });

  it("requires the prompt builder to preserve guidance", () => {
    expect(renderPromptBuilderPrompt(packet)).toContain("selected guidance block");
    expect(renderPromptBuilderPrompt(packet)).toContain("General/rules/login.mdc");
  });
});

describe("wayfinding expectedOutput sketches", () => {
  it("lists every Zod-validated ticket kind and interaction literal", () => {
    const sketch = proposedTicketOutputSketch();
    for (const kind of DecisionKindSchema.options) {
      expect(sketch).toContain(`'${kind}'`);
    }
    for (const interaction of InteractionSchema.options) {
      expect(sketch).toContain(`interaction:'${interaction}'`);
    }
    expect(NAVIGATOR_EXPECTED_OUTPUT).toContain(sketch);
    expect(DECISION_EXPECTED_OUTPUT).toContain(sketch);
    expect(NAVIGATOR_EXPECTED_OUTPUT).not.toMatch(/\bkind,interaction:/);
    expect(DECISION_EXPECTED_OUTPUT).not.toMatch(/\bkind,interaction:/);
  });

  it("marks string-array fields so models do not emit a single prose string", () => {
    expect(NAVIGATOR_EXPECTED_OUTPUT).toContain("notes:[string]");
    expect(NAVIGATOR_EXPECTED_OUTPUT).toContain("fog:[string]");
    expect(NAVIGATOR_EXPECTED_OUTPUT).toContain("outOfScope:[string]");
    expect(NAVIGATOR_EXPECTED_OUTPUT).not.toMatch(/\bnotes,/);
    expect(DECISION_EXPECTED_OUTPUT).toContain("newFog:[string]");
    expect(DECISION_EXPECTED_OUTPUT).toContain("clearFog:[string]");
    expect(DECISION_EXPECTED_OUTPUT).toContain("outOfScope:[string]");
  });

  it("annotates scalar and ticket dependency field types", () => {
    const sketch = proposedTicketOutputSketch();
    expect(sketch).toContain("blockedBy:[string]");
    expect(sketch).not.toMatch(/,blockedBy\}/);
    expect(NAVIGATOR_EXPECTED_OUTPUT).toContain("summary:string");
    expect(NAVIGATOR_EXPECTED_OUTPUT).toContain("destination:string");
    expect(NAVIGATOR_EXPECTED_OUTPUT).toContain("readyToPlan:boolean");
    expect(DECISION_EXPECTED_OUTPUT).toContain("resolution:string");
    expect(DECISION_EXPECTED_OUTPUT).toContain("routeClear:boolean");
  });
});
