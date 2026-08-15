import { createHash } from "node:crypto";
import { access, appendFile, mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import {
  dirname as pathDirname,
  relative as pathRelative,
  resolve as pathResolve,
} from "node:path";
import { resolveHarnessPaths, WORKER_WORKSPACE_PATH, type HarnessPaths } from "./application/paths.js";
import type { HarnessConfig } from "./config/schema.js";
import type { MessageOutput } from "./domain.js";
import { buildWorkspaceEvidence, type WorkspaceEvidence } from "./domain/workspace.js";
import { HarnessFailure } from "./errors.js";
import { matchesGlob } from "./knowledge.js";

export class GitService {
  constructor(
    private readonly config: HarnessConfig,
    private readonly paths: HarnessPaths = resolveHarnessPaths(config),
  ) {}

  private get workspaceRoot(): string {
    return this.paths.workspaceRoot;
  }

  private get stateRoot(): string {
    return this.paths.stateRoot;
  }

  /**
   * True when `file` matches any configured artifact glob.
   * Directory patterns ending in `/` also match everything under that prefix;
   * patterns without `/` match the basename in any directory (gitignore-like).
   */
  matchesArtifactPattern(file: string, patterns: string[] = this.config.git.ignoredArtifactPatterns): boolean {
    return matchesArtifactPattern(file, patterns);
  }

  branchForRun(runId: string): string {
    const safe = runId.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
    return `${this.config.git.branchPrefix}/${safe}`;
  }

  async ensureRunBranch(runId: string): Promise<string | undefined> {
    if (!this.config.git.enabled) return undefined;
    const dirty = await this.changedFiles();
    if (dirty.length > 0) {
      throw new HarnessFailure(
        `Refusing to start on a dirty working tree. Commit or stash first: ${dirty.join(", ")}`,
        "workspace",
        true,
      );
    }
    const branch = this.branchForRun(runId);
    const current = (await this.git(["branch", "--show-current"])).stdout.trim();
    if (current === branch) return branch;
    const exists = (await this.git(["show-ref", "--verify", `refs/heads/${branch}`], true)).exitCode === 0;
    if (exists) {
      await this.git(["switch", branch]);
    } else {
      if (current !== this.config.git.baseBranch) {
        await this.git(["switch", this.config.git.baseBranch]);
      }
      await this.git(["switch", "-c", branch]);
    }
    return branch;
  }

  /** Fails soft: undefined on detached HEAD or when git is off, never throws. */
  async currentBranch(): Promise<string | undefined> {
    if (!this.config.git.enabled) return undefined;
    const result = await this.git(["branch", "--show-current"], true);
    if (result.exitCode !== 0) return undefined;
    const branch = result.stdout.trim();
    return branch === "" ? undefined : branch;
  }

  /** Local branch names (`refs/heads/`), sorted. Empty when git is disabled. */
  async listLocalBranches(): Promise<string[]> {
    if (!this.config.git.enabled) return [];
    const result = await this.git(
      ["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
      true,
    );
    if (result.exitCode !== 0) return [];
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  }

  async changedFiles(): Promise<string[]> {
    if (!this.config.git.enabled) return [];
    const { paths } = await this.porcelainStatus();
    return paths;
  }

  /**
   * Keep repository-intelligence indexes out of run-local Git evidence.
   *
   * A Docker workspace is created from a committed base, so an uncommitted
   * `.gitignore` rule in the control checkout cannot protect it. Install the
   * invariant in Git's repository-local exclude file instead.
   */
  async ensureRepositoryIntelligenceArtifactsIgnored(
    directories: string[] = [".gitnexus", ".codegraph"],
  ): Promise<void> {
    if (!this.config.git.enabled) return;

    const safeDirectories = directories.map((directory) =>
      normalize(directory).replace(/^\/+|\/+$/g, ""),
    );
    const tracked = await this.git(["ls-files", "--", ...safeDirectories]);
    if (tracked.stdout.trim()) {
      throw new HarnessFailure(
        "Repository intelligence indexes must be generated and Git-ignored, but tracked index files exist. " +
          `Remove tracked files under ${safeDirectories.join(", ")} before enabling repository intelligence.`,
        "workspace",
        true,
      );
    }

    if (await this.areRepositoryIntelligenceArtifactsIgnored(safeDirectories)) return;

    const excludeResult = await this.git(["rev-parse", "--git-path", "info/exclude"]);
    const rawExcludePath = excludeResult.stdout.trim();
    if (!rawExcludePath) {
      throw new HarnessFailure(
        "Git did not provide an info/exclude path for generated repository intelligence indexes.",
        "workspace",
        true,
      );
    }
    const excludePath = pathResolve(this.workspaceRoot, rawExcludePath);
    await mkdir(pathDirname(excludePath), { recursive: true });

    let existing = "";
    try {
      existing = await readFile(excludePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    await appendFile(
      excludePath,
      `${prefix}# agent-harness generated repository intelligence indexes\n${
        safeDirectories.map((directory) => `/${directory}/`).join("\n")
      }\n`,
      "utf8",
    );

    if (!(await this.areRepositoryIntelligenceArtifactsIgnored(safeDirectories))) {
      throw new HarnessFailure(
        "Repository intelligence indexes are not ignored by Git. Add .gitnexus/ and .codegraph/ to ignore rules before retrying.",
        "workspace",
        true,
      );
    }
  }

  /** @deprecated Retained until the operator-surface phase removes old calls. */
  ensureCodegraphOutputIgnored(): Promise<void> {
    return this.ensureRepositoryIntelligenceArtifactsIgnored();
  }

  private async areRepositoryIntelligenceArtifactsIgnored(
    directories: string[],
  ): Promise<boolean> {
    for (const directory of directories) {
      const result = await this.git(
        ["check-ignore", "--quiet", "--no-index", "--", `${directory}/.harness-probe`],
        true,
      );
      if (result.exitCode !== 0) return false;
    }
    return true;
  }

  /**
   * Paths that differ between `baseRef` and the workspace (committed + dirty + untracked).
   * Used for task review over `workspace.baseSha..HEAD`.
   */
  async changedFilesVersusRef(baseRef: string): Promise<string[]> {
    if (!this.config.git.enabled) return [];
    const named = await this.git(["diff", "--name-only", baseRef], true);
    const fromDiff = named.stdout
      .split(/\r?\n/)
      .map((line) => normalize(line.trim()))
      .filter(Boolean);
    const dirty = await this.changedFiles();
    return [...new Set([...fromDiff, ...dirty])];
  }

  /**
   * Unified diff for specific paths, budgeted per whole file (never mid-hunk).
   * Intent-to-add newly created files so they appear vs the base ref (default HEAD).
   */
  async diffForPaths(
    paths: string[],
    maxCharacters: number,
    options: { baseRef?: string } = {},
  ): Promise<{ diff: string; omittedFiles: string[]; truncated: boolean }> {
    if (!this.config.git.enabled || paths.length === 0) {
      return { diff: "", omittedFiles: [], truncated: false };
    }
    const baseRef = options.baseRef ?? "HEAD";
    const existing: string[] = [];
    for (const filePath of paths) {
      try {
        await access(pathResolve(this.workspaceRoot, filePath));
        existing.push(normalize(filePath));
      } catch {
        // Skip paths that no longer exist.
      }
    }
    if (existing.length === 0) {
      return { diff: "", omittedFiles: [], truncated: false };
    }
    await this.git(["add", "--intent-to-add", "--", ...existing], true);
    const result = await this.git(["diff", "--no-color", baseRef, "--", ...existing], true);
    const sections = splitDiffSections(result.stdout);
    const kept: string[] = [];
    const omittedFiles: string[] = [];
    let used = 0;
    let truncated = false;
    for (const section of sections) {
      if (isBinaryDiffSection(section)) {
        omittedFiles.push(pathFromDiffSection(section));
        continue;
      }
      if (truncated) {
        omittedFiles.push(pathFromDiffSection(section));
        continue;
      }
      const candidateLength = kept.length === 0 ? section.length : used + 1 + section.length;
      if (candidateLength > maxCharacters) {
        // Never mid-hunk: omit this file and every remaining text section.
        omittedFiles.push(pathFromDiffSection(section));
        truncated = true;
        continue;
      }
      kept.push(section);
      used = candidateLength;
    }
    return {
      diff: kept.join("\n"),
      omittedFiles: [...new Set(omittedFiles.filter(Boolean))],
      truncated,
    };
  }

  /**
   * Structured run-local workspace evidence (HEAD, index identity, porcelain digest).
   * Fingerprint calculation does not write trees; index identity hashes `git ls-files -s`.
   */
  async workspaceEvidence(): Promise<WorkspaceEvidence> {
    if (!this.config.git.enabled) {
      return buildWorkspaceEvidence({
        headSha: "git-disabled",
        indexTreeSha: "git-disabled",
        statusDigest: "git-disabled",
        changedPaths: [],
      });
    }
    const headSha = (await this.git(["rev-parse", "HEAD"])).stdout.trim();
    const indexTreeSha = await this.indexIdentity();
    const { paths, filteredPorcelain } = await this.porcelainStatus();
    const statusDigest = createHash("sha256").update(filteredPorcelain).digest("hex");
    return buildWorkspaceEvidence({
      headSha,
      indexTreeSha,
      statusDigest,
      changedPaths: paths,
    });
  }

  /**
   * Versioned evidence fingerprint for new stamps.
   * Prefer `workspaceEvidence()` when component diagnostics are needed.
   */
  async treeFingerprint(): Promise<string> {
    return (await this.workspaceEvidence()).fingerprint;
  }

  /** Non-mutating index identity: hash of staged blob/mode/path entries. */
  private async indexIdentity(): Promise<string> {
    const result = await this.git(["ls-files", "-s", "-z"], true);
    const payload = result.exitCode === 0 ? result.stdout : "";
    return createHash("sha256").update(payload).digest("hex");
  }

  /**
   * Porcelain after state-dir / artifact filters, with Windows/autocrlf phantoms healed.
   * Phantoms = tracked in-place mods that are dirty in status but empty vs HEAD.
   */
  private async porcelainStatus(): Promise<{ paths: string[]; filteredPorcelain: string }> {
    let snapshot = await this.readFilteredPorcelain();
    const phantoms = await this.findPhantomDirtyPaths(snapshot.entries);
    if (phantoms.length > 0) {
      await this.git(
        ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...phantoms],
        true,
      );
      snapshot = await this.readFilteredPorcelain();
    }
    return {
      paths: snapshot.paths,
      filteredPorcelain: snapshot.filteredPorcelain,
    };
  }

  private async readFilteredPorcelain(): Promise<{
    paths: string[];
    filteredPorcelain: string;
    entries: PorcelainEntry[];
  }> {
    const result = await this.git(["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
    const statePrefix = normalize(pathRelative(this.workspaceRoot, this.stateRoot));
    const artifactPatterns = this.config.git.ignoredArtifactPatterns;
    const records = result.stdout.split("\0").filter(Boolean);
    const paths: string[] = [];
    const kept: string[] = [];
    const entries: PorcelainEntry[] = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      const status = record.slice(0, 2);
      const filePath = normalize(record.slice(3));
      let second: string | undefined;
      if (/R|C/.test(status) && records[index + 1]) {
        second = records[index + 1]!;
        index += 1;
      }
      const renamePath = second ? normalize(second) : undefined;
      const underState = (file: string) => file === statePrefix || file.startsWith(`${statePrefix}/`);
      if (underState(filePath) || (renamePath != null && underState(renamePath))) {
        continue;
      }
      const isArtifact =
        matchesArtifactPattern(filePath, artifactPatterns) ||
        (renamePath != null && matchesArtifactPattern(renamePath, artifactPatterns));
      if (isArtifact) {
        continue;
      }
      kept.push(record);
      if (second) kept.push(second);
      paths.push(filePath);
      if (renamePath) paths.push(renamePath);
      entries.push({ status, path: filePath, renamePath });
    }
    const filteredPorcelain = kept.length > 0 ? `${kept.join("\0")}\0` : "";
    return {
      paths: [...new Set(paths)].sort(),
      filteredPorcelain,
      entries,
    };
  }

  /**
   * Paths that look dirty in porcelain but have no content/mode change vs HEAD
   * (common with core.autocrlf / stale stat cache on Windows).
   */
  private async findPhantomDirtyPaths(entries: PorcelainEntry[]): Promise<string[]> {
    const phantoms: string[] = [];
    for (const entry of entries) {
      if (entry.renamePath != null || /[RC]/.test(entry.status)) continue;
      if (/D/.test(entry.status)) continue;
      if (entry.status === "??" || entry.status === "!!") continue;

      const tracked = await this.git(["ls-files", "--error-unmatch", "--", entry.path], true);
      if (tracked.exitCode !== 0) continue;

      const diff = await this.git(["diff", "HEAD", "--quiet", "--", entry.path], true);
      if (diff.exitCode === 0) {
        phantoms.push(entry.path);
      }
    }
    return phantoms;
  }

  /** Cuts/switches to the run branch from current HEAD, skipping the baseBranch hop and dirty-tree guard. */
  async createRunBranchFromHead(runId: string): Promise<string> {
    if (!this.config.git.enabled) throw new Error("git is not enabled");
    const branch = this.branchForRun(runId);
    const ensured = await this.ensureDeliveryBranch(branch);
    return ensured.branchName;
  }

  /**
   * Create or attach a named delivery branch at the current HEAD.
   * Never resets an existing branch that points elsewhere — naming conflicts fail hard.
   */
  async ensureDeliveryBranch(branchName: string): Promise<{
    branchName: string;
    headSha: string;
    created: boolean;
  }> {
    if (!this.config.git.enabled) throw new Error("git is not enabled");
    const headSha = (await this.git(["rev-parse", "HEAD"])).stdout.trim();
    const current = (await this.git(["branch", "--show-current"])).stdout.trim();
    if (current === branchName) {
      return { branchName, headSha, created: false };
    }
    const exists =
      (await this.git(["show-ref", "--verify", `refs/heads/${branchName}`], true)).exitCode === 0;
    if (exists) {
      const tip = (await this.git(["rev-parse", branchName])).stdout.trim();
      if (tip !== headSha) {
        throw new HarnessFailure(
          `Delivery branch ${branchName} already exists at ${tip.slice(0, 8)} but this run's HEAD is ${headSha.slice(0, 8)}. ` +
            "Choose a different branch name or delete the conflicting local branch; the harness will not reset it.",
          "workspace",
          true,
        );
      }
      await this.git(["switch", branchName]);
      return { branchName, headSha, created: false };
    }
    await this.git(["switch", "-c", branchName]);
    return { branchName, headSha, created: true };
  }

  /** Stages and commits everything except the harness state directory. */
  async commitWorkingTree(message: string): Promise<{ sha: string; files: string[] }> {
    if (!this.config.git.enabled) throw new Error("git is not enabled");
    const files = await this.changedFiles();
    if (files.length === 0) throw new Error("No changes to commit");
    await this.stagePaths(files);
    await this.git(["commit", "-m", sanitizeSubject(message)]);
    const sha = (await this.git(["rev-parse", "HEAD"])).stdout.trim();
    return { sha, files };
  }

  async isTaskCommitted(taskId: string): Promise<boolean> {
    if (!this.config.git.enabled) return false;
    const result = await this.git(["log", "-30", "--format=%B%x00"], true);
    return result.exitCode === 0 && result.stdout.includes(`Harness-Task: ${taskId}`);
  }

  async commitTask(
    taskId: string,
    message: MessageOutput,
    reportedPaths: string[],
  ): Promise<string | undefined> {
    if (!this.config.git.enabled) return undefined;
    if (await this.isTaskCommitted(taskId)) {
      return (await this.git(["rev-parse", "HEAD"])).stdout.trim();
    }
    const changed = (await this.changedFiles()).filter(
      (file) => !matchesArtifactPattern(file, this.config.git.ignoredArtifactPatterns),
    );
    if (changed.length === 0) {
      throw new HarnessFailure(`Task ${taskId} produced no git changes`, "workspace", true);
    }
    const allowed = new Set(reportedPaths.map(normalize));
    const unreported = changed.filter((file) => !allowed.has(file));
    if (unreported.length > 0) {
      throw new HarnessFailure(
        `Task ${taskId} changed unreported paths: ${unreported.join(", ")}`,
        "workspace",
        true,
      );
    }
    await this.stagePaths(changed);
    const subject = sanitizeSubject(message.subject);
    const trailers = [`Harness-Task: ${taskId}`];
    const body = [message.body.trim(), ...trailers].filter(Boolean).join("\n\n");
    await this.git(["commit", "-m", subject, "-m", body]);
    return (await this.git(["rev-parse", "HEAD"])).stdout.trim();
  }

  /**
   * Stage an explicit path list from porcelain.
   * `-f` is required for tracked files that live under a gitignored directory
   * (e.g. `/.cursor/`): plain `git add -- path` fails with "paths are ignored".
   * Safe here because callers only pass paths already visible in porcelain
   * (tracked edits / non-ignored untracked), never silent ignored untracked files.
   */
  private async stagePaths(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.git(["add", "-f", "--", ...paths]);
  }

  async publish(branch: string, message: MessageOutput): Promise<string | undefined> {
    if (!this.config.git.enabled || !this.config.git.push) return undefined;
    await this.git(["push", "--set-upstream", this.config.git.remote, branch]);
    if (!this.config.git.openPullRequest) return undefined;
    const result = await runProgram(
      "gh",
      [
        "pr",
        "create",
        "--base",
        this.config.git.baseBranch,
        "--head",
        branch,
        "--title",
        sanitizeSubject(message.subject),
        "--body",
        message.body,
      ],
      this.workspaceRoot,
      false,
    );
    return result.stdout.trim().split(/\r?\n/).at(-1);
  }

  private async git(args: string[], allowFailure = false): Promise<ProgramResult> {
    try {
      return await runProgram("git", args, this.workspaceRoot, allowFailure);
    } catch (error) {
      if (error instanceof Error && /not a git repository/i.test(error.message)) {
        throw new HarnessFailure(
          `git.enabled is true but ${this.workspaceRoot} is not a git repository. ` +
            "Run `git init` and make an initial commit, or set git.enabled: false in agent-harness.config.yaml.",
          "workspace",
          true,
          { cause: error },
        );
      }
      throw error;
    }
  }
}

type PorcelainEntry = {
  status: string;
  path: string;
  renamePath?: string;
};

type ProgramResult = { exitCode: number; stdout: string; stderr: string };

function runProgram(
  executable: string,
  args: string[],
  cwd: string,
  allowFailure: boolean,
): Promise<ProgramResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
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
    child.once("error", (error) => {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT" &&
        cwd === WORKER_WORKSPACE_PATH
      ) {
        reject(
          new Error(
            `git ${args[0] ?? ""} failed to start: host control plane cannot use cwd ${WORKER_WORKSPACE_PATH}. ` +
              "Docker runs must perform git/repository setup inside the worker container.",
          ),
        );
        return;
      }
      reject(error);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10 * 60 * 1000);
    child.once("close", (code) => {
      clearTimeout(timer);
      const result = { exitCode: code ?? 1, stdout, stderr };
      if (result.exitCode !== 0 && !allowFailure) {
        reject(new Error(`${executable} ${args[0] ?? ""} failed (${result.exitCode}): ${stderr || stdout}`));
        return;
      }
      resolve(result);
    });
  });
}

function sanitizeSubject(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, 100) || "chore: complete harness task";
}

