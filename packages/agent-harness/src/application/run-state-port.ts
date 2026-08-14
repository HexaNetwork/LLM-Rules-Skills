import type { PendingEvent, RunState, TransitionResult } from "../domain.js";

/**
 * RunStatePort: the boundary between HarnessEngine and durable run state
 * (ADR 0016). The host is authoritative for durable state; the active worker
 * advances the run through this port using compare-and-swap revisions,
 * idempotency keys, and lease fencing tokens. Implementations:
 * - FilesystemRunStatePort (host services, focused unit tests)
 * - RpcRunStatePort (production worker containers)
 *
 * Operations are modeled by domain object and artifact identifier — there is
 * no arbitrary file read/write, so a worker can never turn the state service
 * into a general host filesystem proxy.
 */

export const RUN_STATE_PORT_VERSION = 1 as const;

/** A run snapshot: the durable state plus the revision it was read at. */
export type RunStateSnapshot = {
  state: RunState;
  revision: number;
};

/** Documents rendered at the run root by the tracker (`.md` appended). */
export const RUN_DOCUMENT_NAMES = [
  "idea",
  "brief",
  "grill",
  "unknowns",
  "plan",
  "prd",
  "scenarios",
] as const;
export type RunDocumentName = (typeof RUN_DOCUMENT_NAMES)[number];

/**
 * Typed artifact identity. Each kind maps to exactly one fixed path template
 * inside the run directory; identifiers are validated path segments.
 */
export type RunArtifactRef =
  | { kind: "packet"; id: string }
  | { kind: "packet-guidance"; id: string }
  | { kind: "packet-retrieval"; id: string }
  | { kind: "session"; id: string }
  | { kind: "session-steps"; id: string }
  | { kind: "document"; name: RunDocumentName }
  | { kind: "issue"; id: string }
  | { kind: "tracker-task"; id: string }
  | { kind: "task-artifact"; taskId: string; name: string }
  | { kind: "install-log" }
  | { kind: "activity" }
  | { kind: "config" }
  | { kind: "transport-import" }
  | { kind: "result-manifest" }
  | { kind: "result-bundle-chunk"; id: string }
  | { kind: "sandbox-probe" };

export type RunArtifactKind = RunArtifactRef["kind"];

/** Per-kind serialized size ceilings (bytes of UTF-8 content per write). */
export const RUN_ARTIFACT_MAX_BYTES: Record<RunArtifactKind, number> = {
  packet: 1_000_000,
  "packet-guidance": 1_000_000,
  "packet-retrieval": 1_000_000,
  session: 1_000_000,
  "session-steps": 256_000,
  document: 512_000,
  issue: 256_000,
  "tracker-task": 256_000,
  "task-artifact": 512_000,
  "install-log": 1_000_000,
  activity: 256_000,
  config: 1_000_000,
  "transport-import": 1_000_000,
  "result-manifest": 1_000_000,
  "result-bundle-chunk": 1_000_000,
  "sandbox-probe": 256_000,
};

/** Kinds that are append-only and therefore reject whole-content writes. */
export const APPEND_ONLY_ARTIFACT_KINDS: ReadonlySet<RunArtifactKind> = new Set([
  "session-steps",
]);

/** Identity attached to every mutation for audit and exactly-once retries. */
export type MutationContext = {
  /** Correlates one logical request across retries and the audit log. */
  requestId: string;
  /** Retries with the same key and payload replay the recorded result. */
  idempotencyKey: string;
  /** Instance identity of the advancing worker, when mutated by one. */
  workerInstanceId?: string;
  /** Lease fencing token; required while another worker holds the run lease. */
  fencingToken?: number;
};

/**
 * Compare-and-swap state mutation. `expectedRevision` must equal the durable
 * revision and `transition.state.revision` must equal it as well; the stored
 * revision becomes `expectedRevision + 1`. Transition events are appended with
 * assigned sequences and listed artifacts are written in the same transition.
 */
export type CasStateMutation = MutationContext & {
  expectedRevision: number;
  transition: TransitionResult;
  artifacts?: Array<{ ref: RunArtifactRef; contents: string }>;
};

