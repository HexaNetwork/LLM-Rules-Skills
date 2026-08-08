import { spawn } from "node:child_process";
import { relative as pathRelative, resolve as pathResolve } from "node:path";
import type { HarnessConfig } from "./config.js";
import type { MessageOutput } from "./domain.js";
import { HarnessFailure } from "./errors.js";

export class GitService {
  constructor(private readonly config: HarnessConfig) {}

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

  async changedFiles(): Promise<string[]> {
    if (!this.config.git.enabled) return [];
    const result = await this.git(["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
    const statePrefix = normalize(
      pathRelative(this.config.repositoryRoot, pathResolve(this.config.repositoryRoot, this.config.stateDirectory)),
    );
    const records = result.stdout.split("\0").filter(Boolean);
    const paths: string[] = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      const status = record.slice(0, 2);
      paths.push(normalize(record.slice(3)));
      if (/R|C/.test(status) && records[index + 1]) {
        paths.push(normalize(records[index + 1]!));
        index += 1;
      }
    }
    return [...new Set(paths)]
      .filter((file) => file !== statePrefix && !file.startsWith(`${statePrefix}/`))
      .sort();
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
    const changed = await this.changedFiles();
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

  private git(args: string[], allowFailure = false): Promise<ProgramResult> {
    return runProgram("git", args, this.config.repositoryRoot, allowFailure);
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
