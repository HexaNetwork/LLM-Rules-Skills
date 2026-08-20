import { describe, expect, it } from "vitest";
import { bootTestHost, createTempRepo, currentBranch } from "../helpers.js";

describe("default workflow", () => {
  it("walks idea to publish with a fake agent on a temporary git repo", async () => {
    const repo = await createTempRepo();
    const { host } = await bootTestHost();
    try {
      const project = await host.ctx.projects.add(repo);
      let run = await host.ctx.runLifecycle.start({
        idea: "Add a status endpoint",
        projectKey: project.projectKey,
        baseBranch: await currentBranch(repo),
      });
      expect(run.state.phase).toBe("reflect");

      run = await host.ctx.runLifecycle.answer(run.identity.runId, { answers: { restatement: "yes" } });
      expect(run.state.phase).toBe("grill");

      run = await host.ctx.runLifecycle.answer(run.identity.runId, {
        answers: { users: "operators", scope: "unrelated refactors" },
      });
      expect(run.state.phase).toBe("verification-settings");

      run = await host.ctx.runLifecycle.answer(run.identity.runId, { answers: { confirm: "yes" } });
      expect(run.state.phase).toBe("operator-gate");

      run = await host.ctx.runLifecycle.answer(run.identity.runId, { answers: { approve: "yes" } });
      expect(run.state.status).toBe("completed");
      expect(run.state.phase).toBe("publish");
      expect(run.state.tasks.some((task) => task.status === "committed")).toBe(true);
      expect(run.state.artifacts.publish).toBeTruthy();
    } finally {
      await host.dispose();
    }
  });
});
