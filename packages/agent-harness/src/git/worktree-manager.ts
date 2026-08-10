import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  assertWorktreeRootOutsideControlRoot,
  isPathUnderControlRoot,
} from "../application/harness-home.js";
import {
  assertWorktreePathContained,
  canonicalizeWorkspacePath,
  sanitizeWorktreeRunId,
  type RunWorkspace,
  WORKSPACE_SCHEMA_VERSION,
} from "../domain/workspace.js";
import { HarnessFailure } from "../errors.js";
import type { RunStore } from "../store.js";
import { assertGitWorktreeCapability } from "./capabilities.js";

export type WorktreeInspection = {
  path: string;
  toplevel: string;
  headSha: string;
  gitCommonDir: string;
  detached: boolean;
  registered: boolean;
};

export type WorktreeManagerOptions = {
  controlRoot: string;
  stateRoot: string;
  /**
   * Parent directory for per-run worktrees. Defaults to `<stateRoot>/worktrees`
   * for legacy repository-local installs; external projects pass the sibling
   * or configured override root.
   */
  worktreeRoot?: string;
  store: RunStore;
};

export type CreateWorktreeInput = {
  runId: string;
  baseBranch: string;
  /** When set, skip resolving baseBranch and detach at this commit (migration). */
  baseSha?: string;
  branchName?: string;
  createdAt?: string;
};

/**
 * Creates, inspects, and reopens per-run linked worktrees.
 * Shared Git worktree-metadata mutations take the workspace-admin lock.
 */
export class WorktreeManager {
  private readonly controlRoot: string;
  private readonly stateRoot: string;
  private readonly worktreeParent: string;

  constructor(private readonly options: WorktreeManagerOptions) {
    this.controlRoot = path.resolve(options.controlRoot);
    this.stateRoot = path.resolve(options.stateRoot);
    this.worktreeParent = path.resolve(
      options.worktreeRoot?.trim()
        ? options.worktreeRoot
        : path.join(this.stateRoot, "worktrees"),
    );
    // External / sibling roots must stay outside the target repository.
    // Legacy `<stateRoot>/worktrees` under controlRoot remains allowed.
    if (!isPathUnderControlRoot(this.worktreeParent, this.controlRoot)) {
      assertWorktreeRootOutsideControlRoot(this.worktreeParent, this.controlRoot);
    }
  }

  worktreePathFor(runId: string): string {
    return path.join(this.worktreeParent, sanitizeWorktreeRunId(runId));
  }

  async create(input: CreateWorktreeInput): Promise<RunWorkspace> {
    await assertGitWorktreeCapability(this.controlRoot);
    const inside = await this.git(
      this.controlRoot,
      ["rev-parse", "--is-inside-work-tree"],
      true,
    );
    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
      throw new HarnessFailure(
        `git.enabled is true but ${this.controlRoot} is not a git repository. ` +
          "Run `git init` and make an initial commit, or set git.enabled: false in agent-harness.config.yaml.",
        "workspace",
        true,
      );
    }
    let baseSha = input.baseSha?.trim();
    if (!baseSha) {
      const baseShaResult = await this.git(
        this.controlRoot,
        ["rev-parse", `${input.baseBranch}^{commit}`],
        true,
      );
      baseSha = baseShaResult.stdout.trim();
      if (baseShaResult.exitCode !== 0 || !baseSha) {
        throw new HarnessFailure(
          `Could not resolve base branch ${input.baseBranch} to a commit`,
          "workspace",
          false,
        );
      }
    } else {
      const verify = await this.git(this.controlRoot, ["rev-parse", "--verify", `${baseSha}^{commit}`], true);
      if (verify.exitCode !== 0) {
        throw new HarnessFailure(
          `Could not resolve baseSha ${baseSha} to a commit`,
          "workspace",
          false,
        );
      }
      baseSha = verify.stdout.trim() || baseSha;
    }

    const worktreePath = this.worktreePathFor(input.runId);
    assertWorktreePathContained(worktreePath, this.worktreeParent);
    await mkdir(this.worktreeParent, { recursive: true });

