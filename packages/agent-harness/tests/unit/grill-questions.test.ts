import { describe, expect, it } from "vitest";
import { normalizeQuestions } from "../../src/phases/grill.js";
import { bootTestHost, createTempRepo, currentBranch } from "../helpers.js";

describe("normalizeQuestions", () => {
  it("keeps structured options, recommendation fields, and context", () => {
    const [question] = normalizeQuestions([
      {
        id: "tone",
        prompt: "Which tone?",
        context: "Affects copy and emphasis",
        options: [
          { id: "quiet", label: "Quiet", description: "Restrained" },
          { id: "loud", label: "Loud", description: "Emphatic" },
        ],
        recommendedOptionId: "quiet",
        recommendation: "Prefer quiet for long sessions",
      },
    ]);
    expect(question).toMatchObject({
      id: "tone",
      prompt: "Which tone?",
      kind: "choice",
      context: "Affects copy and emphasis",
      recommendedOptionId: "quiet",
      recommendation: "Prefer quiet for long sessions",
    });
    expect(question?.options).toEqual([
      { id: "quiet", label: "Quiet", description: "Restrained" },
      { id: "loud", label: "Loud", description: "Emphatic" },
    ]);
  });

  it("normalizes legacy choices strings into options", () => {
    const [question] = normalizeQuestions([
      {
        id: "confirm",
        prompt: "Proceed?",
        kind: "choice",
        choices: ["yes", "no"],
        recommended: "yes",
      },
    ]);
    expect(question?.options).toEqual([
      { id: "opt-1", label: "yes", description: "" },
      { id: "opt-2", label: "no", description: "" },
    ]);
    expect(question?.recommendedOptionId).toBe("opt-1");
  });
});

describe("grill clarifications", () => {
  it("parks clarified questions and seeds operator notes without resolving them as answers", async () => {
    const repo = await createTempRepo();
    const { host } = await bootTestHost();
    try {
      const project = await host.ctx.projects.add(repo);
      let run = await host.ctx.runLifecycle.start({
        idea: "Add a status endpoint",
        projectKey: project.projectKey,
        baseBranch: await currentBranch(repo),
      });
      run = await host.ctx.runLifecycle.answer(run.identity.runId, { answers: { restatement: "yes" } });
      expect(run.state.phase).toBe("grill");
      expect(run.state.gate?.id).toBe("grill-batch");
      expect(run.state.gate?.questions[0]?.options?.length).toBeGreaterThan(0);

      run = await host.ctx.runLifecycle.answer(run.identity.runId, {
        answers: { scope: "Unrelated refactors" },
        clarifications: [{ questionId: "users", text: "What does primary mean here?" }],
      });

      const notes = String(run.state.artifacts.operatorNotes ?? "");
      expect(notes).toContain("Clarification requested on grill question");
      expect(notes).toContain("Who are the primary users?");
      expect(notes).toContain("What does primary mean here?");

      const resolutions = (run.state.artifacts.resolutions as Array<{
        answers: Record<string, string>;
        parked: string[];
        clarifications: Array<{ questionId: string; text: string }>;
      }>) ?? [];
      const last = resolutions.at(-1);
      expect(last?.answers).toEqual({ scope: "Unrelated refactors" });
      expect(last?.parked).toContain("users");
      expect(last?.clarifications).toEqual([{ questionId: "users", text: "What does primary mean here?" }]);
      expect(last?.answers.users).toBeUndefined();
    } finally {
      await host.dispose();
    }
  });
});
