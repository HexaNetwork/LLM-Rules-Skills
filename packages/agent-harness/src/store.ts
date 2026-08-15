import path from "node:path";
import { appendFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hostname as localHostname } from "node:os";
import {
  RunEventSchema,
  RunStateSchema,
  type RunEvent,
  type RunState,
  type TransitionResult,
} from "./domain.js";
import type { HarnessConfig } from "./config/schema.js";

export type RunLoadFailure = { runId: string; error: string };

type LockBody = {
  pid: number;
  hostname: string;
  at: string;
  runId?: string;
  action?: string;
};

type TransitionJournal = {
  expectedRevision: number;
  state: RunState;
  event: RunEvent;
  owner?: Pick<LockBody, "pid" | "hostname">;
  /** When set, recovery also restores this frozen config snapshot. */
  config?: unknown;
};

/** Test-only fault injection points for config+state transitions. */
export type ConfigTransitionFault =
  | "after_journal"
  | "after_config"
  | "after_state"
  | "after_event";

export type RunStoreOptions = {
  /**
   * Optional single-run binding for focused host-side tools and tests.
   */
  singleRunId?: string;
};

export class RunStore {
  readonly root: string;
  readonly singleRunId: string | undefined;
  /** @internal Test seam: throw after the named config-transition boundary. */
  configTransitionFault?: ConfigTransitionFault;

  constructor(readonly config: HarnessConfig, stateRoot: string, options: RunStoreOptions = {}) {
    this.root = stateRoot;
    this.singleRunId = options.singleRunId;
  }

  runDirectory(runId: string): string {
    if (this.singleRunId !== undefined) {
      if (runId !== this.singleRunId) {
        throw new Error(
          `Worker RunStore is bound to run ${this.singleRunId}; refusing access to ${runId}`,
        );
      }
      return this.root;
    }
    return path.join(this.root, "runs", safeSegment(runId));
  }

