import { describe, expect, it } from "vitest";
import { applyReflectEdits, coerceReflectOutput, formatReflectRestatement } from "../../src/domain/reflect.js";

const sample = {
  proposedTitle: "Add editable reflect",
  summary: "Restated",
  restatement: "Add editable reflect before grill.",
  goal: "Confirm shared understanding",
  users: ["operators"],
  inScope: ["editable brief"],
  outOfScope: ["wayfinding"],
  assumptions: ["HITL continues in the dashboard"],
  unknowns: ["PRD generation later"],
};

describe("ReflectOutput", () => {
  it("accepts a structured reflector payload", () => {
    const parsed = coerceReflectOutput(sample);
    expect(parsed.proposedTitle).toBe("Add editable reflect");
    expect(parsed.users).toEqual(["operators"]);
  });

  it("accepts legacy brief alias for restatement", () => {
    const parsed = coerceReflectOutput({
      summary: "Restated",
      brief: "Legacy brief text.",
      goal: "Stay loadable",
      users: [],
      inScope: [],
      outOfScope: [],
      assumptions: [],
      unknowns: [],
    });
    expect(parsed.restatement).toBe("Legacy brief text.");
  });

  it("rejects missing restatement", () => {
    expect(() =>
      coerceReflectOutput({
        summary: "Restated",
        goal: "Confirm shared understanding",
        users: [],
        inScope: [],
        outOfScope: [],
        assumptions: [],
        unknowns: [],
      }),
    ).toThrow(/missing or invalid fields/i);
  });

  it("builds a markdown brief with section headings", () => {
    expect(formatReflectRestatement(sample)).toContain("## Goal");
    expect(formatReflectRestatement(sample)).toContain("- operators");
    expect(formatReflectRestatement(sample)).toContain("Add editable reflect before grill.");
  });

  it("applies operator edits to structured fields", () => {
    const edited = applyReflectEdits(sample, {
      goal: "Ship the edited goal",
      users: "operators\nreviewers",
    });
    expect(edited.goal).toBe("Ship the edited goal");
    expect(edited.users).toEqual(["operators", "reviewers"]);
  });
});
