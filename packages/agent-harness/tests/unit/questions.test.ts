import { describe, expect, it } from "vitest";

import {
  CONTRACT_VERSION,
  GrillOutputSchema,
  QuestionSchema,
  ReflectOutputSchema,
  RunStateSchema} from "../../src/domain.js";

describe("human question contracts", () => {
  const question = {
    prompt: "Which tone should the interface use?",
    context: "The choice affects the language and visual emphasis throughout the interface.",
    options: [
      {
        id: "quiet",
        label: "Quiet",
        description: "Restrained presentation supports focused work."},
      {
        id: "energetic",
        label: "Energetic",
        description: "Stronger emphasis makes progress more prominent."}],
    recommendedOptionId: "quiet",
    recommendation: "Use quiet because this is a long-running work surface."};

  it("requires a valid recommendation for grill questions", () => {
    expect(
      GrillOutputSchema.parse({
        status: "needs_input",
        summary: "Need a tone decision",
        questions: [question]}).status,
    ).toBe("needs_input");
  });

  it("accepts a batch of up to six mutually independent questions", () => {
    const parsed = GrillOutputSchema.parse({
      status: "needs_input",
      summary: "Need several decisions",
      questions: [question, { ...question, prompt: "A second, independent question?" }],
      openUnknowns: [{ id: "tone", title: "Tone", whyItMatters: "Sets voice", impact: "shaping" }]});
    if (parsed.status !== "needs_input") throw new Error("expected needs_input");
    expect(parsed.questions).toHaveLength(2);
    expect(parsed.openUnknowns[0]?.id).toBe("tone");
  });

  it("rejects more than six questions in a batch", () => {
    expect(() =>
      GrillOutputSchema.parse({
        status: "needs_input",
        summary: "Too many",
        questions: Array.from({ length: 7 }, () => question)}),
    ).toThrow();
  });

  it("rejects an unknown recommended option", () => {
    expect(() =>
      GrillOutputSchema.parse({
        status: "needs_input",
        summary: "Need a tone decision",
        questions: [{ ...question, recommendedOptionId: "missing" }]}),
    ).toThrow(/recommended option/i);
  });

  it("defaults resolutionSummaries to [] when omitted on either grill status", () => {
    const needsInput = GrillOutputSchema.parse({
      status: "needs_input",
      summary: "Need a tone decision",
      questions: [question]});
    expect(needsInput.resolutionSummaries).toEqual([]);

    const ready = GrillOutputSchema.parse({
      status: "ready_to_plan",
      summary: "Done",
      resolutions: [
        {
          id: "q1",
          question: "Tone?",
          answer: "Quiet",
          summary: "Use quiet tone"}]});
    expect(ready.resolutionSummaries).toEqual([]);
  });

  it("accepts per-question resolutionSummaries", () => {
    const parsed = GrillOutputSchema.parse({
      status: "ready_to_plan",
      summary: "Batch incorporated",
      resolutionSummaries: [
        { questionId: "q1", summary: "Settled tone" },
        { questionId: "q2", summary: "Settled length" }],
      resolutions: []});
    expect(parsed.resolutionSummaries).toEqual([
      { questionId: "q1", summary: "Settled tone" },
      { questionId: "q2", summary: "Settled length" }]);
  });

  it("stores reflect drafts on open questions", () => {
    const parsed = QuestionSchema.parse({
      id: "q-reflect",
      purpose: "reflect",
      prompt: "Confirm the restatement",
      draftAnswer: "Feature brief body",
      status: "open",
      askedAt: new Date().toISOString()});
    expect(parsed.draftAnswer).toBe("Feature brief body");
    expect(parsed.purpose).toBe("reflect");
  });

  it("accepts a reflector restatement payload", () => {
    const parsed = ReflectOutputSchema.parse({
      proposedTitle: "Add editable reflect",
      summary: "Restated",
      restatement: "Add editable reflect before grill.",
      goal: "Confirm shared understanding",
      users: ["operators"],
      inScope: ["editable brief"],
      outOfScope: ["wayfinding"],
      assumptions: ["HITL continues in the dashboard"],
      unknowns: ["PRD generation later"]});
    expect(parsed.proposedTitle).toBe("Add editable reflect");
    expect(parsed.restatement).toContain("editable reflect");
  });

  it("accepts reflector output without proposedTitle for older on-disk runs", () => {
    const parsed = ReflectOutputSchema.parse({
      summary: "Restated",
      restatement: "Legacy brief without a title field.",
      goal: "Stay loadable",
      users: [],
      inScope: [],
      outOfScope: [],
      assumptions: [],
      unknowns: []});
    expect(parsed.proposedTitle).toBeUndefined();
  });

  it("accepts a parked question status", () => {
    const parsed = QuestionSchema.parse({
      id: "q-parked",
      purpose: "grill",
      prompt: "Skipped for now",
      status: "parked",
      askedAt: new Date().toISOString()});
    expect(parsed.status).toBe("parked");
  });
});

describe("run state backward compatibility", () => {
  it("parses a state.json written before openUnknowns/operatorNotes existed", () => {
    const legacy = {
      contractVersion: CONTRACT_VERSION,
      runId: "legacy-run",
      configurationHash: "hash",
      idea: "Ship it",
      phase: "grilling",
      questions: [],
      tasks: [],
      revision: 3,
      lastEventSequence: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // No openUnknowns or operatorNotes fields at all.
    };
    const parsed = RunStateSchema.parse(legacy);
    expect(parsed.openUnknowns).toEqual([]);
    expect(parsed.operatorNotes).toEqual([]);
  });
});