/** Idempotent single-event append; advances lastEventSequence and revision. */
export type AppendEventMutation = MutationContext & {
  type: string;
  detail?: Record<string, unknown>;
};

/** Lease held by the one advancing worker of a run. */
export type RunLease = {
  runId: string;
  workerInstanceId: string;
  /** Monotonic per run; a replaced worker always receives a greater token. */
  fencingToken: number;
  acquiredAt: string;
  expiresAt: string;
};

export type AcquireLeaseInput = {
  workerInstanceId: string;
  ttlMs: number;
  requestId: string;
};

export type RenewLeaseInput = {
  workerInstanceId: string;
  fencingToken: number;
  ttlMs: number;
  requestId: string;
};

export type ReleaseLeaseInput = {
  workerInstanceId: string;
  fencingToken: number;
  requestId: string;
};

export interface RunStatePort {
  /** Load the current snapshot. */
  loadSnapshot(runId: string): Promise<RunStateSnapshot>;

  /**
   * Compare-and-swap mutation by expected revision. Throws
   * RunStateConflictError on a stale revision, RunStateFencingError on a stale
   * worker token, and replays the recorded result on an idempotent retry.
   */
  compareAndSwap(runId: string, mutation: CasStateMutation): Promise<RunStateSnapshot>;

  /** Append one event idempotently; returns the resulting snapshot. */
  appendEvent(runId: string, mutation: AppendEventMutation): Promise<RunStateSnapshot>;

  /**
   * Append session-step records to `sessions/<id>.steps.jsonl` idempotently.
   * Lock-free: steps stream while the advancing worker holds the run lock.
   */
  appendSessionSteps(
    runId: string,
    sessionId: string,
    steps: unknown[],
    context: MutationContext,
  ): Promise<void>;

  /** Read an artifact by typed identifier; undefined when absent. */
  readArtifact(runId: string, ref: RunArtifactRef): Promise<string | undefined>;

  /**
   * Write an artifact by typed identifier with the per-kind size ceiling.
   * Idempotent by content; append-only kinds are rejected.
   */
  writeArtifact(
    runId: string,
    ref: RunArtifactRef,
    contents: string,
    context: MutationContext,
  ): Promise<void>;

  /** Remove one typed artifact. Missing artifacts are treated as removed. */
  deleteArtifact(runId: string, ref: RunArtifactRef, context: MutationContext): Promise<void>;

  /** List typed artifact identifiers for the bounded collection kinds. */
  listArtifacts(runId: string, kind: "session"): Promise<RunArtifactRef[]>;

  requestCancellation(runId: string, context: MutationContext): Promise<void>;
  cancellationRequested(runId: string): Promise<boolean>;
  clearCancellation(runId: string, context: MutationContext): Promise<void>;

  requestStop(runId: string, context: MutationContext): Promise<void>;
  stopRequested(runId: string): Promise<boolean>;
  clearStop(runId: string, context: MutationContext): Promise<void>;

  /**
   * Acquire the run lease. Re-acquire by the same worker instance renews;
   * acquisition by a different instance fails while the lease is unexpired and
   * otherwise succeeds with a strictly greater fencing token.
   */
  acquireLease(runId: string, input: AcquireLeaseInput): Promise<RunLease>;
  /** Heartbeat: extend the lease; requires the matching instance and token. */
  renewLease(runId: string, input: RenewLeaseInput): Promise<RunLease>;
  /** Idempotent release; mismatching tokens are rejected as stale. */
  releaseLease(runId: string, input: ReleaseLeaseInput): Promise<void>;
  /** The current lease, or undefined when absent or expired. */
  currentLease(runId: string): Promise<RunLease | undefined>;
}

export type RunStateErrorCode =
  | "stale_revision"
  | "idempotency_conflict"
  | "lease_held"
  | "lease_required"
  | "lease_expired"
  | "stale_fencing_token"
  | "artifact_too_large"
  | "invalid_artifact_ref"
  | "invalid_mutation";