function normalize(value: string): string {
  return value.replaceAll("\\", "/");
}

/**
 * True when `file` matches any artifact glob.
 * - Patterns ending in `/` match that directory and everything under it.
 * - Patterns with no `/` match the basename in any directory (gitignore-like).
 */
export function matchesArtifactPattern(file: string, patterns: string[]): boolean {
  const normalized = normalize(file);
  return patterns.some((raw) => {
    let pattern = raw.trim();
    if (!pattern) return false;
    if (pattern.endsWith("/")) {
      pattern = `${pattern}**`;
    }
    if (matchesGlob(pattern, normalized)) return true;
    if (!pattern.includes("/")) {
      return matchesGlob(`**/${pattern}`, normalized);
    }
    return false;
  });
}

/**
 * Convert a dirty path into a folder-oriented ignore glob for project settings.
 * Files become star-star/parent/star-star; directories become star-star/dir/star-star.
 */
export function pathToIgnoredArtifactGlob(filePath: string): string {
  const normalized = normalize(filePath).replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalized) return "**/*";
  const parts = normalized.split("/");
  const last = parts[parts.length - 1]!;
  const looksLikeFile = /\.[A-Za-z0-9]+$/.test(last);
  const folder = looksLikeFile ? parts.slice(0, -1).join("/") : normalized;
  if (!folder) return normalized.includes("/") ? normalized : `**/${normalized}`;
  return `**/${folder}/**`;
}

function splitDiffSections(diff: string): string[] {
  if (!diff.trim()) return [];
  const normalized = diff.replace(/\r\n/g, "\n").replace(/\s+$/, "");
  return normalized.split(/(?=^diff --git )/m).filter((section) => section.startsWith("diff --git "));
}

function isBinaryDiffSection(section: string): boolean {
  return /^Binary files /m.test(section) || /GIT binary patch/m.test(section);
}

function pathFromDiffSection(section: string): string {
  const match = /^diff --git a\/(.+?) b\/(.+)$/m.exec(section);
  if (!match) return "";
  return normalize(match[2] ?? match[1] ?? "");
}
