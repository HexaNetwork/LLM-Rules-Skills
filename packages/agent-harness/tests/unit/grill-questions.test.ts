import { describe, expect, it } from "vitest";
import {
  normalizeFogDrafts,
  normalizeFogResolutions,
  normalizeQuestions,
} from "../../src/phases/grill.js";
import { bootTestHost, createTempRepo, currentBranch } from "../helpers.js";

describe("normalizeQuestions", () => {
  it("keeps structured options, recommendation fields, and context", () => {
    const [question] = normalizeQuestions([
      {
        id: "tone",
        fogIds: ["fog-tone"],
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
      fogIds: ["fog-tone"],
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

  it("normalizes explicit unknown and resolution records", () => {
    expect(normalizeFogDrafts([{ id: "fog-storage", text: "Where is it stored?" }])).toEqual([
      { id: "fog-storage", text: "Where is it stored?" },
    ]);
    expect(normalizeFogResolutions([{ id: "fog-storage", reason: "Found in config.yml" }])).toEqual([
      { id: "fog-storage", reason: "Found in config.yml" },
    ]);
    expect(() => normalizeFogResolutions([{ id: "fog-storage" }])).toThrow(/id and reason/);
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
      expect(run.state.fog.find((entry) => entry.text === "Who are the users?")?.status).toBe("parked");
      expect(run.state.fog.find((entry) => entry.text === "What is explicitly out of scope?")).toMatchObject({
        status: "resolved",
        resolution: { source: "operator" },
      });
    } finally {
      await host.dispose();
    }
  });
});

describe("grill fog safety", () => {
  it("blocks an empty griller response while unknowns remain", async () => {
    const repo = await createTempRepo();
    const { host } = await bootTestHost({
      agents: {
        mode: "fake",
        scripted: {
          griller: { questions: [], newUnknowns: [], resolvedUnknowns: [] },
        },
      },
    });
    try {
      const project = await host.ctx.projects.add(repo);
      let run = await host.ctx.runLifecycle.start({
        idea: "Add a status endpoint",
        projectKey: project.projectKey,
        baseBranch: await currentBranch(repo),
      });
      run = await host.ctx.runLifecycle.answer(run.identity.runId, { answers: { restatement: "yes" } });

      expect(run.state.phase).toBe("grill");
      expect(run.state.status).toBe("blocked");
      expect(run.state.block?.reason).toMatch(/no questions while 2 unknowns remain open/);
      expect(run.state.fog.filter((entry) => entry.status === "fog")).toHaveLength(2);
    } finally {
      await host.dispose();
    }
  });

  it("advances only after explicit reasoned resolutions close every unknown", async () => {
    const repo = await createTempRepo();
    const { host } = await bootTestHost({
      agents: {
        mode: "fake",
        scripted: {
          griller: (_role, packet) => {
            const input = packet.input as { fog: Array<{ id: string; status: string }> };
            return {
              questions: [],
              newUnknowns: [],
              resolvedUnknowns: input.fog
                .filter((entry) => entry.status === "fog" || entry.status === "asked")
                .map((entry) => ({ id: entry.id, reason: `Verified code evidence for ${entry.id}` })),
            };
          },
        },
      },
    });
    try {
      const project = await host.ctx.projects.add(repo);
      let run = await host.ctx.runLifecycle.start({
        idea: "Document two existing code facts",
        projectKey: project.projectKey,
        baseBranch: await currentBranch(repo),
      });
      run = await host.ctx.runLifecycle.answer(run.identity.runId, { answers: { restatement: "yes" } });

      expect(run.state.phase).toBe("verification-settings");
      expect(run.state.fog).toHaveLength(2);
      expect(run.state.fog.every((entry) => entry.status === "resolved")).toBe(true);
      expect(run.state.fog.every((entry) => entry.resolution?.source === "agent")).toBe(true);
      expect(run.state.artifacts.fogResolutions).toHaveLength(2);
    } finally {
      await host.dispose();
    }
  });
});
