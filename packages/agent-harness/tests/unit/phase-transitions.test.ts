import { describe, expect, it } from "vitest";
import { DEFAULT_WORKFLOW } from "../../src/workflows/default.js";
import { TICKET_WORKFLOW } from "../../src/workflows/ticket.js";
import { bootTestHost, createTempRepo, currentBranch } from "../helpers.js";

describe("phase transitions", () => {
  it("moves reflect to awaiting_input and does not delegate through a monolith", async () => {
    const repo = await createTempRepo();
    const { host } = await bootTestHost();
    try {
      const project = await host.ctx.projects.add(repo);
      const reflect = host.ctx.phases.get("reflect");
      expect(reflect.advance).toBeTypeOf("function");
      expect(reflect.onAnswer).toBeTypeOf("function");
      const run = await host.ctx.runLifecycle.start({
        idea: "Document the health endpoint",
        projectKey: project.projectKey,
        baseBranch: await currentBranch(repo),
      });
      expect(run.state.phase).toBe("reflect");
      expect(run.state.status).toBe("awaiting_input");
      expect(run.state.gate?.id).toBe("reflect-confirm");
      expect(run.state.artifacts.reflect).toBeTruthy();
    } finally {
      await host.dispose();
    }
  });

  it("cannot enter a phase omitted from the bundle", async () => {
    const repo = await createTempRepo();
    const { host } = await bootTestHost({
      bundles: [{ id: "no-grill", phases: ["reflect", "glossary", "publish"] }],
    });
    try {
      const project = await host.ctx.projects.add(repo);
      const started = await host.ctx.runLifecycle.start({
        idea: "Skip the interview",
        projectKey: project.projectKey,
        workflowBundleId: "no-grill",
        baseBranch: await currentBranch(repo),
      });
      const after = await host.ctx.runLifecycle.answer(started.identity.runId, {
        answers: { restatement: "yes" },
      });
      expect(after.state.phase).not.toBe("grill");
      expect(host.ctx.workflow.includes("no-grill", "grill")).toBe(false);
      expect(after.state.status).toBe("completed");
    } finally {
      await host.dispose();
    }
  });

  it("lists default and ticket bundles without changing runLifecycle", () => {
    expect(DEFAULT_WORKFLOW.phases[0]).toBe("reflect");
    expect(TICKET_WORKFLOW.phases).toEqual(["implement", "scenario-test", "publish"]);
  });
});