/** Base class for RunStatePort failures; `code` survives RPC serialization. */
export class RunStateError extends Error {
  constructor(
    readonly code: RunStateErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The durable revision moved past the mutation's expected revision. */
export class RunStateConflictError extends RunStateError {
  constructor(runId: string, expectedRevision: number, actualRevision: number) {
    super(
      "stale_revision",
      `Run ${runId} is at revision ${actualRevision}; mutation expected ${expectedRevision}`,
      { runId, expectedRevision, actualRevision },
    );
  }
}

/** An idempotency key was reused with a different payload. */
export class RunStateIdempotencyConflictError extends RunStateError {
  constructor(runId: string, idempotencyKey: string) {
    super(
      "idempotency_conflict",
      `Idempotency key "${idempotencyKey}" for run ${runId} was already used with a different payload`,
      { runId, idempotencyKey },
    );
  }
}

/** The run lease is held by another worker instance, or is required/absent. */
export class RunStateLeaseError extends RunStateError {
  constructor(
    code: "lease_held" | "lease_required" | "lease_expired",
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(code, message, details);
  }
}

/** A mutation presented a fencing token older than the latest issued token. */
export class RunStateFencingError extends RunStateError {
  constructor(runId: string, token: number, message: string) {
    super("stale_fencing_token", message, { runId, token });
  }
}

/** An artifact reference is malformed, append-only, or exceeds its ceiling. */
export class RunStateArtifactError extends RunStateError {
  constructor(
    code: "artifact_too_large" | "invalid_artifact_ref",
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(code, message, details);
  }
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertIdentifier(value: string, field: string): string {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new RunStateArtifactError(
      "invalid_artifact_ref",
      `Invalid artifact ${field}: ${JSON.stringify(value)}`,
      { field, value },
    );
  }
  return value;
}

/** Map a typed artifact reference to its fixed run-relative path. */
export function runArtifactPath(ref: RunArtifactRef): string {
  switch (ref.kind) {
    case "packet":
      return `packets/${assertIdentifier(ref.id, "packet id")}.json`;
    case "packet-guidance":
      return `packets/${assertIdentifier(ref.id, "packet id")}.guidance.json`;
    case "packet-retrieval":
      return `packets/${assertIdentifier(ref.id, "packet id")}.retrieval.json`;
    case "session":
      return `sessions/${assertIdentifier(ref.id, "session id")}.json`;
    case "session-steps":
      return `sessions/${assertIdentifier(ref.id, "session id")}.steps.jsonl`;
    case "document":
      if (!RUN_DOCUMENT_NAMES.includes(ref.name)) {
        throw new RunStateArtifactError(
          "invalid_artifact_ref",
          `Unknown run document: ${JSON.stringify(ref.name)}`,
          { name: ref.name },
        );
      }
      return `${ref.name}.md`;
    case "issue":
      return `issues/${assertIdentifier(ref.id, "issue id")}.md`;
    case "tracker-task":
      return `tasks/${assertIdentifier(ref.id, "tracker task id")}.md`;
    case "task-artifact":
      return `tasks/${assertIdentifier(ref.taskId, "task id")}/${assertIdentifier(ref.name, "artifact name")}`;
    case "install-log":
      return "installs.jsonl";
    case "activity":
      return "activity.json";
    case "config":
      return "config.json";
    case "transport-import":
      return "transport/import.json";
    case "result-manifest":
      return "transport/result.manifest.json";
    case "result-bundle-chunk":
      return `transport/result-bundle-chunks/${assertIdentifier(ref.id, "result bundle chunk id")}.base64`;
    case "sandbox-probe":
      return "sandbox-isolation-probe.json";
  }
}

/** Serialized size ceiling for the reference's kind. */
export function runArtifactMaxBytes(ref: RunArtifactRef): number {
  return RUN_ARTIFACT_MAX_BYTES[ref.kind];
}

export function assertArtifactSize(ref: RunArtifactRef, contents: string): void {
  const bytes = Buffer.byteLength(contents, "utf8");
  const max = runArtifactMaxBytes(ref);
  if (bytes > max) {
    throw new RunStateArtifactError(
      "artifact_too_large",
      `Artifact ${runArtifactPath(ref)} is ${bytes} bytes; limit is ${max}`,
      { path: runArtifactPath(ref), bytes, max },
    );
  }
}

export type { PendingEvent, TransitionResult };