  async initialize(): Promise<void> {
    if (this.singleRunId) {
      await mkdir(this.root, { recursive: true });
      return;
    }
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
    await this.recoverPendingTransition(runId);
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
    options: { config?: unknown } = {},
  ): Promise<RunState> {
    // If a previous transition failed after writing its journal, finish it
    // before creating a later sequence number.
    await this.recoverPendingTransition(state.runId, { force: true });
    const event: RunEvent = RunEventSchema.parse({
      sequence: state.lastEventSequence + 1,
      type,
      detail,
      at: new Date().toISOString(),
    });
    const next = RunStateSchema.parse({
      ...state,
      lastEventSequence: event.sequence,
      revision: state.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    const journal: TransitionJournal = {
      expectedRevision: state.revision,
      state: next,
      event,
      // Fault-injection omits owner so same-process recovery matches a dead writer.
      ...(this.configTransitionFault
        ? {}
        : { owner: { pid: process.pid, hostname: localHostname() } }),
      ...(options.config !== undefined ? { config: options.config } : {}),
    };
    // State and history are a recoverable transaction: after a process crash,
    // load() can finish whichever durable write did not complete. When config
    // is included, recovery also restores the matching frozen snapshot.
    await atomicJson(this.transitionJournalPath(state.runId), journal);
    await this.maybeFault("after_journal");
    if (options.config !== undefined) {
      await atomicJson(path.join(this.runDirectory(state.runId), "config.json"), options.config);
      await this.maybeFault("after_config");
    }
    await atomicJson(path.join(this.runDirectory(state.runId), "state.json"), next);
    await this.maybeFault("after_state");
    await this.appendEventOnce(state.runId, event);
    await this.maybeFault("after_event");
    await unlink(this.transitionJournalPath(state.runId));
    return next;
  }

  /**
   * Persistence boundary for pure domain transitions.
   * Order: artifacts → atomic state checkpoint → append JSONL events.
   * A valid state checkpoint remains authoritative after interruption.
   */
  async persistTransition(
    runId: string,
    result: TransitionResult,
    artifacts: Array<{ relativePath: string; contents: string }> = [],
  ): Promise<RunState> {
    if (result.state.runId !== runId) {
      throw new Error(
        `Transition runId mismatch: expected ${runId}, got ${result.state.runId}`,
      );
    }
    await this.recoverPendingTransition(runId, { force: true });

    for (const artifact of artifacts) {
      await this.writeText(runId, artifact.relativePath, artifact.contents);
    }

    let sequence = result.state.lastEventSequence;
    const events: RunEvent[] = result.events.map((pending) => {
      sequence += 1;
      return RunEventSchema.parse({
        sequence,
        type: pending.type,
        detail:
          pending.detail && typeof pending.detail === "object"
            ? (pending.detail as Record<string, unknown>)
            : {},
        at: pending.at,
      });
    });

    const next = RunStateSchema.parse({
      ...result.state,
      lastEventSequence: sequence,
      revision: result.state.revision + 1,
      updatedAt: result.events.at(-1)?.at ?? new Date().toISOString(),
    });

    if (events.length === 0) {
      await atomicJson(path.join(this.runDirectory(runId), "state.json"), next);
      return next;
    }

    // Journal the final event so a crash between state and history can recover.
    const journal: TransitionJournal = {
      expectedRevision: result.state.revision,
      state: next,
      event: events[events.length - 1]!,
      owner: { pid: process.pid, hostname: localHostname() },
    };
    await atomicJson(this.transitionJournalPath(runId), journal);
    await atomicJson(path.join(this.runDirectory(runId), "state.json"), next);
    for (const event of events) {
      await this.appendEventOnce(runId, event);
    }
    await unlink(this.transitionJournalPath(runId));
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

  workspaceAdminLockPath(): string {
    return path.join(this.root, "locks", "workspace-admin.lock");
  }

  sharedIndexLockPath(): string {
    return path.join(this.root, "locks", "shared-index.lock");
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
   * Legacy-shared checkout exclusion. Docker/git-disabled runs must not take
   * this for normal advancement. Callers that also take a per-run lock must
   * acquire this first (repository → run) to avoid deadlock.
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

  /**
   * Short lock around shared workspace-administration mutations
   * (add/register/remove/rename). Normal advancement does not take this lock.
   */
  async withWorkspaceAdminLock<T>(
    holder: { runId: string; action: string },
    work: () => Promise<T>,
  ): Promise<T> {
    return this.withNamedLock(this.workspaceAdminLockPath(), holder, work, (lockPath, body) => {
      const runId = body?.runId ?? "unknown";
      const action = body?.action ?? "unknown";
      const at = body?.at ?? "unknown time";
      throw new Error(
        `Workspace administration is in use by run ${runId} (${action}) since ${at}. Wait, or remove ${lockPath} if that process is gone.`,
      );
    });
  }

  /**
   * Short lock around mutable shared knowledge-index updates under stateRoot.
   * CodeGraph indexes in a Docker workspace are run-local and do not need this lock.
   */
  async withSharedIndexLock<T>(
    holder: { runId: string; action: string },
    work: () => Promise<T>,
  ): Promise<T> {
    return this.withNamedLock(this.sharedIndexLockPath(), holder, work, (lockPath, body) => {
      const runId = body?.runId ?? "unknown";
      const action = body?.action ?? "unknown";
      const at = body?.at ?? "unknown time";
      throw new Error(
        `Shared knowledge index is in use by run ${runId} (${action}) since ${at}. Wait, or remove ${lockPath} if that process is gone.`,
      );
    });
  }

  async inspectSharedIndexLock(): Promise<{
    path: string;
    body: LockBody | null;
    ageMs: number | null;
  } | null> {
    return readLockInfo(this.sharedIndexLockPath());
  }

  async inspectWorkspaceAdminLock(): Promise<{
    path: string;
    body: LockBody | null;
    ageMs: number | null;
  } | null> {
    return readLockInfo(this.workspaceAdminLockPath());
  }

  /**
   * Short coordination locks wait briefly for the holder to finish.
   * Repository/run locks stay fail-fast via acquireLockFile.
   */
  private async withNamedLock<T>(
    lockPath: string,
    holder: { runId: string; action: string },
    work: () => Promise<T>,
    onBusy: (lockPath: string, body: LockBody | null) => never,
    options: { waitMs?: number; pollMs?: number } = {},
  ): Promise<T> {
    const waitMs = options.waitMs ?? 30_000;
    const pollMs = options.pollMs ?? 50;
    const deadline = Date.now() + Math.max(0, waitMs);
    await mkdir(path.dirname(lockPath), { recursive: true });

    for (;;) {
      try {
        const handle = await open(lockPath, "wx");
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
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline) {
          const info = await readLockInfo(lockPath);
          onBusy(lockPath, info?.body ?? null);
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    }
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

  private transitionJournalPath(runId: string): string {
    return path.join(this.runDirectory(runId), "transition.pending.json");
  }

  private async recoverPendingTransition(runId: string, options: { force?: boolean } = {}): Promise<void> {
    const journalPath = this.transitionJournalPath(runId);
    let raw: string;
    try {
      raw = await readStable(journalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const pending = parseTransitionJournal(raw);
    if (!options.force && pending.owner && processIsAlive(pending.owner)) {
      // A dashboard/status read can overlap a normal record(). Let the owning
      // writer finish rather than racing its event append.
      return;
    }
    if (pending.config !== undefined) {
      // Restore the matching frozen snapshot before (or with) state recovery so
      // a crash after config.json cannot leave a new policy with a stale hash.
      await atomicJson(path.join(this.runDirectory(runId), "config.json"), pending.config);
    }
    const statePath = path.join(this.runDirectory(runId), "state.json");
    const current = RunStateSchema.parse(JSON.parse(await readStable(statePath)));
    if (current.revision === pending.expectedRevision) {
      await atomicJson(statePath, pending.state);
    } else if (current.revision !== pending.state.revision) {
      throw new Error(
        `Cannot recover transition for run ${runId}: expected revision ${pending.expectedRevision}, found ${current.revision}`,
      );
    }
    await this.appendEventOnce(runId, pending.event);
    await unlink(journalPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  private async maybeFault(boundary: ConfigTransitionFault): Promise<void> {
    if (this.configTransitionFault === boundary) {
      throw new Error(`fault injection: config transition crashed at ${boundary}`);
    }
  }

  private async appendEventOnce(runId: string, event: RunEvent): Promise<void> {
    const eventPath = path.join(this.runDirectory(runId), "events.jsonl");
    const { events: existing, tornFinalRecord } = await readEvents(eventPath);
    if (tornFinalRecord) {
      // A partial JSONL append cannot be continued in place: doing so would
      // turn it into a malformed middle record. Rebuild the valid prefix.
      await atomicText(
        eventPath,
        existing.length === 0 ? "" : `${existing.map((item) => JSON.stringify(item)).join("\n")}\n`,
      );
    }
    const duplicate = existing.find((candidate) => candidate.sequence === event.sequence);
    if (duplicate) {
      if (JSON.stringify(duplicate) !== JSON.stringify(event)) {
        throw new Error(`Event sequence ${event.sequence} conflicts with existing run history`);
      }
      return;
    }
    if (existing.some((candidate) => candidate.sequence > event.sequence)) {
      throw new Error(`Event sequence ${event.sequence} is behind existing run history`);
    }
    await appendFile(eventPath, `${JSON.stringify(event)}\n`, "utf8");
  }
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`Invalid identifier: ${value}`);
  }
  return value;
}

async function atomicJson(target: string, value: unknown): Promise<void> {
  await atomicText(target, `${JSON.stringify(value, null, 2)}\n`);
}

async function atomicText(target: string, value: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, "utf8");
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
    // Automatic stale-lock takeover is unsafe: another contender can acquire a
    // fresh lock between the liveness check and deletion. Require an explicit
    // operator unlock for abandoned locks instead.
    const info = await readLockInfo(lockPath);
    onAlive(info?.body ?? null);
  }
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

/** Parses the durable recovery record written before state and event updates. */
function parseTransitionJournal(raw: string): TransitionJournal {
  const value = JSON.parse(raw) as Partial<TransitionJournal>;
  if (
    typeof value.expectedRevision !== "number" ||
    !Number.isInteger(value.expectedRevision) ||
    value.state == null ||
    value.event == null
  ) {
    throw new Error("Invalid pending transition journal");
  }
  const state = RunStateSchema.parse(value.state);
  const event = RunEventSchema.parse(value.event);
  if (state.revision !== value.expectedRevision + 1 || event.sequence !== state.lastEventSequence) {
    throw new Error("Inconsistent pending transition journal");
  }
  const owner = isLockOwner(value.owner) ? value.owner : undefined;
  return {
    expectedRevision: value.expectedRevision,
    state,
    event,
    ...(owner ? { owner } : {}),
    ...(value.config !== undefined ? { config: value.config } : {}),
  };
}

function isLockOwner(value: unknown): value is Pick<LockBody, "pid" | "hostname"> {
  return (
    typeof value === "object" &&
    value != null &&
    typeof (value as Partial<LockBody>).pid === "number" &&
    Number.isFinite((value as Partial<LockBody>).pid) &&
    typeof (value as Partial<LockBody>).hostname === "string"
  );
}

function processIsAlive(owner: Pick<LockBody, "pid" | "hostname">): boolean {
  if (owner.hostname !== localHostname()) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Reads valid history and ignores a torn final JSONL record left by a crash. */
async function readEvents(eventPath: string): Promise<{ events: RunEvent[]; tornFinalRecord: boolean }> {
  let raw: string;
  try {
    raw = await readStable(eventPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { events: [], tornFinalRecord: false };
    throw error;
  }
  const lines = raw.split("\n");
  const events: RunEvent[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    try {
      events.push(RunEventSchema.parse(JSON.parse(line)));
    } catch (error) {
      if (index === lines.length - 1 && !raw.endsWith("\n")) {
        return { events, tornFinalRecord: true };
      }
      throw error;
    }
  }
  return { events, tornFinalRecord: false };
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
