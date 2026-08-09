import path from "node:path";
import { appendFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hostname as localHostname } from "node:os";
import {
  RunEventSchema,
  RunStateSchema,
  type RunEvent,
  type RunState,
} from "./domain.js";
import type { HarnessConfig } from "./config.js";

const LOCK_STALE_MS = 30 * 60 * 1000;

export type RunLoadFailure = { runId: string; error: string };

type LockBody = {
  pid: number;
  hostname: string;
  at: string;
  runId?: string;
  action?: string;
};

export class RunStore {
  readonly root: string;

  constructor(readonly config: HarnessConfig) {
    this.root = path.resolve(config.repositoryRoot, config.stateDirectory);
  }

  runDirectory(runId: string): string {
    return path.join(this.root, "runs", safeSegment(runId));
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(path.join(this.root, "runs"), { recursive: true }),
      mkdir(path.join(this.root, "knowledge"), { recursive: true }),
    ]);
  }

  async create(state: RunState): Promise<void> {
    const directory = this.runDirectory(state.runId);
    await mkdir(directory, { recursive: false });
    await Promise.all([
      mkdir(path.join(directory, "sessions")),
      mkdir(path.join(directory, "packets")),
      mkdir(path.join(directory, "issues")),
      mkdir(path.join(directory, "tasks")),
    ]);
    await this.writeState(state);
    await this.writeText(state.runId, "idea.md", `# Idea\n\n${state.idea}\n`);
  }

  async load(runId: string): Promise<RunState> {
    const raw = await readStable(path.join(this.runDirectory(runId), "state.json"));
    return RunStateSchema.parse(JSON.parse(raw));
  }

  async list(): Promise<RunState[]> {
    return (await this.listWithFailures()).states;
  }

  /**
   * Runs that cannot be loaded are reported rather than dropped: a run whose
   * state.json is unreadable or schema-invalid would otherwise vanish from the
   * dashboard with no diagnostic, which reads as data loss.
   */
  async listWithFailures(): Promise<{ states: RunState[]; failures: RunLoadFailure[] }> {
    await this.initialize();
    const directory = path.join(this.root, "runs");
    const entries = await readdir(directory, { withFileTypes: true });
    const loaded = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            return { state: await this.load(entry.name) };
          } catch (error) {
            return {
              failure: {
                runId: entry.name,
                error: error instanceof Error ? error.message : String(error),
              },
            };
          }
        }),
    );
    const states = loaded
      .map((entry) => entry.state)
      .filter((state): state is RunState => state != null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const failures = loaded
      .map((entry) => entry.failure)
      .filter((failure): failure is RunLoadFailure => failure != null)
      .sort((a, b) => a.runId.localeCompare(b.runId));
    return { states, failures };
  }

  async writeState(state: RunState): Promise<RunState> {
    const next = RunStateSchema.parse({
      ...state,
      revision: state.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    await atomicJson(path.join(this.runDirectory(state.runId), "state.json"), next);
    return next;
  }

  async record(
    state: RunState,
    type: string,
    detail: Record<string, unknown> = {},
  ): Promise<RunState> {
    const event: RunEvent = RunEventSchema.parse({
      sequence: state.lastEventSequence + 1,
      type,
      detail,
      at: new Date().toISOString(),
    });
    const next = await this.writeState({ ...state, lastEventSequence: event.sequence });
    await appendFile(
      path.join(this.runDirectory(state.runId), "events.jsonl"),
      `${JSON.stringify(event)}\n`,
      "utf8",
    );
    return next;
  }

  async writeJson(runId: string, relativePath: string, value: unknown): Promise<string> {
    const target = this.resolveInsideRun(runId, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await atomicJson(target, value);
    return target;
  }

  /** Plain append (not atomic rewrite) for high-churn JSONL such as live agent steps. */
  async appendJsonl(runId: string, relativePath: string, value: unknown): Promise<string> {
    const target = this.resolveInsideRun(runId, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await appendFile(target, `${JSON.stringify(value)}\n`, "utf8");
    return target;
  }

  async remove(runId: string, relativePath: string): Promise<void> {
    const target = this.resolveInsideRun(runId, relativePath);
    try {
      await unlink(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async writeText(runId: string, relativePath: string, value: string): Promise<string> {
    const target = this.resolveInsideRun(runId, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, value, "utf8");
    await replaceFile(temporary, target);
    return target;
  }

  async readText(runId: string, relativePath: string): Promise<string> {
    return readStable(this.resolveInsideRun(runId, relativePath));
  }

  async readJson(runId: string, relativePath: string): Promise<unknown> {
    return JSON.parse(await this.readText(runId, relativePath));
  }

  async listFiles(runId: string, relativeDirectory: string): Promise<string[]> {
    const directory = this.resolveInsideRun(runId, relativeDirectory);
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => `${relativeDirectory.replaceAll("\\", "/").replace(/\/$/, "")}/${entry.name}`)
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  runLockPath(runId: string): string {
    return path.join(this.runDirectory(runId), "run.lock");
  }

  repositoryLockPath(): string {
    return path.join(this.root, "repo.lock");
  }

  async withLock<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const lockPath = this.runLockPath(runId);
    const handle = await acquireLockFile(lockPath, () => {
      throw new Error(`Run ${runId} is already active; refusing to wait on its lock.`);
    });
    await handle.writeFile(
      JSON.stringify({
        pid: process.pid,
        hostname: localHostname(),
        at: new Date().toISOString(),
      } satisfies LockBody),
    );
    try {
      return await work();
    } finally {
      await handle.close();
      await unlink(lockPath).catch(() => undefined);
    }
  }

  /**
   * Like withLock, but polls until `waitMs` elapses instead of failing immediately.
   * Used by out-of-band cancel so a short wait can complete the transition when the
   * advancing process is about to release the lock.
   */
  async tryWithLock<T>(
    runId: string,
    waitMs: number,
    work: () => Promise<T>,
    options: { pollMs?: number } = {},
  ): Promise<{ acquired: true; value: T } | { acquired: false }> {
    const pollMs = options.pollMs ?? 50;
    const deadline = Date.now() + Math.max(0, waitMs);
    for (;;) {
      try {
        const value = await this.withLock(runId, work);
        return { acquired: true, value };
      } catch (error) {
        if (!(error instanceof Error) || !/already active/i.test(error.message)) {
          throw error;
        }
        if (Date.now() >= deadline) return { acquired: false };
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    }
  }

  /**
   * Serialises git / working-tree work across runs. Callers that also take a
   * per-run lock must acquire this first (repository → run) to avoid deadlock.
   */
  async withRepositoryLock<T>(
    holder: { runId: string; action: string },
    work: () => Promise<T>,
  ): Promise<T> {
    const lockPath = this.repositoryLockPath();
    const handle = await acquireLockFile(lockPath, (body) => {
      const runId = body?.runId ?? "unknown";
      const action = body?.action ?? "unknown";
      const at = body?.at ?? "unknown time";
      throw new Error(
        `The repository is in use by run ${runId} (${action}) since ${at}. Wait, or run agent-harness unlock --repo if that process is gone.`,
      );
    });
    await handle.writeFile(
      JSON.stringify({
        pid: process.pid,
        hostname: localHostname(),
        at: new Date().toISOString(),
        runId: holder.runId,
        action: holder.action,
      } satisfies LockBody),
    );
    try {
      return await work();
    } finally {
      await handle.close();
      await unlink(lockPath).catch(() => undefined);
    }
  }

  async inspectRunLock(
    runId: string,
  ): Promise<{ path: string; body: LockBody | null; ageMs: number | null } | null> {
    return readLockInfo(this.runLockPath(runId));
  }

  async inspectRepositoryLock(): Promise<{
    path: string;
    body: LockBody | null;
    ageMs: number | null;
  } | null> {
    return readLockInfo(this.repositoryLockPath());
  }

  /** Operator escape hatch: remove a run lock (and optionally the repository lock). */
  async unlock(runId: string, options: { repo?: boolean } = {}): Promise<{
    run: boolean;
    repo: boolean | "absent";
  }> {
    const runPath = this.runLockPath(runId);
    let run = false;
    try {
      await unlink(runPath);
      run = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    let repo: boolean | "absent" = false;
    if (options.repo) {
      const repoPath = this.repositoryLockPath();
      try {
        await unlink(repoPath);
        repo = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        repo = "absent";
      }
    }

    return { run, repo };
  }

  private resolveInsideRun(runId: string, relativePath: string): string {
    const base = this.runDirectory(runId);
    const target = path.resolve(base, relativePath);
    const relative = path.relative(base, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Artifact path escapes run directory: ${relativePath}`);
    }
    return target;
  }
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`Invalid identifier: ${value}`);
  }
  return value;
}

async function atomicJson(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await replaceFile(temporary, target);
}

const SHARING_VIOLATION_CODES = ["EACCES", "EBUSY", "EPERM"];
const FS_RETRY_ATTEMPTS = 12;

/**
 * Windows has no atomic replace that tolerates an open reader: a rename fails
 * with EPERM while someone reads the target, and a read fails the same way
 * while the rename lands. Both sides retry, and the backoff is jittered — a
 * fixed schedule lets a busy reader and a busy writer stay in lockstep and
 * starve each other until one exhausts its budget.
 */
async function retryOnSharingViolation<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!SHARING_VIOLATION_CODES.includes(code ?? "") || attempt >= FS_RETRY_ATTEMPTS) {
        throw error;
      }
      const backoff = Math.min(5 * 2 ** attempt, 200);
      await new Promise((resolve) => setTimeout(resolve, backoff * (0.5 + Math.random())));
    }
  }
}

/**
 * Reader-side mirror of replaceFile's retry. ENOENT is not retried: callers
 * depend on it to mean the artifact genuinely does not exist.
 */
async function readStable(target: string): Promise<string> {
  return retryOnSharingViolation(() => readFile(target, "utf8"));
}

async function replaceFile(source: string, target: string): Promise<void> {
  await retryOnSharingViolation(() => rename(source, target));
}

async function acquireLockFile(
  lockPath: string,
  onAlive: (body: LockBody | null) => never,
): Promise<Awaited<ReturnType<typeof open>>> {
  try {
    return await open(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!(await shouldBreakLock(lockPath))) {
      const info = await readLockInfo(lockPath);
      onAlive(info?.body ?? null);
    }
    await unlink(lockPath);
    return open(lockPath, "wx");
  }
}

async function shouldBreakLock(lockPath: string): Promise<boolean> {
  try {
    const raw = await readFile(lockPath, "utf8");
    const body = parseLockBody(raw);
    if (body && body.hostname === localHostname()) {
      const liveness = probePid(body.pid);
      if (liveness === "dead") return true;
      if (liveness === "alive") return false;
      // probe failure → degrade to age rule
    }
  } catch {
    // Unreadable / probe failure → degrade to age rule.
  }
  const age = Date.now() - (await stat(lockPath)).mtimeMs;
  return age >= LOCK_STALE_MS;
}

function parseLockBody(raw: string): LockBody | null {
  try {
    const value = JSON.parse(raw) as Partial<LockBody>;
    if (
      typeof value.pid !== "number" ||
      !Number.isFinite(value.pid) ||
      typeof value.hostname !== "string" ||
      typeof value.at !== "string"
    ) {
      return null;
    }
    return {
      pid: value.pid,
      hostname: value.hostname,
      at: value.at,
      ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
      ...(typeof value.action === "string" ? { action: value.action } : {}),
    };
  } catch {
    return null;
  }
}

/** process.kill(pid, 0) — ESRCH dead, EPERM alive, no throw alive. */
function probePid(pid: number): "alive" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}

async function readLockInfo(
  lockPath: string,
): Promise<{ path: string; body: LockBody | null; ageMs: number | null } | null> {
  try {
    const info = await stat(lockPath);
    const raw = await readFile(lockPath, "utf8").catch(() => "");
    return {
      path: lockPath,
      body: parseLockBody(raw),
      ageMs: Date.now() - info.mtimeMs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
