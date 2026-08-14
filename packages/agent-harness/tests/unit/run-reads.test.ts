import { describe, expect, it } from "vitest";
import { createRunState, type ReflectOutput } from "../../src/domain.js";
import { summarizeRun } from "../../src/ui/http/run-reads.js";

const reflectOutput = (overrides: Partial<ReflectOutput> = {}): ReflectOutput => ({
  proposedTitle: "Add greeting tone",
  summary: "Restated greeting feature",
  restatement: "Add a greeting feature with a chosen tone.",
  goal: "Ship a greeting users understand",
  users: ["end users"],
  inScope: ["tone choice"],
  outOfScope: [],
  assumptions: [],
  unknowns: [],
  ...overrides});

describe("summarizeRun title", () => {
  const now = "2026-01-01T00:00:00.000Z";

  it("prefers confirmedStructured.proposedTitle over structured and idea", () => {
    const state = createRunState("title-run", "Long raw idea text for the greeting feature", now);
    state.reflectBrief = {
      draft: "draft brief",
      structured: reflectOutput({ proposedTitle: "Draft title" }),
      confirmed: "confirmed brief",
      confirmedStructured: reflectOutput({ proposedTitle: "Confirmed title" }),
      confirmedAt: now};

    const summary = summarizeRun(state);
    expect(summary.title).toBe("Confirmed title");
    expect(summary.idea).toBe("Long raw idea text for the greeting feature");
  });

  it("falls back to structured.proposedTitle before confirm", () => {
    const state = createRunState("draft-title-run", "Raw idea", now);
    state.reflectBrief = {
      draft: "draft brief",
      structured: reflectOutput({ proposedTitle: "Draft title" })};

    expect(summarizeRun(state).title).toBe("Draft title");
  });

  it("omits title when neither structured nor confirmed proposedTitle exists", () => {
    const state = createRunState("legacy-title-run", "Raw idea", now);
    state.reflectBrief = {
      draft: "draft brief",
      structured: reflectOutput({ proposedTitle: undefined })};
    delete state.reflectBrief.structured!.proposedTitle;

    expect(summarizeRun(state).title).toBeUndefined();
  });
});
