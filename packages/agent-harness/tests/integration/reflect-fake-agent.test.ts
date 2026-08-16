import { describe, expect, it } from "vitest";
import { bootTestHost, createTempRepo } from "../helpers.js";

describe("reflect with fake agents", () => {
  it("starts from an idea and stops at awaiting_input", async () => {
    const repo = await createTempRepo();
    const { host } = await bootTestHost();
    try {
      const project = await host.ctx.projects.add(repo);
      const run = await host.ctx.runLifecycle.start({
        idea: "Add a health check",
        projectKey: project.projectKey,
      });
      expect(run.state.phase).toBe("reflect");
      expect(run.state.status).toBe("awaiting_input");
      expect(String((run.state.artifacts.reflect as { restatement?: string }).restatement)).toContain(
        "Add a health check",
      );
      expect(run.state.fog.length).toBeGreaterThan(0);
    } finally {
      await host.dispose();
    }
  });
});
