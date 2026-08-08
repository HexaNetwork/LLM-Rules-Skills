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
    const raw = await readFile(path.join(this.runDirectory(runId), "state.json"), "utf8");
    return RunStateSchema.parse(JSON.parse(raw));
  }

  async list(): Promise<RunState[]> {
    await this.initialize();
    const directory = path.join(this.root, "runs");
    const entries = await readdir(directory, { withFileTypes: true });
    const states = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.load(entry.name).catch(() => undefined)),
    );
    return states
      .filter((state): state is RunState => state != null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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

  async writeText(runId: string, relativePath: string, value: string): Promise<string> {
    const target = this.resolveInsideRun(runId, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, value, "utf8");
    await replaceFile(temporary, target);
    return target;
  }

  async readText(runId: string, relativePath: string): Promise<string> {
    return readFile(this.resolveInsideRun(runId, relativePath), "utf8");
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

async function replaceFile(source: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!(["EACCES", "EBUSY", "EPERM"].includes(code ?? "")) || attempt >= 7) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 5 * 2 ** attempt));
    }
  }
}

async function acquireLockFile(
  lockPath: string,
  onAlive: () => never,
): Promise<Awaited<ReturnType<typeof open>>> {
  try {
    return await open(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!(await shouldBreakLock(lockPath))) onAlive();
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
