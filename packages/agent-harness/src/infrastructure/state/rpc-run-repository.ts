import { randomUUID } from "node:crypto";
import type { HarnessConfig } from "../../config/schema.js";
import type { RunState, TransitionResult } from "../../domain.js";
import type { RunRepository } from "../../application/run-repository.js";
import type {
  MutationContext,
  RunArtifactRef,
  RunStatePort,
} from "../../application/run-state-port.js";
import type { RunLoadFailure } from "../../store.js";

export type RpcRunRepositoryOptions = {
  runId: string;
  workerInstanceId: string;
  fencingToken: number;
  config: HarnessConfig;
  port: RunStatePort;
};

/**
 * Worker repository backed exclusively by the authenticated RunStatePort.
 * It owns no host path and uses real in-process exclusion around workflow calls.
 */
export class RpcRunRepository implements RunRepository {
  readonly config: HarnessConfig;
  readonly root = "run-state-rpc:";
  readonly singleRunId: string;
  private readonly port: RunStatePort;
  private readonly workerInstanceId: string;
  private readonly activeLocks = new Set<string>();
  private readonly lockWaiters = new Map<string, Array<() => void>>();
  private fencingToken: number;

  constructor(config: HarnessConfig, options: Omit<RpcRunRepositoryOptions, "config">);
  constructor(options: RpcRunRepositoryOptions);
  constructor(
    configOrOptions: HarnessConfig | RpcRunRepositoryOptions,
    maybeOptions?: Omit<RpcRunRepositoryOptions, "config">,
  ) {
    const options =
      maybeOptions === undefined
        ? (configOrOptions as RpcRunRepositoryOptions)
        : { ...maybeOptions, config: configOrOptions as HarnessConfig };
    this.config = options.config;
    this.singleRunId = options.runId;
    this.port = options.port;
    this.workerInstanceId = options.workerInstanceId;
    this.fencingToken = options.fencingToken;
  }

  async initialize(): Promise<void> {}

  async create(_state: RunState): Promise<void> {
    throw new Error("Workers cannot create host-owned runs");
  }

  async load(runId: string): Promise<RunState> {
    return (await this.port.loadSnapshot(runId)).state;
  }

  async list(): Promise<RunState[]> {
    return [await this.load(this.singleRunId)];
  }

  async listWithFailures(): Promise<{ states: RunState[]; failures: RunLoadFailure[] }> {
    return { states: await this.list(), failures: [] };
  }

  async writeState(state: RunState): Promise<RunState> {
    return this.persistTransition(state.runId, { state, events: [] });
  }

  async record(
    state: RunState,
    type: string,
    detail: Record<string, unknown> = {},
    options: { config?: unknown } = {},
  ): Promise<RunState> {
    const artifacts =
      options.config === undefined
        ? []
        : [{ relativePath: "config.json", contents: JSON.stringify(options.config) }];
    return this.persistTransition(
      state.runId,
      {
        state,
        events: [{ type, detail, at: new Date().toISOString() }],
      },
      artifacts,
    );
  }

  async persistTransition(
    runId: string,
    result: TransitionResult,
    artifacts: Array<{ relativePath: string; contents: string }> = [],
  ): Promise<RunState> {
    const snapshot = await this.port.compareAndSwap(runId, {
      ...this.mutation(),
      expectedRevision: result.state.revision,
      transition: result,
      ...(artifacts.length > 0
        ? {
            artifacts: artifacts.map((item) => ({
              ref: artifactRef(item.relativePath),
              contents: item.contents,
            })),
          }
        : {}),
    });
    return snapshot.state;
  }

