import { describe, expect, it } from "vitest";
import { mergeSettings } from "../../src/domain/settings.js";
import { bootTestHost, createTempRepo, currentBranch } from "../helpers.js";

describe("live settings", () => {
  it("merges packaged defaults under global then project layers", () => {
    const live = mergeSettings(
      { budgets: { graphifyTokens: 2500 } },
      { verification: { command: "npm test" } },
    );
    expect(live.budgets.graphifyTokens).toBe(2500);
    expect(live.verification.command).toBe("npm test");
    expect(live.workflow.agentTimeoutMinutes).toBe(30);
  });

  it("writes global and project agent timeout overrides", async () => {
    const { host } = await bootTestHost();
    try {
      const global = await host.ctx.settings.writeAgentTimeout(45);
      expect(global.globalMinutes).toBe(45);
      expect(global.effectiveMinutes).toBe(45);

      const projectKey = "project-timeout-test";
      const project = await host.ctx.settings.writeAgentTimeout(12, projectKey);
      expect(project.projectMinutes).toBe(12);
      expect(project.effectiveMinutes).toBe(12);

      const inherited = await host.ctx.settings.writeAgentTimeout(null, projectKey);
      expect(inherited.projectMinutes).toBeUndefined();
      expect(inherited.effectiveMinutes).toBe(45);
    } finally {
      await host.dispose();
    }
  });

  it("re-reads project settings on every advance and audits the snapshot", async () => {
    const repo = await createTempRepo();
    const { host } = await bootTestHost();
    try {
      const project = await host.ctx.projects.add(repo);
      await host.ctx.store.writeProjectSettings(project.projectKey, {
        verification: { command: "echo first" },
      });
      const started = await host.ctx.runLifecycle.start({
        idea: "Add a status badge",
        projectKey: project.projectKey,
        baseBranch: await currentBranch(repo),
      });
      expect(started.identity.workflowBundleId).toBe("default");
      expect(started.settings.verification.command).toBe("echo first");

      await host.ctx.store.writeProjectSettings(project.projectKey, {
        verification: { command: "echo second" },
      });
      const answered = await host.ctx.runLifecycle.answer(started.identity.runId, {
        answers: { restatement: "yes" },
      });
      expect(answered.settings.verification.command).toBe("echo second");
      expect(answered.identity.worktreePath).toBe(started.identity.worktreePath);
      expect(answered.identity.baseSha).toBe(started.identity.baseSha);
      expect(answered.identity.workflowBundleId).toBe(started.identity.workflowBundleId);

      const audit = await host.ctx.store.readSettingsAudit(started.identity.runId);
      expect(audit[0]?.settings.verification.command).toBe("echo first");
      expect(audit.some((entry) => entry.settings.verification.command === "echo second")).toBe(true);
    } finally {
      await host.dispose();
    }
  });
});
