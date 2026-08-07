import { describe, expect, it } from "vitest";

import {
  GrillOutputSchema,
  QuestionSchema,
  ReflectOutputSchema,
} from "../../src/domain.js";

describe("human question contracts", () => {
  const question = {
    prompt: "Which tone should the interface use?",
    context: "The choice affects the language and visual emphasis throughout the interface.",
    options: [
      {
        id: "quiet",
        label: "Quiet",
        description: "Restrained presentation supports focused work.",
      },
      {
        id: "energetic",
        label: "Energetic",
        description: "Stronger emphasis makes progress more prominent.",
      },
    ],
    recommendedOptionId: "quiet",
    recommendation: "Use quiet because this is a long-running work surface.",
  };

  it("requires a valid recommendation for grill questions", () => {
    expect(
      GrillOutputSchema.parse({
        status: "needs_input",
        summary: "Need a tone decision",
        question,
      }).status,
    ).toBe("needs_input");
  });

  it("rejects an unknown recommended option", () => {
    expect(() =>
      GrillOutputSchema.parse({
        status: "needs_input",
        summary: "Need a tone decision",
        question: { ...question, recommendedOptionId: "missing" },
      }),
    ).toThrow(/recommended option/i);
  });

  it("stores reflect drafts on open questions", () => {
    const parsed = QuestionSchema.parse({
      id: "q-reflect",
      purpose: "reflect",
      prompt: "Confirm the restatement",
      draftAnswer: "Feature brief body",
      status: "open",
      askedAt: new Date().toISOString(),
    });
    expect(parsed.draftAnswer).toBe("Feature brief body");
    expect(parsed.purpose).toBe("reflect");
  });

  it("accepts a reflector restatement payload", () => {
    const parsed = ReflectOutputSchema.parse({
      summary: "Restated",
      restatement: "Add editable reflect before grill.",
      goal: "Confirm shared understanding",
      users: ["operators"],
      inScope: ["editable brief"],
      outOfScope: ["wayfinding"],
      assumptions: ["HITL continues in the dashboard"],
      unknowns: ["PRD generation later"],
    });
    expect(parsed.restatement).toContain("editable reflect");
  });
});