    let registered = false;
    try {
      return await this.options.store.withWorkspaceAdminLock(
        { runId: input.runId, action: "create-worktree" },
        async () => {
          await this.git(this.controlRoot, [
            "worktree",
            "add",
            "--detach",
            worktreePath,
            baseSha,
          ]);
          registered = true;
          const inspection = await this.inspectAt(worktreePath);
          return {
            version: WORKSPACE_SCHEMA_VERSION,
            kind: "git-worktree" as const,
            controlRoot: canonicalizeWorkspacePath(this.controlRoot),
            worktreePath: canonicalizeWorkspacePath(worktreePath),
            gitCommonDir: canonicalizeWorkspacePath(inspection.gitCommonDir),
            baseBranch: input.baseBranch,
            baseSha,
            ...(input.branchName ? { branchName: input.branchName } : {}),
            createdAt: input.createdAt ?? new Date().toISOString(),
          };
        },
      );
    } catch (error) {
      if (registered) {
        await this.removeExactCleanWorktree(worktreePath).catch(() => undefined);
      }
      throw error;
    }
  }

  async inspect(workspace: RunWorkspace): Promise<WorktreeInspection> {
    if (workspace.kind !== "git-worktree" || !workspace.worktreePath) {
      throw new HarnessFailure(
        "Cannot inspect a non-worktree run workspace",
        "workspace",
        false,
      );
    }
    return this.inspectAt(workspace.worktreePath);
  }

  /**
   * Validate a recorded worktree is still registered and matches identity.
   * Throws a retriable workspace failure when missing/moved/mismatched.
   */
  async open(workspace: RunWorkspace): Promise<RunWorkspace> {
    if (workspace.kind !== "git-worktree" || !workspace.worktreePath) {
      throw new HarnessFailure(
        "Cannot open a non-worktree run workspace",
        "workspace",
        false,
      );
    }
    assertWorktreePathContained(workspace.worktreePath, this.worktreeParent);

    let inspection: WorktreeInspection;
    try {
      inspection = await this.inspectAt(workspace.worktreePath);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new HarnessFailure(
        `Run worktree is missing or unusable at ${workspace.worktreePath}. ${detail}`,
        "workspace",
        true,
        { cause: error instanceof Error ? error : undefined },
      );
    }

    if (!inspection.registered) {
      throw new HarnessFailure(
        `Run worktree is no longer registered in git worktree list: ${workspace.worktreePath}`,
        "workspace",
        true,
      );
    }

    const expectedToplevel = canonicalizeWorkspacePath(workspace.worktreePath);
    const observedToplevel = canonicalizeWorkspacePath(inspection.toplevel);
    if (!pathsEqual(expectedToplevel, observedToplevel)) {
      throw new HarnessFailure(
        `Run worktree toplevel moved (expected ${expectedToplevel}, observed ${observedToplevel})`,
        "workspace",
        true,
      );
    }

    if (workspace.gitCommonDir) {
      const expectedCommon = canonicalizeWorkspacePath(workspace.gitCommonDir);
      const observedCommon = canonicalizeWorkspacePath(inspection.gitCommonDir);
      if (!pathsEqual(expectedCommon, observedCommon)) {
        throw new HarnessFailure(
          `Run worktree git common directory mismatch (expected ${expectedCommon}, observed ${observedCommon})`,
          "workspace",
          true,
        );
      }
    }

    if (workspace.baseSha) {
      const ancestor = await this.git(
        workspace.worktreePath,
        ["merge-base", "--is-ancestor", workspace.baseSha, "HEAD"],
        true,
      );
      if (ancestor.exitCode !== 0) {
        throw new HarnessFailure(
          `Run worktree HEAD no longer descends from recorded base ${workspace.baseSha}`,
          "workspace",
          true,
        );
      }
    }

    return {
      ...workspace,
      worktreePath: expectedToplevel,
      gitCommonDir: canonicalizeWorkspacePath(inspection.gitCommonDir),
    };
  }

  /**
   * Gather cleanup facts for a recorded worktree without mutating Git.
   * Missing registration / path failures become negative facts rather than throws.
   */
  async inspectCleanupTarget(workspace: RunWorkspace): Promise<{
    pathValid: boolean;
    registered: boolean;
    gitCommonDirMatches: boolean;
    dirty: boolean;
    headSha: string | undefined;
    commitsReachableFromRetainedRef: boolean;
  }> {
    if (workspace.kind !== "git-worktree" || !workspace.worktreePath) {
      return {
        pathValid: false,
        registered: false,
        gitCommonDirMatches: false,
        dirty: false,
        headSha: undefined,
        commitsReachableFromRetainedRef: false,
      };
    }

    let pathValid = true;
    try {
      assertWorktreePathContained(workspace.worktreePath, this.worktreeParent);
      if (pathsEqual(workspace.worktreePath, this.controlRoot)) pathValid = false;
    } catch {
      pathValid = false;
    }

    const listed = await this.listWorktrees();
    const entry = listed.find((item) => pathsEqual(item.path, workspace.worktreePath!));
    const registered = Boolean(entry);
    if (!registered || !pathValid) {
      return {
        pathValid,
        registered,
        gitCommonDirMatches: false,
        dirty: false,
        headSha: entry?.headSha,
        commitsReachableFromRetainedRef: false,
      };
    }

    let gitCommonDirMatches = true;
    try {
      const inspection = await this.inspectAt(workspace.worktreePath);
      if (workspace.gitCommonDir) {
        gitCommonDirMatches = pathsEqual(workspace.gitCommonDir, inspection.gitCommonDir);
      }
    } catch {
      gitCommonDirMatches = false;
    }

    const dirtyResult = await this.git(
      workspace.worktreePath,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      true,
    );
    const dirty = dirtyResult.exitCode === 0 && Boolean(dirtyResult.stdout.trim());

    const headResult = await this.git(workspace.worktreePath, ["rev-parse", "HEAD"], true);
    const headSha = headResult.exitCode === 0 ? headResult.stdout.trim() : undefined;

    const commitsReachableFromRetainedRef = await this.areCommitsReachableFromRetainedRefs(
      workspace,
      headSha,
    );

    return {
      pathValid,
      registered,
      gitCommonDirMatches,
      dirty,
      headSha,
      commitsReachableFromRetainedRef,
    };
  }

  /**
   * Remove a validated clean registered worktree. Caller must enforce the cleanup decision matrix.
   * Never runs `git worktree prune`.
   */
  async removeRegisteredWorktree(workspace: RunWorkspace, runId: string): Promise<void> {
    if (workspace.kind !== "git-worktree" || !workspace.worktreePath) {
      throw new HarnessFailure("Cannot remove a non-worktree run workspace", "workspace", false);
    }
    const resolved = path.resolve(workspace.worktreePath);
    assertWorktreePathContained(resolved, this.worktreeParent);
    if (pathsEqual(resolved, this.controlRoot)) {
      throw new HarnessFailure(
        "Refusing to remove the control root as a run worktree",
        "workspace",
        false,
      );
    }

    await this.options.store.withWorkspaceAdminLock(
      { runId, action: "remove-worktree" },
      async () => {
        const listed = await this.listWorktrees();
        const registered = listed.some((entry) => pathsEqual(entry.path, resolved));
        if (!registered) {
          throw new HarnessFailure(
            `Refusing to remove path that is not a registered worktree: ${resolved}`,
            "workspace",
            false,
          );
        }
        const dirty = await this.git(
          resolved,
          ["status", "--porcelain=v1", "--untracked-files=all"],
          true,
        );
        if (dirty.stdout.trim()) {
          throw new HarnessFailure(
            `Refusing to remove dirty run worktree: ${resolved}`,
            "workspace",
            false,
          );
        }
        await this.git(this.controlRoot, ["worktree", "remove", resolved]);
      },
    );
  }

  private async areCommitsReachableFromRetainedRefs(
    workspace: RunWorkspace,
    headSha: string | undefined,
  ): Promise<boolean> {
    if (!workspace.worktreePath || !headSha) return false;
    if (workspace.baseSha && headSha === workspace.baseSha) return true;

    const refs = [workspace.branchName, workspace.baseBranch].filter(
      (value): value is string => Boolean(value),
    );
    for (const ref of refs) {
      const result = await this.git(
        workspace.worktreePath,
        ["merge-base", "--is-ancestor", headSha, ref],
        true,
      );
      if (result.exitCode === 0) return true;
    }
    return false;
  }

  /**
   * Remove only the exact just-created worktree path when creation fails after registration.
   * Refuses if the tree is dirty or the path is not a registered linked worktree.
   */
  async removeExactCleanWorktree(worktreePath: string): Promise<void> {
    const resolved = path.resolve(worktreePath);
    assertWorktreePathContained(resolved, this.worktreeParent);
    if (pathsEqual(resolved, this.controlRoot)) {
      throw new HarnessFailure(
        "Refusing to remove the control root as a run worktree",
        "workspace",
        false,
      );
    }

    await this.options.store.withWorkspaceAdminLock(
      { runId: path.basename(resolved), action: "remove-worktree" },
      async () => {
        const listed = await this.listWorktrees();
        const registered = listed.some((entry) => pathsEqual(entry.path, resolved));
        if (!registered) {
          throw new HarnessFailure(
            `Refusing to remove path that is not a registered worktree: ${resolved}`,
            "workspace",
            false,
          );
        }
        const dirty = await this.git(
          resolved,
          ["status", "--porcelain=v1", "--untracked-files=all"],
          true,
        );
        if (dirty.stdout.trim()) {
          throw new HarnessFailure(
            `Refusing to remove dirty run worktree during reconcile: ${resolved}`,
            "workspace",
            false,
          );
        }
        await this.git(this.controlRoot, ["worktree", "remove", resolved]);
      },
    );
  }

  private async inspectAt(worktreePath: string): Promise<WorktreeInspection> {
    const resolved = path.resolve(worktreePath);
    const listed = await this.listWorktrees();
    const entry = listed.find((item) => pathsEqual(item.path, resolved));
    if (!entry) {
      throw new HarnessFailure(
        `Worktree is not registered in git worktree list: ${resolved}`,
        "workspace",
        true,
      );
    }
    const toplevel = (
      await this.git(resolved, ["rev-parse", "--show-toplevel"])
    ).stdout.trim();
    const commonRaw = (
      await this.git(resolved, ["rev-parse", "--git-common-dir"])
    ).stdout.trim();
    return {
      path: resolved,
      toplevel: path.resolve(toplevel),
      headSha: entry.headSha,
      gitCommonDir: path.resolve(resolved, commonRaw),
      detached: entry.detached,
      registered: true,
    };
  }

  private async listWorktrees(): Promise<
    Array<{ path: string; headSha: string; detached: boolean }>
  > {
    const porcelain = (
      await this.git(this.controlRoot, ["worktree", "list", "--porcelain"])
    ).stdout;
    return parseWorktreePorcelain(porcelain);
  }

  private git(
    cwd: string,
    args: string[],
    allowFailure = false,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn("git", args, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout = `${stdout}${chunk.toString("utf8")}`.slice(-200_000);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString("utf8")}`.slice(-200_000);
      });
      child.once("error", reject);
      const timer = setTimeout(() => child.kill("SIGKILL"), 10 * 60 * 1000);
      child.once("close", (code) => {
        clearTimeout(timer);
        const result = { exitCode: code ?? 1, stdout, stderr };
        if (result.exitCode !== 0 && !allowFailure) {
          reject(
            new HarnessFailure(
              `git ${args[0] ?? ""} failed (${result.exitCode}): ${stderr || stdout}`,
              "workspace",
              true,
            ),
          );
          return;
        }
        resolve(result);
      });
    });
  }
}

function parseWorktreePorcelain(
  porcelain: string,
): Array<{ path: string; headSha: string; detached: boolean }> {
  const entries: Array<{ path: string; headSha: string; detached: boolean }> = [];
  let current: { path?: string; headSha?: string; detached: boolean } | undefined;
  for (const line of porcelain.split(/\r?\n/)) {
    if (line === "") {
      if (current?.path && current.headSha) {
        entries.push({
          path: path.resolve(current.path),
          headSha: current.headSha,
          detached: current.detached,
        });
      }
      current = undefined;
      continue;
    }
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), detached: false };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) {
      current.headSha = line.slice("HEAD ".length).trim();
    } else if (line === "detached") {
      current.detached = true;
    }
  }
  if (current?.path && current.headSha) {
    entries.push({
      path: path.resolve(current.path),
      headSha: current.headSha,
      detached: current.detached,
    });
  }
  return entries;
}

function pathsEqual(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const canonical = canonicalizeWorkspacePath(value);
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
  };
  return normalize(left) === normalize(right);
}
