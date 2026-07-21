import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sha256Text } from "./hash.js";

const execFileAsync = promisify(execFile);

export type GitResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export async function git(
  cwd: string,
  args: string[],
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 20 * 1024 * 1024,
      encoding: "utf8",
    });
    return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), exitCode: 0 };
  } catch (error) {
    const err = error as {
      stdout?: string;
      stderr?: string;
      code?: number;
      message?: string;
    };
    return {
      stdout: (err.stdout ?? "").trimEnd(),
      stderr: (err.stderr ?? err.message ?? "").trimEnd(),
      exitCode: typeof err.code === "number" ? err.code : 1,
    };
  }
}

export async function gitOk(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${result.exitCode}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

export async function isCleanWorktree(cwd: string): Promise<boolean> {
  const status = await gitOk(cwd, ["status", "--porcelain"]);
  return status.trim() === "";
}

export async function currentBranch(cwd: string): Promise<string> {
  return gitOk(cwd, ["branch", "--show-current"]);
}

export async function revParse(cwd: string, ref: string): Promise<string> {
  return gitOk(cwd, ["rev-parse", ref]);
}

export async function changedFiles(
  cwd: string,
  baseRef?: string,
): Promise<string[]> {
  if (baseRef) {
    const out = await gitOk(cwd, ["diff", "--name-only", baseRef, "HEAD"]);
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }
  const staged = await gitOk(cwd, ["diff", "--name-only", "--cached"]);
  const unstaged = await gitOk(cwd, ["diff", "--name-only"]);
  const untracked = await gitOk(cwd, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  return [
    ...new Set(
      [...staged.split("\n"), ...unstaged.split("\n"), ...untracked.split("\n")]
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * Fingerprint of dirty worktree state (porcelain + diff vs HEAD).
 * Used by the worker no-code watchdog to detect whether an agent produced edits.
 */
export async function worktreeFingerprint(cwd: string): Promise<string> {
  const porcelain = await git(cwd, ["status", "--porcelain"]);
  const diff = await git(cwd, ["diff", "HEAD"]);
  return sha256Text(`${porcelain.stdout}\n---\n${diff.stdout}`);
}

export async function commitAll(
  cwd: string,
  message: string,
): Promise<string> {
  await gitOk(cwd, ["add", "-A"]);
  const status = await gitOk(cwd, ["status", "--porcelain"]);
  if (!status.trim()) {
    return revParse(cwd, "HEAD");
  }
  await gitOk(cwd, ["commit", "-m", message]);
  return revParse(cwd, "HEAD");
}
