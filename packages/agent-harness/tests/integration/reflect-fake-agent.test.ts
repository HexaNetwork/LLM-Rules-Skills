import { describe, expect, it } from "vitest";
import { bootTestHost, createTempRepo, currentBranch } from "../helpers.js";

describe("reflect with fake agents", () => {
  it("starts from an idea and stops at awaiting_input", async () => {
    const repo = await createTempRepo();
    const { host } = await bootTestHost();
    try {
      const project = await host.ctx.projects.add(repo);
      const run = await host.ctx.runLifecycle.start({
        idea: "Add a health check",
        projectKey: project.projectKey,
        baseBranch: await currentBranch(repo),
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

  it("blocks with a retriable error when reflector output is not structured", async () => {
    const repo = await createTempRepo();
    const { host } = await bootTestHost({
      agents: {
        mode: "fake",
        scripted: {
          reflector: { text: "Add a health check" },
        },
      },
    });
    try {
      const project = await host.ctx.projects.add(repo);
      const run = await host.ctx.runLifecycle.start({
        idea: "Add a health check",
        projectKey: project.projectKey,
        baseBranch: await currentBranch(repo),
      });
      expect(run.state.phase).toBe("reflect");
      expect(run.state.status).toBe("blocked");
      expect(run.state.block?.retriable).toBe(true);
      expect(run.state.block?.reason).toMatch(/Invalid reflector output/i);
      expect(run.state.artifacts.reflect).toBeUndefined();
      expect(run.state.gate).toBeUndefined();
    } finally {
      await host.dispose();
    }
  });
});
