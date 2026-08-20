import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { bootTestHost, createTempRepo } from "../helpers.js";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, windowsHide: true });
  return stdout.trim();
}

describe("publish sets branchName", () => {
  it("persists state.branchName from git.publish after the publish phase", async () => {
    const repo = await createTempRepo();
    const baseBranch = await git(repo, ["branch", "--show-current"]);
    const { host } = await bootTestHost({
      bundles: [{ id: "publish-only", phases: ["publish"] }],
    });
    try {
      const project = await host.ctx.projects.add(repo);
      const run = await host.ctx.runLifecycle.start({
        idea: "Ship a tiny change",
        projectKey: project.projectKey,
        workflowBundleId: "publish-only",
        baseBranch,
      });
      expect(run.state.status).toBe("completed");
      expect(run.state.phase).toBe("publish");
      const expected = `harness/${run.identity.runId}`;
      expect(run.state.branchName).toBe(expected);
      expect(run.state.artifacts.publish).toMatchObject({ branch: expected });
    } finally {
      await host.dispose();
    }
  });
});
