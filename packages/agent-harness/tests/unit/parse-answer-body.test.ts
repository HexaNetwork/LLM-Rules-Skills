import { describe, expect, it } from "vitest";

import { parseAnswerBody } from "../../src/ui/server.js";

describe("parseAnswerBody", () => {
  it("accepts clarifications alongside answers and parked ids", () => {
    const parsed = parseAnswerBody({
      answers: [{ questionId: "q-answer", answer: "Yes" }],
      parked: ["q-skip"],
      clarifications: [{ questionId: "q-clarify", text: "What does quiet mean here?" }],
    });

    expect(parsed.answers).toEqual([{ questionId: "q-answer", answer: "Yes", optionId: undefined }]);
    expect(parsed.parked).toEqual(["q-skip"]);
    expect(parsed.clarifications).toEqual([
      { questionId: "q-clarify", text: "What does quiet mean here?" },
    ]);
  });

  it("allows a clarifications-only batch", () => {
    const parsed = parseAnswerBody({
      clarifications: [{ questionId: "q1", text: "Please rephrase." }],
    });

    expect(parsed.answers).toEqual([]);
    expect(parsed.parked).toEqual([]);
    expect(parsed.clarifications).toHaveLength(1);
  });

  it("rejects a clarification that overlaps an answer or parked id", () => {
    expect(() =>
      parseAnswerBody({
        answers: [{ questionId: "q1", answer: "Yes" }],
        clarifications: [{ questionId: "q1", text: "Wait" }],
      }),
    ).toThrow(/cannot be clarified/);

    expect(() =>
      parseAnswerBody({
        parked: ["q2"],
        clarifications: [{ questionId: "q2", text: "Wait" }],
      }),
    ).toThrow(/cannot be clarified/);
  });

  it("still accepts the legacy single-question shape", () => {
    expect(parseAnswerBody({ questionId: "q1", answer: "Confirmed" })).toEqual({
      answers: [{ questionId: "q1", answer: "Confirmed" }],
      parked: [],
      clarifications: [],
    });
  });
});
