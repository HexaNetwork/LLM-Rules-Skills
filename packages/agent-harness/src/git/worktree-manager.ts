import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathsEqual } from "../application/harness-home.js";
import type { RunRepository } from "../application/run-repository.js";
import {
  canonicalizeWorkspacePath,
  sanitizeWorktreeRunId,
  WORKSPACE_SCHEMA_VERSION,
  type HostWorktreeWorkspace,
  type RunWorkspace,
} from "../domain/workspace.js";
import { HarnessFailure } from "../errors.js";

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
  worktreeRoot?: string;
  store: Pick<RunRepository, "withWorkspaceAdminLock">;
};

export type CreateWorktreeInput = {
  runId: string;
  baseBranch: string;
  baseSha?: string;
  branchName?: string;
  createdAt?: string;
};

/**
 * Host-owned linked worktrees. The sandbox bind-mounts the worktree path;
 * accepted commits stay on this host tree.
 */
export class WorktreeManager {
  private readonly controlRoot: string;
  private readonly worktreeParent: string;

  constructor(private readonly options: WorktreeManagerOptions) {
    this.controlRoot = path.resolve(options.controlRoot);
    this.worktreeParent = path.resolve(
      options.worktreeRoot?.trim()
        ? options.worktreeRoot
        : path.join(path.resolve(options.stateRoot), "worktrees"),
    );
  }

  worktreePathFor(runId: string): string {
    return path.join(this.worktreeParent, sanitizeWorktreeRunId(runId));
  }

  async create(input: CreateWorktreeInput): Promise<HostWorktreeWorkspace> {
    const inside = await this.git(this.controlRoot, ["rev-parse", "--is-inside-work-tree"], true);
    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
      throw new HarnessFailure(
        `git.enabled is true but ${this.controlRoot} is not a git repository.`,
        "workspace",
        true,
      );
    }
    let baseSha = input.baseSha?.trim();
    if (!baseSha) {
      const resolved = await this.git(
        this.controlRoot,
        ["rev-parse", `${input.baseBranch}^{commit}`],
        true,
      );
      baseSha = resolved.stdout.trim();
      if (resolved.exitCode !== 0 || !baseSha) {
        throw new HarnessFailure(
          `Could not resolve base branch ${input.baseBranch} to a commit`,
          "workspace",
          false,
        );
      }
    } else {
      const verify = await this.git(
        this.controlRoot,
        ["rev-parse", "--verify", `${baseSha}^{commit}`],
        true,
      );
      if (verify.exitCode !== 0) {
        throw new HarnessFailure(`Could not resolve baseSha ${baseSha} to a commit`, "workspace", false);
      }
      baseSha = verify.stdout.trim() || baseSha;
    }

    const worktreePath = this.worktreePathFor(input.runId);
    assertContained(worktreePath, this.worktreeParent);
    await mkdir(this.worktreeParent, { recursive: true });

