import { describe, expect, it } from "vitest";
import { runTitle } from "../../src/domain/run-title.js";
import { bootTestHost, createTempRepo, currentBranch } from "../helpers.js";

describe("reflect confirm applies edits", () => {
  it("shows a sectioned reflect gate and writes edited structured plus flat brief", async () => {
    const repo = await createTempRepo();
    const { host } = await bootTestHost();
    try {
      const project = await host.ctx.projects.add(repo);
      let run = await host.ctx.runLifecycle.start({
        idea: "Add a health check",
        projectKey: project.projectKey,
        baseBranch: await currentBranch(repo),
      });

      expect(run.state.phase).toBe("reflect");
      expect(run.state.gate?.id).toBe("reflect-confirm");
      expect(run.state.gate?.questions.map((question) => question.id)).toEqual([
        "proposedTitle",
        "restatement",
        "goal",
        "users",
        "inScope",
        "outOfScope",
        "assumptions",
        "unknowns",
      ]);
      expect(run.state.gate?.questions.every((question) => question.kind === "text")).toBe(true);
      expect(run.state.gate?.questions.some((question) => question.kind === "confirm")).toBe(false);

      const reflect = run.state.artifacts.reflect as {
        proposedTitle?: string;
        restatement?: string;
        goal?: string;
        users?: string[];
        unknowns?: string[];
      };
      expect(reflect.goal).toBeTruthy();
      expect(Array.isArray(reflect.users)).toBe(true);
      expect(Array.isArray(reflect.unknowns)).toBe(true);
      if (reflect.proposedTitle) {
        expect(reflect.proposedTitle).not.toBe("Add a health check");
        expect("Add a health check".startsWith(reflect.proposedTitle)).toBe(false);
      }

      run = await host.ctx.runLifecycle.answer(run.identity.runId, {
        answers: {
          proposedTitle: "Ship edited goal",
          restatement: "The operator rewrote this restatement by hand.",
          goal: "Ship the edited goal",
          users: "operators\nreviewers",
          inScope: "editable list scope",
          outOfScope: "",
          assumptions: "nothing implicit",
          unknowns: "What remains after the edit?",
        },
      });

      const brief = run.state.artifacts.reflectBrief as {
        confirmed?: string;
        structured?: {
          proposedTitle?: string;
          restatement?: string;
          goal?: string;
          users?: string[];
          inScope?: string[];
          unknowns?: string[];
        };
      };
      expect(brief.confirmed).toContain("operator rewrote this restatement");
      expect(brief.confirmed).toContain("## Goal");
      expect(brief.confirmed).toContain("Ship the edited goal");
      expect(brief.confirmed).toContain("## Users");
      expect(brief.structured?.proposedTitle).toBe("Ship edited goal");
      expect(brief.structured?.goal).toBe("Ship the edited goal");
      expect(brief.structured?.users).toEqual(["operators", "reviewers"]);
      expect(brief.structured?.inScope).toEqual(["editable list scope"]);
      expect(brief.structured?.unknowns).toEqual(["What remains after the edit?"]);
      expect(run.state.fog.some((entry) => entry.text === "What remains after the edit?")).toBe(true);
      expect(runTitle(run)).toBe("Ship edited goal");
    } finally {
      await host.dispose();
    }
  });
});
