import { randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { checked, runProcess } from "./process.js";

export class GitRuntime {
  constructor(private readonly worktreeRoot: string) {}

  async listLocalBranches(cwd: string): Promise<{ branches: string[]; current?: string }> {
    const listed = await runProcess("git", ["-C", cwd, "branch", "--format=%(refname:short)"]);
    if (listed.exitCode !== 0) throw new Error(listed.stderr.trim() || "Failed to list branches");
    const branches = [...new Set(listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean))].filter((name) => !name.startsWith("remotes/"));
    const currentResult = await runProcess("git", ["-C", cwd, "branch", "--show-current"]);
    const current = currentResult.exitCode === 0 ? currentResult.stdout.trim() || undefined : undefined;
    return { branches, current };
  }

  async createWorktree(input: { runId: string; repositoryPath: string; baseBranch: string; fresh?: boolean }): Promise<string> {
    const target = path.join(this.worktreeRoot, input.runId);
    await mkdir(this.worktreeRoot, { recursive: true });
    if (input.fresh) {
      await mkdir(target, { recursive: true });
      if ((await readdir(target)).length === 0) await checked("git", ["init", "--initial-branch", input.baseBranch], { cwd: target });
      return target;
    }
    const existing = await runProcess("git", ["-C", input.repositoryPath, "worktree", "list", "--porcelain"]);
    if (existing.stdout.includes(`worktree ${target.replace(/\\/g, "/")}`) || existing.stdout.includes(`worktree ${target}`)) return target;
    await checked("git", ["-C", input.repositoryPath, "worktree", "add", "--detach", target, input.baseBranch]);
    return target;
  }

  async isClean(workspace: string): Promise<boolean> { return (await checked("git", ["status", "--porcelain"], { cwd: workspace })).stdout.trim() === ""; }

  async commit(workspace: string, message: string): Promise<{ commit: string; created: boolean }> {
    const status = await checked("git", ["status", "--porcelain"], { cwd: workspace });
    if (!status.stdout.trim()) return { commit: (await checked("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout.trim(), created: false };
    await checked("git", ["add", "--all"], { cwd: workspace });
    await checked("git", ["commit", "-m", message], { cwd: workspace });
    return { commit: (await checked("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout.trim(), created: true };
  }

  async publish(input: { workspace: string; branch: string; remote: string; title: string; body: string; draft: boolean }): Promise<{ branch: string; commit: string; pullRequestUrl: string }> {
    const clean = await this.isClean(input.workspace);
    if (!clean) throw new Error("Publish requires a clean worktree");
    const commit = (await checked("git", ["rev-parse", "HEAD"], { cwd: input.workspace })).stdout.trim();
    const current = (await checked("git", ["branch", "--show-current"], { cwd: input.workspace })).stdout.trim();
    if (current !== input.branch) await checked("git", ["switch", "-C", input.branch], { cwd: input.workspace });
    const remoteRef = await runProcess("git", ["ls-remote", "--heads", input.remote, input.branch], { cwd: input.workspace });
    if (!remoteRef.stdout.includes(commit)) await checked("git", ["push", "--set-upstream", input.remote, `${input.branch}:${input.branch}`], { cwd: input.workspace, timeoutMs: 120_000 });
    const found = await runProcess("gh", ["pr", "view", input.branch, "--json", "url", "--jq", ".url"], { cwd: input.workspace });
    let pullRequestUrl = found.exitCode === 0 ? found.stdout.trim() : "";
    if (!pullRequestUrl) {
      const args = ["pr", "create", "--head", input.branch, "--title", input.title, "--body", input.body];
      if (input.draft) args.push("--draft");
      pullRequestUrl = (await checked("gh", args, { cwd: input.workspace, timeoutMs: 120_000 })).stdout.trim();
    }
    return { branch: input.branch, commit, pullRequestUrl };
  }
}

export function deliveryBranch(runId: string, title = "change"): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "change";
  return `agent-harness/${slug}-${runId.slice(0, 8)}`;
}

export function publicationActionId(runId: string): string { return `${runId}/publish/git/0`; }
