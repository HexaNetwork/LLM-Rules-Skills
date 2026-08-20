import { describe, expect, it } from "vitest";
import { bootTestHost, createTempRepo, currentBranch } from "../helpers.js";

describe("ticket workflow", () => {
  it("runs implement → scenario-test → publish without editing runLifecycle", async () => {
    const repo = await createTempRepo();
    const { host } = await bootTestHost();
    try {
      const project = await host.ctx.projects.add(repo);
      const run = await host.ctx.runLifecycle.start({
        idea: "Fix the timeout copy",
        projectKey: project.projectKey,
        workflowBundleId: "ticket",
        baseBranch: await currentBranch(repo),
      });
      expect(run.identity.workflowBundleId).toBe("ticket");
      expect(run.state.status).toBe("completed");
      expect(run.state.phase).toBe("publish");
      expect(run.state.tasks[0]?.status).toBe("committed");
    } finally {
      await host.dispose();
    }
  });
});
