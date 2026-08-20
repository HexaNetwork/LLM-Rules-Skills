import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Context } from "@deepseek-ai/cordis";
import type { ProjectRegistration, RunIdentity } from "../domain/types.js";

const exec = promisify(execFile);

export type GitService = {
  listLocalBranches(cwd: string): Promise<{ branches: string[]; current?: string }>;
  createWorktree(
    registration: ProjectRegistration,
    runId: string,
    baseBranch: string,
  ): Promise<{ worktreePath: string; baseSha: string; baseBranch: string }>;
  removeWorktree(identity: RunIdentity): Promise<void>;
  commit(identity: RunIdentity, message: string): Promise<string>;
  publish(identity: RunIdentity, title: string, body: string): Promise<{ branch: string; url?: string }>;
  head(cwd: string): Promise<string>;
};

export function createGitService(): GitService {
  return {
    async listLocalBranches(cwd) {
      const raw = await git(cwd, ["branch", "--format=%(refname:short)"]);
      const branches = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const current = (await git(cwd, ["branch", "--show-current"]).catch(() => "")).trim() || undefined;
      return { branches, current };
    },
    async createWorktree(registration, runId, baseBranch) {
      const resolved = baseBranch.trim();
      if (!resolved) throw new Error("baseBranch is required");
      const baseSha = (await git(registration.controlRoot, ["rev-parse", "--verify", resolved])).trim();
      const worktreePath = path.join(registration.worktreeRoot, safe(runId));
      await mkdir(path.dirname(worktreePath), { recursive: true });
      await git(registration.controlRoot, ["worktree", "add", "--detach", worktreePath, baseSha]);
      return { worktreePath, baseSha, baseBranch: resolved };
    },
    async removeWorktree(identity) {
      await rm(identity.worktreePath, { recursive: true, force: true }).catch(() => undefined);
      await git(identity.controlRoot, ["worktree", "prune"]).catch(() => undefined);
    },
    async commit(identity, message) {
      await git(identity.worktreePath, ["add", "-A"]);
      const status = await git(identity.worktreePath, ["status", "--porcelain"]);
      if (!status.trim()) {
        return (await git(identity.worktreePath, ["rev-parse", "HEAD"])).trim();
      }
      await git(identity.worktreePath, ["commit", "-m", message]);
      return (await git(identity.worktreePath, ["rev-parse", "HEAD"])).trim();
    },
    async publish(identity, title, body) {
      const branch = `harness/${safe(identity.runId)}`;
      await git(identity.worktreePath, ["switch", "-c", branch]);
      const remotes = await git(identity.worktreePath, ["remote"]).catch(() => "");
      if (!remotes.trim()) {
        return { branch };
      }
      await git(identity.worktreePath, ["push", "-u", "origin", branch]);
      if (!process.env.GITHUB_TOKEN) return { branch };
      try {
        const { stdout } = await exec("gh", ["pr", "create", "--title", title, "--body", body], {
          cwd: identity.worktreePath,
          windowsHide: true,
        });
        return { branch, url: stdout.trim() };
      } catch {
        return { branch };
      }
    },
    async head(cwd) {
      return (await git(cwd, ["rev-parse", "HEAD"])).trim();
    },
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, windowsHide: true });
  return stdout;
}

function safe(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

export const gitPlugin = Object.assign(
  (ctx: Context) => {
    ctx.provide("git", createGitService());
  },
  {},
);
