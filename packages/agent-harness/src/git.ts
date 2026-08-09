import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { relative as pathRelative, resolve as pathResolve } from "node:path";
import type { HarnessConfig } from "./config.js";
import type { MessageOutput } from "./domain.js";
import { HarnessFailure } from "./errors.js";
import { matchesGlob } from "./knowledge.js";

export class GitService {
  constructor(private readonly config: HarnessConfig) {}

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
   * Unified diff for specific paths, budgeted per whole file (never mid-hunk).
   * Intent-to-add newly created files so they appear vs HEAD.
   */
  async diffForPaths(
    paths: string[],
    maxCharacters: number,
  ): Promise<{ diff: string; omittedFiles: string[]; truncated: boolean }> {
    if (!this.config.git.enabled || paths.length === 0) {
      return { diff: "", omittedFiles: [], truncated: false };
    }
    const existing: string[] = [];
    for (const filePath of paths) {
      try {
        await access(pathResolve(this.config.repositoryRoot, filePath));
        existing.push(normalize(filePath));
      } catch {
        // Skip paths that no longer exist.
      }
    }
    if (existing.length === 0) {
      return { diff: "", omittedFiles: [], truncated: false };
    }
    await this.git(["add", "--intent-to-add", "--", ...existing], true);
    const result = await this.git(["diff", "--no-color", "HEAD", "--", ...existing], true);
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
   * Cheap identity of HEAD + working tree (state-directory paths excluded).
   * Returns `"git-disabled"` when git is off.
   */
  async treeFingerprint(): Promise<string> {
    if (!this.config.git.enabled) return "git-disabled";
    const head = (await this.git(["rev-parse", "HEAD"])).stdout.trim();
    const { filteredPorcelain } = await this.porcelainStatus();
    return createHash("sha256").update(`${head}\0${filteredPorcelain}`).digest("hex");
  }

  private async porcelainStatus(): Promise<{ paths: string[]; filteredPorcelain: string }> {
    const result = await this.git(["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
    const statePrefix = normalize(
      pathRelative(this.config.repositoryRoot, pathResolve(this.config.repositoryRoot, this.config.stateDirectory)),
    );
    const artifactPatterns = this.config.git.ignoredArtifactPatterns;
    const records = result.stdout.split("\0").filter(Boolean);
    const paths: string[] = [];
    const kept: string[] = [];
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
    }
    const filteredPorcelain = kept.length > 0 ? `${kept.join("\0")}\0` : "";
    return {
      paths: [...new Set(paths)].sort(),
      filteredPorcelain,
    };
  }

  /** Cuts/switches to the run branch from current HEAD, skipping the baseBranch hop and dirty-tree guard. */
  async createRunBranchFromHead(runId: string): Promise<string> {
    if (!this.config.git.enabled) throw new Error("git is not enabled");
    const branch = this.branchForRun(runId);
    const current = (await this.git(["branch", "--show-current"])).stdout.trim();
    if (current === branch) return branch;
    const exists = (await this.git(["show-ref", "--verify", `refs/heads/${branch}`], true)).exitCode === 0;
    if (exists) {
      await this.git(["switch", branch]);
    } else {
      await this.git(["switch", "-c", branch]);
    }
    return branch;
  }

  /** Stages and commits everything except the harness state directory. */
  async commitWorkingTree(message: string): Promise<{ sha: string; files: string[] }> {
    if (!this.config.git.enabled) throw new Error("git is not enabled");
    const files = await this.changedFiles();
    if (files.length === 0) throw new Error("No changes to commit");
    await this.git(["add", "--all", "--", ...files]);
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
    await this.git(["add", "--all", "--", ...changed]);
    const subject = sanitizeSubject(message.subject);
    const body = [message.body.trim(), `Harness-Task: ${taskId}`].filter(Boolean).join("\n\n");
    await this.git(["commit", "-m", subject, "-m", body]);
    return (await this.git(["rev-parse", "HEAD"])).stdout.trim();
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
      this.config.repositoryRoot,
      false,
    );
    return result.stdout.trim().split(/\r?\n/).at(-1);
  }

  private async git(args: string[], allowFailure = false): Promise<ProgramResult> {
    try {
      return await runProgram("git", args, this.config.repositoryRoot, allowFailure);
    } catch (error) {
      if (error instanceof Error && /not a git repository/i.test(error.message)) {
        throw new HarnessFailure(
          `git.enabled is true but ${this.config.repositoryRoot} is not a git repository. ` +
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
    child.once("error", reject);
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
