import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createGitService } from "../../src/plugins/git.js";
import { createTempDir, createTempRepo } from "../helpers.js";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, windowsHide: true });
  return stdout.trim();
}

describe("GitService base branch", () => {
  it("listLocalBranches returns local names and the current branch", async () => {
    const repo = await createTempRepo();
    const current = await git(repo, ["branch", "--show-current"]);
    await git(repo, ["branch", "side"]);
    const gitService = createGitService();
    const listed = await gitService.listLocalBranches(repo);
    expect(listed.branches).toEqual(expect.arrayContaining([current, "side"]));
    expect(listed.branches.every((name) => !name.startsWith("remotes/"))).toBe(true);
    expect(listed.current).toBe(current);
  });

  it("createWorktree detaches at the selected base branch tip", async () => {
    const repo = await createTempRepo();
    const worktreeRoot = await createTempDir("harness-wt-");
    const defaultBranch = await git(repo, ["branch", "--show-current"]);
    await git(repo, ["checkout", "-b", "base-feature"]);
    await writeFile(path.join(repo, "FEATURE.md"), "from base-feature\n", "utf8");
    await git(repo, ["add", "FEATURE.md"]);
    await git(repo, ["commit", "-m", "feature tip"]);
    const featureSha = await git(repo, ["rev-parse", "base-feature"]);
    await git(repo, ["checkout", defaultBranch]);
    const defaultSha = await git(repo, ["rev-parse", defaultBranch]);
    expect(featureSha).not.toBe(defaultSha);

    const gitService = createGitService();
    const created = await gitService.createWorktree(
      {
        projectKey: "toy",
        controlRoot: repo,
        worktreeRoot,
        createdAt: new Date().toISOString(),
      },
      "run-base-1",
      "base-feature",
    );

    expect(created.baseBranch).toBe("base-feature");
    expect(created.baseSha).toBe(featureSha);
    expect(await git(created.worktreePath, ["rev-parse", "HEAD"])).toBe(featureSha);
    expect(await git(created.worktreePath, ["status", "--porcelain"])).toBe("");
  });

  it("pullBranch fast-forwards a stale local branch from origin before createWorktree", async () => {
    const repo = await createTempRepo();
    const worktreeRoot = await createTempDir("harness-wt-");
    const remoteDir = await createTempDir("remote-");
    const defaultBranch = await git(repo, ["branch", "--show-current"]);
    await git(remoteDir, ["init", "--bare"]);
    await git(repo, ["remote", "add", "origin", remoteDir]);
    await git(repo, ["push", "-u", "origin", defaultBranch]);

    await git(repo, ["checkout", "-b", "sync-base"]);
    await writeFile(path.join(repo, "BASE.md"), "shared base\n", "utf8");
    await git(repo, ["add", "BASE.md"]);
    await git(repo, ["commit", "-m", "shared base"]);
    await git(repo, ["push", "-u", "origin", "sync-base"]);
    const staleSha = await git(repo, ["rev-parse", "sync-base"]);

    const remoteWork = await createTempDir("remote-work-");
    await git(remoteWork, ["clone", remoteDir, "."]);
    await git(remoteWork, ["checkout", "sync-base"]);
    await writeFile(path.join(remoteWork, "REMOTE.md"), "remote tip\n", "utf8");
    await git(remoteWork, ["add", "REMOTE.md"]);
    await git(remoteWork, ["commit", "-m", "remote tip"]);
    await git(remoteWork, ["push", "origin", "sync-base"]);
    const remoteSha = await git(remoteWork, ["rev-parse", "sync-base"]);
    expect(remoteSha).not.toBe(staleSha);

    const gitService = createGitService();
    const created = await gitService.createWorktree(
      {
        projectKey: "toy",
        controlRoot: repo,
        worktreeRoot,
        createdAt: new Date().toISOString(),
      },
      "run-pull-1",
      "sync-base",
    );

    expect(created.baseSha).toBe(remoteSha);
    expect(await git(repo, ["rev-parse", "sync-base"])).toBe(remoteSha);
    expect(await git(created.worktreePath, ["rev-parse", "HEAD"])).toBe(remoteSha);
  });

  it("pullBranch is a no-op when the repository has no remotes", async () => {
    const repo = await createTempRepo();
    const gitService = createGitService();
    const defaultBranch = await git(repo, ["branch", "--show-current"]);
    await writeFile(path.join(repo, "ONLY-LOCAL.md"), "local\n", "utf8");
    await git(repo, ["add", "ONLY-LOCAL.md"]);
    await git(repo, ["commit", "-m", "local only"]);
    const tip = await git(repo, ["rev-parse", defaultBranch]);

    await expect(gitService.pullBranch(repo, defaultBranch)).resolves.toBeUndefined();
    expect(await git(repo, ["rev-parse", defaultBranch])).toBe(tip);
  });
});