  async writeJson(runId: string, relativePath: string, value: unknown): Promise<string> {
    return this.writeText(runId, relativePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  async appendJsonl(runId: string, relativePath: string, value: unknown): Promise<string> {
    const ref = artifactRef(relativePath);
    if (ref.kind === "session-steps") {
      await this.port.appendSessionSteps(runId, ref.id, [value], this.mutation());
    } else {
      const current = (await this.port.readArtifact(runId, ref)) ?? "";
      await this.port.writeArtifact(
        runId,
        ref,
        `${current}${JSON.stringify(value)}\n`,
        this.mutation(),
      );
    }
    return artifactUri(runId, relativePath);
  }

  async remove(runId: string, relativePath: string): Promise<void> {
    await this.port.deleteArtifact(runId, artifactRef(relativePath), this.mutation());
  }

  async writeText(runId: string, relativePath: string, value: string): Promise<string> {
    await this.port.writeArtifact(runId, artifactRef(relativePath), value, this.mutation());
    return artifactUri(runId, relativePath);
  }

  async readText(runId: string, relativePath: string): Promise<string> {
    const value = await this.port.readArtifact(runId, artifactRef(relativePath));
    if (value === undefined) {
      const error = new Error(`Artifact not found: ${relativePath}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return value;
  }

  async readJson(runId: string, relativePath: string): Promise<unknown> {
    return JSON.parse(await this.readText(runId, relativePath));
  }

  async listFiles(runId: string, relativeDirectory: string): Promise<string[]> {
    if (relativeDirectory !== "sessions") return [];
    return (await this.port.listArtifacts(runId, "session"))
      .filter(
        (ref): ref is Extract<RunArtifactRef, { kind: "session" }> => ref.kind === "session",
      )
      .map((ref) => `sessions/${ref.id}.json`)
      .sort();
  }

  runDirectory(_runId: string): string {
    throw new Error("RPC-backed run state has no filesystem directory");
  }

  withLock<T>(runId: string, work: () => Promise<T>): Promise<T> {
    return this.withScopedLock(`run:${runId}`, work);
  }

  async tryWithLock<T>(
    runId: string,
    waitMs: number,
    work: () => Promise<T>,
    options: { pollMs?: number } = {},
  ): Promise<{ acquired: true; value: T } | { acquired: false }> {
    const key = `run:${runId}`;
    const deadline = Date.now() + Math.max(0, waitMs);
    const pollMs = options.pollMs ?? 25;
    while (this.activeLocks.has(key)) {
      if (Date.now() >= deadline) return { acquired: false };
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    this.activeLocks.add(key);
    try {
      return { acquired: true, value: await work() };
    } finally {
      this.releaseLock(key);
    }
  }

  withRepositoryLock<T>(
    _holder: { runId: string; action: string },
    work: () => Promise<T>,
  ): Promise<T> {
    return this.withScopedLock("repository", work);
  }

  withWorkspaceAdminLock<T>(
    holder: { runId: string; action: string },
    work: () => Promise<T>,
  ): Promise<T> {
    return this.withScopedLock(`workspace:${holder.runId}`, work);
  }

  withSharedIndexLock<T>(
    _holder: { runId: string; action: string },
    work: () => Promise<T>,
  ): Promise<T> {
    return this.withScopedLock("shared-index", work);
  }

  private async withScopedLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    while (this.activeLocks.has(key)) {
      await new Promise<void>((resolve) => {
        const waiters = this.lockWaiters.get(key) ?? [];
        waiters.push(resolve);
        this.lockWaiters.set(key, waiters);
      });
    }
    this.activeLocks.add(key);
    try {
      return await work();
    } finally {
      this.releaseLock(key);
    }
  }

  private releaseLock(key: string): void {
    this.activeLocks.delete(key);
    const waiters = this.lockWaiters.get(key);
    const next = waiters?.shift();
    if (waiters?.length === 0) this.lockWaiters.delete(key);
    next?.();
  }

  private mutation(): MutationContext {
    const id = randomUUID();
    return {
      requestId: id,
      idempotencyKey: id,
      workerInstanceId: this.workerInstanceId,
      fencingToken: this.fencingToken,
    };
  }
}

function artifactUri(runId: string, relativePath: string): string {
  return `run-artifact://${encodeURIComponent(runId)}/${relativePath.replaceAll("\\", "/")}`;
}

function artifactRef(relativePath: string): RunArtifactRef {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  let match: RegExpMatchArray | null;
  if ((match = normalized.match(/^packets\/([^/]+)\.guidance\.json$/)))
    return { kind: "packet-guidance", id: match[1]! };
  if ((match = normalized.match(/^packets\/([^/]+)\.retrieval\.json$/)))
    return { kind: "packet-retrieval", id: match[1]! };
  if ((match = normalized.match(/^packets\/([^/]+)\.json$/)))
    return { kind: "packet", id: match[1]! };
  if ((match = normalized.match(/^sessions\/([^/]+)\.steps\.jsonl$/)))
    return { kind: "session-steps", id: match[1]! };
  if ((match = normalized.match(/^sessions\/([^/]+)\.json$/)))
    return { kind: "session", id: match[1]! };
  if ((match = normalized.match(/^issues\/([^/]+)\.md$/)))
    return { kind: "issue", id: match[1]! };
  if ((match = normalized.match(/^tasks\/([^/]+)\/([^/]+)$/)))
    return { kind: "task-artifact", taskId: match[1]!, name: match[2]! };
  if ((match = normalized.match(/^(idea|brief|grill|unknowns|plan|prd|scenarios)\.md$/))) {
    return {
      kind: "document",
      name: match[1] as Extract<RunArtifactRef, { kind: "document" }>["name"],
    };
  }
  if ((match = normalized.match(/^tasks\/([^/]+)\.md$/)))
    return { kind: "tracker-task", id: match[1]! };
  if (normalized === "installs.jsonl") return { kind: "install-log" };
  if (normalized === "activity.json") return { kind: "activity" };
  if (normalized === "config.json") return { kind: "config" };
  if (normalized === "transport/import.json") return { kind: "transport-import" };
  if (normalized === "transport/result.manifest.json") return { kind: "result-manifest" };
  if ((match = normalized.match(/^transport\/result-bundle-chunks\/([^/]+)\.base64$/)))
    return { kind: "result-bundle-chunk", id: match[1]! };
  if (normalized === "sandbox-isolation-probe.json") return { kind: "sandbox-probe" };
  throw new Error(`Run artifact is not part of the worker state contract: ${relativePath}`);
}
