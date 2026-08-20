import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { bootTestHost, createTempRepo } from "../helpers.js";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, windowsHide: true });
  return stdout.trim();
}

describe("runLifecycle start base branch", () => {
  it("persists identity.baseBranch and matching baseSha; leaves branchName unset", async () => {
    const repo = await createTempRepo();
    const defaultBranch = await git(repo, ["branch", "--show-current"]);
    await git(repo, ["checkout", "-b", "lifecycle-base"]);
    await writeFile(path.join(repo, "BASE.md"), "lifecycle base\n", "utf8");
    await git(repo, ["add", "BASE.md"]);
    await git(repo, ["commit", "-m", "lifecycle base tip"]);
    const tip = await git(repo, ["rev-parse", "lifecycle-base"]);
    await git(repo, ["checkout", defaultBranch]);

    const { host } = await bootTestHost();
    try {
      const project = await host.ctx.projects.add(repo);
      const run = await host.ctx.runLifecycle.start({
        idea: "Start from an explicit base",
        projectKey: project.projectKey,
        baseBranch: "lifecycle-base",
      });
      expect(run.identity.baseBranch).toBe("lifecycle-base");
      expect(run.identity.baseSha).toBe(tip);
      expect(run.state.branchName).toBeUndefined();
    } finally {
      await host.dispose();
    }
  });
});
