import { describe, expect, it } from "vitest";

import {
  DecisionOutputSchema,
  NavigatorOutputSchema,
  QuestionSchema,
} from "../../src/domain.js";

describe("human question contracts", () => {
  const hitlTicket = {
    id: "tone",
    title: "Choose tone",
    kind: "grilling" as const,
    interaction: "HITL" as const,
    blockedBy: [],
    question: {
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
    },
  };

  it("requires a valid recommendation for HITL tickets", () => {
    const output = {
      summary: "One choice remains",
      destination: "A coherent interface",
      notes: [],
      tickets: [hitlTicket],
      fog: [],
      outOfScope: [],
      readyToPlan: false,
    };

    expect(NavigatorOutputSchema.parse(output).tickets[0]?.question).toEqual(
      hitlTicket.question,
    );
    expect(
      NavigatorOutputSchema.safeParse({
        ...output,
        tickets: [
          {
            ...hitlTicket,
            question: {
              ...hitlTicket.question,
              recommendedOptionId: "missing",
            },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      NavigatorOutputSchema.safeParse({
        ...output,
        tickets: [{ ...hitlTicket, question: "Quiet or energetic?" }],
      }).success,
    ).toBe(false);
  });

  it("requires the same decision-ready shape for facilitator follow-ups", () => {
    expect(
      DecisionOutputSchema.parse({
        status: "needs_input",
        summary: "Need a narrower tone choice",
        question: hitlTicket.question,
      }).question,
    ).toEqual(hitlTicket.question);

    expect(
      DecisionOutputSchema.safeParse({
        status: "needs_input",
        summary: "Need a narrower tone choice",
        question: "Which tone?",
      }).success,
    ).toBe(false);
  });

  it("loads sparse questions persisted by older runs", () => {
    const question = QuestionSchema.parse({
      id: "q-old",
      prompt: "Formal or casual?",
      status: "open",
      askedAt: "2026-08-03T00:00:00.000Z",
    });

    expect(question.context).toBe("");
    expect(question.options).toEqual([]);
  });
});
