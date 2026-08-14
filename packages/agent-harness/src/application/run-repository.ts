import type { HarnessConfig } from "../config/schema.js";
import type { RunState, TransitionResult } from "../domain.js";
import type { RunLoadFailure } from "../store.js";

/** Storage operations used by workflow services, independent of host filesystem layout. */
export interface RunRepository {
  readonly config: HarnessConfig;
  readonly root: string;
  readonly singleRunId?: string;
  initialize(): Promise<void>;
  create(state: RunState): Promise<void>;
  load(runId: string): Promise<RunState>;
  list(): Promise<RunState[]>;
  listWithFailures(): Promise<{ states: RunState[]; failures: RunLoadFailure[] }>;
  writeState(state: RunState): Promise<RunState>;
  record(
    state: RunState,
    type: string,
    detail?: Record<string, unknown>,
    options?: { config?: unknown },
  ): Promise<RunState>;
  persistTransition(
    runId: string,
    result: TransitionResult,
    artifacts?: Array<{ relativePath: string; contents: string }>,
  ): Promise<RunState>;
  writeJson(runId: string, relativePath: string, value: unknown): Promise<string>;
  appendJsonl(runId: string, relativePath: string, value: unknown): Promise<string>;
  remove(runId: string, relativePath: string): Promise<void>;
  writeText(runId: string, relativePath: string, value: string): Promise<string>;
  readText(runId: string, relativePath: string): Promise<string>;
  readJson(runId: string, relativePath: string): Promise<unknown>;
  listFiles(runId: string, relativeDirectory: string): Promise<string[]>;
  runDirectory(runId: string): string;
  withLock<T>(runId: string, work: () => Promise<T>): Promise<T>;
  tryWithLock<T>(
    runId: string,
    waitMs: number,
    work: () => Promise<T>,
    options?: { pollMs?: number },
  ): Promise<{ acquired: true; value: T } | { acquired: false }>;
  withRepositoryLock<T>(
    holder: { runId: string; action: string },
    work: () => Promise<T>,
  ): Promise<T>;
  withWorkspaceAdminLock<T>(
    holder: { runId: string; action: string },
    work: () => Promise<T>,
  ): Promise<T>;
  withSharedIndexLock<T>(
    holder: { runId: string; action: string },
    work: () => Promise<T>,
  ): Promise<T>;
}

/** Host-only lock inspection and recovery; never part of the worker repository contract. */
export interface OperatorRunRepository extends RunRepository {
  inspectRunLock(runId: string): Promise<RunLockInspection | null>;
  inspectWorkspaceAdminLock(): Promise<RunLockInspection | null>;
  inspectSharedIndexLock(): Promise<RunLockInspection | null>;
  unlock(
    runId: string,
    options?: { repo?: boolean },
  ): Promise<{ run: boolean; repo: boolean | "absent" }>;
}

export type RunLockInspection = {
  path: string;
  body: {
    pid: number;
    hostname: string;
    at: string;
    runId?: string;
    action?: string;
  } | null;
  ageMs: number | null;
};
