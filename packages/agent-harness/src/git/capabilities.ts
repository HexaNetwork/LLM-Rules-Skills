import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HarnessFailure } from "../errors.js";

const exec = promisify(execFile);

/** `git worktree add --detach` has been available since Git 2.5. */
export const MIN_GIT_WORKTREE_VERSION = {
  major: 2,
  minor: 5,
  patch: 0,
} as const;

export type GitVersion = {
  major: number;
  minor: number;
  patch: number;
  version: string;
};

export type GitCapabilities = GitVersion & {
  worktreesSupported: boolean;
  platform: NodeJS.Platform;
};

export type GitWorktreeSupportEvaluation =
  | { worktreesSupported: true; message?: undefined }
  | { worktreesSupported: false; message: string };

/** Parse `git --version` stdout into numeric components. */
export function parseGitVersionOutput(stdout: string): GitVersion {
  const match = /git version\s+(\d+)\.(\d+)(?:\.(\d+))?/i.exec(stdout.trim());
  if (!match) {
    throw new HarnessFailure(
      `Could not parse git version from output: ${stdout.trim() || "(empty)"}. Install Git and ensure \`git --version\` works.`,
      "workspace",
      false,
    );
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
    version: `${match[1]}.${match[2]}.${match[3] ?? 0}`,
  };
}

function versionAtLeast(actual: GitVersion, minimum: typeof MIN_GIT_WORKTREE_VERSION): boolean {
  if (actual.major !== minimum.major) return actual.major > minimum.major;
  if (actual.minor !== minimum.minor) return actual.minor > minimum.minor;
  return actual.patch >= minimum.patch;
}

/** Pure check used by tests and by assertGitWorktreeCapability. */
export function evaluateGitWorktreeSupport(version: GitVersion): GitWorktreeSupportEvaluation {
  if (versionAtLeast(version, MIN_GIT_WORKTREE_VERSION)) {
    return { worktreesSupported: true };
  }
  const required = `${MIN_GIT_WORKTREE_VERSION.major}.${MIN_GIT_WORKTREE_VERSION.minor}.${MIN_GIT_WORKTREE_VERSION.patch}`;
  return {
    worktreesSupported: false,
    message:
      `Git ${version.version} is too old for per-run worktrees. ` +
      `Upgrade to Git ${required}+ so \`git worktree add --detach\` is available` +
      (process.platform === "win32"
        ? " (on Windows, install Git for Windows from https://git-scm.com/download/win)."
        : "."),
  };
}

/** Probe the local Git binary for version and worktree support. */
export async function probeGitCapabilities(cwd: string = process.cwd()): Promise<GitCapabilities> {
  let stdout: string;
  try {
    const result = await exec("git", ["--version"], { cwd, windowsHide: true });
    stdout = result.stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new HarnessFailure(
      `Git is required for per-run worktrees but \`git --version\` failed: ${detail}. Install Git and ensure it is on PATH.`,
      "workspace",
      false,
    );
  }
  const version = parseGitVersionOutput(stdout);
  const support = evaluateGitWorktreeSupport(version);
  return {
    ...version,
    worktreesSupported: support.worktreesSupported,
    platform: process.platform,
  };
}

/** Fail with an actionable message when Git cannot host linked worktrees. */
export async function assertGitWorktreeCapability(cwd?: string): Promise<GitCapabilities> {
  const caps = await probeGitCapabilities(cwd);
  if (!caps.worktreesSupported) {
    const support = evaluateGitWorktreeSupport(caps);
    throw new HarnessFailure(
      support.worktreesSupported === false
        ? support.message
        : `Git ${caps.version} cannot host linked worktrees.`,
      "workspace",
      false,
    );
  }
  return caps;
}