    let registered = false;
    try {
      return await this.options.store.withWorkspaceAdminLock(
        { runId: input.runId, action: "create-worktree" },
        async () => {
          await this.git(this.controlRoot, ["worktree", "add", "--detach", worktreePath, baseSha]);
          registered = true;
          const inspection = await this.inspectAt(worktreePath);
          return {
            version: WORKSPACE_SCHEMA_VERSION,
            kind: "host-worktree" as const,
            controlRoot: canonicalizeWorkspacePath(this.controlRoot),
            worktreePath: canonicalizeWorkspacePath(worktreePath),
            gitCommonDir: canonicalizeWorkspacePath(inspection.gitCommonDir),
            workspacePath: "/workspace" as const,
            baseSha,
            ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
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
    if (workspace.kind !== "host-worktree") {
      throw new HarnessFailure("Cannot inspect a non-worktree run workspace", "workspace", false);
    }
    return this.inspectAt(workspace.worktreePath);
  }

  async open(workspace: RunWorkspace): Promise<HostWorktreeWorkspace> {
    if (workspace.kind !== "host-worktree") {
      throw new HarnessFailure("Cannot open a non-worktree run workspace", "workspace", false);
    }
    assertContained(workspace.worktreePath, this.worktreeParent);
    const inspection = await this.inspectAt(workspace.worktreePath);
    if (!inspection.registered) {
      throw new HarnessFailure(
        `Run worktree is no longer registered: ${workspace.worktreePath}`,
        "workspace",
        true,
      );
    }
    return {
      ...workspace,
      worktreePath: canonicalizeWorkspacePath(inspection.toplevel),
      gitCommonDir: canonicalizeWorkspacePath(inspection.gitCommonDir),
    };
  }

  async inspectCleanupTarget(workspace: RunWorkspace): Promise<{
    pathValid: boolean;
    registered: boolean;
    gitCommonDirMatches: boolean;
    dirty: boolean;
    headSha: string | undefined;
    commitsReachableFromRetainedRef: boolean;
  }> {
    if (workspace.kind !== "host-worktree") {
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
      assertContained(workspace.worktreePath, this.worktreeParent);
      if (pathsEqual(workspace.worktreePath, this.controlRoot)) pathValid = false;
    } catch {
      pathValid = false;
    }
    const listed = await this.listWorktrees();
    const entry = listed.find((item) => pathsEqual(item.path, workspace.worktreePath));
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
    const dirtyResult = await this.git(
      workspace.worktreePath,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      true,
    );
    const headResult = await this.git(workspace.worktreePath, ["rev-parse", "HEAD"], true);
    return {
      pathValid,
      registered,
      gitCommonDirMatches: true,
      dirty: dirtyResult.exitCode === 0 && Boolean(dirtyResult.stdout.trim()),
      headSha: headResult.exitCode === 0 ? headResult.stdout.trim() : undefined,
      commitsReachableFromRetainedRef: Boolean(
        workspace.baseSha && headResult.stdout.trim() === workspace.baseSha,
      ),
    };
  }

  async removeRegisteredWorktree(workspace: RunWorkspace, runId: string): Promise<void> {
    if (workspace.kind !== "host-worktree") {
      throw new HarnessFailure("Cannot remove a non-worktree run workspace", "workspace", false);
    }
    const resolved = path.resolve(workspace.worktreePath);
    assertContained(resolved, this.worktreeParent);
    await this.options.store.withWorkspaceAdminLock({ runId, action: "remove-worktree" }, async () => {
      await this.git(this.controlRoot, ["worktree", "remove", "--force", resolved], true);
    });
  }

  async removeExactCleanWorktree(worktreePath: string): Promise<void> {
    const resolved = path.resolve(worktreePath);
    assertContained(resolved, this.worktreeParent);
    await this.git(this.controlRoot, ["worktree", "remove", "--force", resolved], true);
  }

  private async inspectAt(worktreePath: string): Promise<WorktreeInspection> {
    const resolved = path.resolve(worktreePath);
    const listed = await this.listWorktrees();
    const entry = listed.find((item) => pathsEqual(item.path, resolved));
    if (!entry) {
      throw new HarnessFailure(`Worktree is not registered: ${resolved}`, "workspace", true);
    }
    const toplevel = (await this.git(resolved, ["rev-parse", "--show-toplevel"])).stdout.trim();
    const commonRaw = (await this.git(resolved, ["rev-parse", "--git-common-dir"])).stdout.trim();
    return {
      path: resolved,
      toplevel: path.resolve(toplevel),
      headSha: entry.headSha,
      gitCommonDir: path.resolve(resolved, commonRaw),
      detached: entry.detached,
      registered: true,
    };
  }

  private async listWorktrees(): Promise<Array<{ path: string; headSha: string; detached: boolean }>> {
    const porcelain = (await this.git(this.controlRoot, ["worktree", "list", "--porcelain"], true))
      .stdout;
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

function assertContained(candidate: string, parent: string): void {
  const child = path.resolve(candidate).replaceAll("\\", "/").toLowerCase();
  const root = path.resolve(parent).replaceAll("\\", "/").toLowerCase().replace(/\/+$/, "");
  if (child !== root && !child.startsWith(`${root}/`)) {
    throw new HarnessFailure(
      `Worktree path ${candidate} is outside ${parent}`,
      "workspace",
      false,
    );
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
    if (line.startsWith("HEAD ")) current.headSha = line.slice("HEAD ".length).trim();
    else if (line === "detached") current.detached = true;
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
