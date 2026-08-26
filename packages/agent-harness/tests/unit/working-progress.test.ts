import { describe, expect, it } from "vitest";
import { formatWorkingLine, workingOn } from "../../src/domain/working.js";
import { bootTestHost, createTempRepo, currentBranch } from "../helpers.js";

describe("run working progress", () => {
  it("formats a concise working line", () => {
    const working = workingOn("Invoking reflector", { phase: "reflect", role: "reflector" });
    expect(formatWorkingLine(working)).toContain("Invoking reflector");
    expect(formatWorkingLine(working)).toContain("reflector");
    expect(formatWorkingLine(working)).toContain("reflect phase");
  });

  it("exposes in-flight working while an agent invoke is pending", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { host } = await bootTestHost({
      agents: {
        mode: "fake",
        scripted: {
          reflector: async () => {
            await gate;
            return {
              proposedTitle: "Remove claim plots",
              summary: "Restate claim removal.",
              restatement: "Remove plot and claim systems.",
              goal: "Protect buildable culture chunks only.",
              users: ["operators"],
              inScope: ["claims"],
              outOfScope: ["unrelated refactors"],
              assumptions: ["Buildable Area already exists"],
              unknowns: ["Overlay polygon simplification"],
            };
          },
        },
      },
    });
    try {
      const repo = await createTempRepo();
      const registration = await host.ctx.runLifecycle.addProject(repo);
      const started = host.ctx.runLifecycle.start({
        idea: "Remove plots and claims",
        projectKey: registration.projectKey,
        baseBranch: await currentBranch(repo),
      });
      let working: { summary?: string; role?: string; phase?: string } | undefined;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const runs = await host.ctx.runLifecycle.list();
        const live = runs.find((run) => run.state.working);
        if (live?.state.working) {
          working = live.state.working;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(working?.summary).toMatch(/Invoking reflector|Running reflect|Updating base branch|Entering reflect/);
      if (working?.summary?.includes("Invoking")) {
        expect(working.role).toBe("reflector");
        expect(working.phase).toBe("reflect");
      }
      release();
      const finished = await started;
      expect(finished.state.phase).toBe("reflect");
      expect(finished.state.status).toBe("awaiting_input");
      const after = await host.ctx.runLifecycle.status(finished.identity.runId);
      expect(after.state.working).toBeUndefined();
    } finally {
      release();
      await host.dispose();
    }
  });
});
