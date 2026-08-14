import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ZodError } from "zod";
import type { HarnessConfig } from "../../../config/schema.js";
import { loadRunConfig, loadRunWorkspace } from "../../../config/io.js";
import type { RunWorkspace } from "../../../domain/workspace.js";
import {
  RUN_DOCUMENT_NAMES,
  RunStateError,
  type MutationContext,
  type RunArtifactRef,
  type RunStatePort,
  type RunStateSnapshot,
  type TransitionResult,
} from "../../../application/run-state-port.js";
import type { WorkerStateCredentialIssuer } from "../../../application/worker-state-credentials.js";
import type { RunStore } from "../../../store.js";
import {
  RUN_STATE_API_AUTH_HEADER,
  RUN_STATE_API_MAX_BODY_BYTES,
  RUN_STATE_API_PREFIX,
  RUN_STATE_API_PROTOCOL_HEADER,
  RUN_STATE_API_PROTOCOL_VERSION,
  RUN_STATE_API_REQUEST_ID_HEADER,
  type RunStateApiErrorCode,
  type RunStateApiResponse,
} from "../../../worker/state-protocol.js";

/**
 * Worker-facing host state API (ADR 0016, plan Phase 3). Separate from the
 * dashboard routes: its own URL prefix, its own per-run credential, its own
 * protocol version, and its own response envelope shaped so a future
 * RpcRunStatePort can rethrow the same typed RunStateError failures.
 *
 * The API never accepts caller-selected host paths: artifacts are addressed
 * exclusively by typed RunArtifactRef, and bodies carrying raw path fields
 * are rejected. Every mutation is audited (run ID, worker instance ID,
 * request ID, expected/resulting revision, operation, timestamp); credentials
 * and artifact bodies are never logged.
 */
export type WorkerStateApiContext = {
  port: RunStatePort;
  credentials: WorkerStateCredentialIssuer;
  getProjectConfig(): HarnessConfig;
  store: RunStore;
  now?: () => Date;
};

/** Durable audit record appended to `state-audit.jsonl` per worker mutation. */
export const WORKER_STATE_AUDIT_LOG = "state-audit.jsonl" as const;

type AuditRecord = {
  at: string;
  runId: string;
  operation: string;
  requestId: string;
  workerInstanceId?: string;
  expectedRevision?: number;
  resultingRevision?: number;
  outcome: "ok" | "error";
  errorCode?: string;
};

class StateApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: RunStateApiErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "StateApiError";
  }
}

/** @returns true when the request targets the state API prefix (always handled). */
export async function handleWorkerStateRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  ctx: WorkerStateApiContext,
): Promise<boolean> {
  if (!url.pathname.startsWith(`${RUN_STATE_API_PREFIX}/`)) return false;
  const requestId = headerValue(request, RUN_STATE_API_REQUEST_ID_HEADER) ?? randomUUID();
  try {
    const result = await dispatch(request, url, ctx, requestId);
    sendJson(response, 200, { ok: true, requestId, result } satisfies RunStateApiResponse);
  } catch (error) {
    const mapped = mapError(error);
    sendJson(response, mapped.status, {
      ok: false,
      requestId,
      error: { code: mapped.code, message: mapped.message, details: mapped.details },
    } satisfies RunStateApiResponse);
  }
  return true;
}

async function dispatch(
  request: IncomingMessage,
  url: URL,
  ctx: WorkerStateApiContext,
  requestId: string,
): Promise<unknown> {
  const match = url.pathname.match(/^\/state-api\/v1\/runs\/([^/]+)(?:\/([A-Za-z-/]+))?$/);
  if (!match) {
    throw new StateApiError(404, "not_found", `Unknown state API path ${url.pathname}`);
  }
  const runId = decodeURIComponent(match[1]!);
  const operation = match[2] ?? "";

  // Fail closed on protocol mismatch: the header is required and must equal
  // the version the credential was minted for.
  const protocolHeader = headerValue(request, RUN_STATE_API_PROTOCOL_HEADER);
  if (protocolHeader !== String(RUN_STATE_API_PROTOCOL_VERSION)) {
    throw new StateApiError(
      426,
      "protocol_mismatch",
      `Unsupported state protocol ${JSON.stringify(protocolHeader ?? null)}; host speaks ${RUN_STATE_API_PROTOCOL_VERSION}`,
      { expected: RUN_STATE_API_PROTOCOL_VERSION, presented: protocolHeader ?? null },
    );
  }

  const verification = await ctx.credentials.verify(
    runId,
    headerValue(request, RUN_STATE_API_AUTH_HEADER),
  );
  if (!verification.ok) {
    if (verification.reason === "wrong_run") {
      throw new StateApiError(403, "forbidden", `Credential is not scoped to run ${runId}`, {
        runId,
      });
    }
    if (verification.reason === "protocol_mismatch") {
      throw new StateApiError(
        426,
        "protocol_mismatch",
        `Credential was minted for a different state protocol version; host speaks ${RUN_STATE_API_PROTOCOL_VERSION}`,
        { expected: RUN_STATE_API_PROTOCOL_VERSION },
      );
    }
    throw new StateApiError(
      401,
      "unauthorized",
      verification.reason === "expired"
        ? "Worker state credential has expired"
        : "Invalid or missing worker state credential",
    );
  }
  const credential = verification.credential;

  const method = request.method ?? "GET";
  const needsBody = method === "POST" || method === "PUT";
  const body = needsBody ? await readBody(request) : {};

  switch (operation) {
    case "bootstrap": {
      assertMethod(method, "GET", operation);
      return bootstrapDocument(ctx, runId, credential.workerInstanceId);
    }
    case "snapshot": {
      assertMethod(method, "GET", operation);
      return ctx.port.loadSnapshot(runId);
    }
    case "compare-and-swap": {
      assertMethod(method, "POST", operation);
      const mutation = {
        ...mutationContext(body, credential.workerInstanceId),
        expectedRevision: requiredInteger(body.expectedRevision, "expectedRevision", 0),
        transition: requiredTransition(body.transition),
        ...(body.artifacts !== undefined
          ? { artifacts: parseCasArtifacts(body.artifacts) }
          : {}),
      };
      const snapshot = await ctx.port.compareAndSwap(runId, mutation);
      await audit(ctx, runId, {
        operation: "compare-and-swap",
        requestId: mutation.requestId,
        workerInstanceId: mutation.workerInstanceId,
        expectedRevision: mutation.expectedRevision,
        resultingRevision: snapshot.revision,
        outcome: "ok",
      });
      return snapshot;
    }
    case "events": {
      assertMethod(method, "POST", operation);
      const mutation = {
        ...mutationContext(body, credential.workerInstanceId),
        type: requiredString(body.type, "type", 200),
        ...(body.detail !== undefined ? { detail: requiredRecord(body.detail, "detail") } : {}),
      };
      const snapshot = await ctx.port.appendEvent(runId, mutation);
      await audit(ctx, runId, {
        operation: "append-event",
        requestId: mutation.requestId,
        workerInstanceId: mutation.workerInstanceId,
        resultingRevision: snapshot.revision,
        outcome: "ok",
      });
      return snapshot;
    }
    case "session-steps": {
      assertMethod(method, "POST", operation);
      const context = mutationContext(body, credential.workerInstanceId);
      const sessionId = requiredString(body.sessionId, "sessionId", 200);
      const steps = requiredArray(body.steps, "steps");
      await ctx.port.appendSessionSteps(runId, sessionId, steps, context);
      await audit(ctx, runId, {
        operation: "append-session-steps",
        requestId: context.requestId,
        workerInstanceId: context.workerInstanceId,
        outcome: "ok",
      });
      return { appended: steps.length };
    }
    case "artifacts/read": {
      assertMethod(method, "POST", operation);
      rejectRawPathFields(body);
      const ref = parseArtifactRef(body.ref);
      const contents = await ctx.port.readArtifact(runId, ref);
      return { contents: contents ?? null };
    }
    case "artifacts/write": {
      assertMethod(method, "POST", operation);
      rejectRawPathFields(body);
      const ref = parseArtifactRef(body.ref);
      const contents = body.contents;
      if (typeof contents !== "string") {
        throw new StateApiError(400, "bad_request", "contents must be a string");
      }
      const context = mutationContext(body, credential.workerInstanceId);
      await ctx.port.writeArtifact(runId, ref, contents, context);
      await audit(ctx, runId, {
        operation: "write-artifact",
        requestId: context.requestId,
        workerInstanceId: context.workerInstanceId,
        outcome: "ok",
      });
      return { written: true };
    }
    case "artifacts/delete": {
      assertMethod(method, "POST", operation);
      rejectRawPathFields(body);
      const ref = parseArtifactRef(body.ref);
      const context = mutationContext(body, credential.workerInstanceId);
      await ctx.port.deleteArtifact(runId, ref, context);
      await audit(ctx, runId, { operation: "delete-artifact", requestId: context.requestId, workerInstanceId: context.workerInstanceId, outcome: "ok" });
      return { deleted: true };
    }
    case "artifacts/list": {
      assertMethod(method, "POST", operation);
      rejectRawPathFields(body);
      const kind = requiredString(body.kind, "kind", 100);
      if (kind !== "session") {
        throw new StateApiError(400, "invalid_artifact_ref", `Artifact collection ${kind} cannot be listed`);
      }
      return { artifacts: await ctx.port.listArtifacts(runId, kind) };
    }
    case "lease": {
      assertMethod(method, "GET", operation);
      return { lease: (await ctx.port.currentLease(runId)) ?? null };
    }
    case "lease/acquire": {
      assertMethod(method, "POST", operation);
      const input = {
        workerInstanceId: scopedWorkerInstanceId(body, credential.workerInstanceId),
        ttlMs: requiredInteger(body.ttlMs, "ttlMs", 1),
        requestId: optionalString(body.requestId, "requestId", 200) ?? requestId,
      };
      const lease = await ctx.port.acquireLease(runId, input);
      await audit(ctx, runId, {
        operation: "lease-acquire",
        requestId: input.requestId,
        workerInstanceId: input.workerInstanceId,
        outcome: "ok",
      });
      return lease;
    }
    case "lease/renew": {
      assertMethod(method, "POST", operation);
      const input = {
        workerInstanceId: scopedWorkerInstanceId(body, credential.workerInstanceId),
        fencingToken: requiredInteger(body.fencingToken, "fencingToken", 1),
        ttlMs: requiredInteger(body.ttlMs, "ttlMs", 1),
        requestId: optionalString(body.requestId, "requestId", 200) ?? requestId,
      };
      const lease = await ctx.port.renewLease(runId, input);
      await audit(ctx, runId, {
        operation: "lease-renew",
        requestId: input.requestId,
        workerInstanceId: input.workerInstanceId,
        outcome: "ok",
      });
      return lease;
    }
    case "lease/release": {
      assertMethod(method, "POST", operation);
      const input = {
        workerInstanceId: scopedWorkerInstanceId(body, credential.workerInstanceId),
        fencingToken: requiredInteger(body.fencingToken, "fencingToken", 1),
        requestId: optionalString(body.requestId, "requestId", 200) ?? requestId,
      };
      await ctx.port.releaseLease(runId, input);
      await audit(ctx, runId, {
        operation: "lease-release",
        requestId: input.requestId,
        workerInstanceId: input.workerInstanceId,
        outcome: "ok",
      });
      return { released: true };
    }
    case "cancellation": {
      assertMethod(method, "GET", operation);
      return { requested: await ctx.port.cancellationRequested(runId) };
    }
    case "cancellation/request": {
      assertMethod(method, "POST", operation);
      const context = mutationContext(body, credential.workerInstanceId);
      await ctx.port.requestCancellation(runId, context);
      await audit(ctx, runId, { operation: "cancellation-request", requestId: context.requestId, workerInstanceId: context.workerInstanceId, outcome: "ok" });
      return { requested: true };
    }
    case "cancellation/clear": {
      assertMethod(method, "POST", operation);
      const context = mutationContext(body, credential.workerInstanceId);
      await ctx.port.clearCancellation(runId, context);
      await audit(ctx, runId, { operation: "cancellation-clear", requestId: context.requestId, workerInstanceId: context.workerInstanceId, outcome: "ok" });
      return { requested: false };
    }
    case "stop": {
      assertMethod(method, "GET", operation);
      return { requested: await ctx.port.stopRequested(runId) };
    }
    case "stop/request": {
      assertMethod(method, "POST", operation);
      const context = mutationContext(body, credential.workerInstanceId);
      await ctx.port.requestStop(runId, context);
      await audit(ctx, runId, { operation: "stop-request", requestId: context.requestId, workerInstanceId: context.workerInstanceId, outcome: "ok" });
      return { requested: true };
    }
    case "stop/clear": {
      assertMethod(method, "POST", operation);
      const context = mutationContext(body, credential.workerInstanceId);
      await ctx.port.clearStop(runId, context);
      await audit(ctx, runId, { operation: "stop-clear", requestId: context.requestId, workerInstanceId: context.workerInstanceId, outcome: "ok" });
      return { requested: false };
    }
    case "export-ready": {
      assertMethod(method, "POST", operation);
      const mutation = {
        ...mutationContext(body, credential.workerInstanceId),
        type: "worker.export_ready",
        detail: {
          ...(body.detail !== undefined ? requiredRecord(body.detail, "detail") : {}),
        },
      };
      const snapshot = await ctx.port.appendEvent(runId, mutation);
      await audit(ctx, runId, {
        operation: "export-ready",
        requestId: mutation.requestId,
        workerInstanceId: mutation.workerInstanceId,
        resultingRevision: snapshot.revision,
        outcome: "ok",
      });
      return snapshot;
    }
    case "shutdown-ack": {
      assertMethod(method, "POST", operation);
      const reason = optionalString(body.reason, "reason", 2_000);
      const mutation = {
        ...mutationContext(body, credential.workerInstanceId),
        type: "worker.shutdown_acknowledged",
        detail: {
          workerInstanceId:
            optionalString(body.workerInstanceId, "workerInstanceId", 200) ??
            credential.workerInstanceId ??
            "unknown",
          ...(reason ? { reason } : {}),
        },
      };
      const snapshot = await ctx.port.appendEvent(runId, mutation);
      await audit(ctx, runId, {
        operation: "shutdown-ack",
        requestId: mutation.requestId,
        workerInstanceId: mutation.workerInstanceId,
        resultingRevision: snapshot.revision,
        outcome: "ok",
      });
      return snapshot;
    }
    default:
      throw new StateApiError(404, "not_found", `Unknown state API operation ${operation}`);
  }
}

/**
 * Bootstrap document for a starting worker (plan Phase 3): frozen config,
 * workspace identity, and current revision. Workspace identity is sanitized
 * of host filesystem paths — the worker only needs domain identity (kind,
 * base SHA, branch, volume/image identity, container-side workspace path).
 */
async function bootstrapDocument(
  ctx: WorkerStateApiContext,
  runId: string,
  workerInstanceId: string | undefined,
): Promise<Record<string, unknown>> {
  const projectConfig = ctx.getProjectConfig();
  const options = { runDirectory: ctx.store.runDirectory(runId) };
  const snapshot = await ctx.port.loadSnapshot(runId);
  const config = await loadRunConfig(projectConfig, runId, options)
    .then(sanitizeWorkerConfig)
    .catch(() => null);
  const workspace = await loadRunWorkspace(projectConfig, runId, options)
    .then(sanitizeWorkspaceIdentity)
    .catch(() => null);
  const sandboxIsolationPassed = await ctx.port
    .readArtifact(runId, { kind: "sandbox-probe" })
    .then((raw) => {
      if (!raw) return false;
      const stamp = JSON.parse(raw) as { ok?: boolean; unsupported?: boolean; imageDigest?: string };
      const imageDigest = workspace && "imageDigest" in workspace ? workspace.imageDigest : undefined;
      return stamp.ok === true && stamp.unsupported !== true && (!imageDigest || stamp.imageDigest === imageDigest);
    })
    .catch(() => false);
  return {
    runId,
    protocolVersion: RUN_STATE_API_PROTOCOL_VERSION,
    revision: snapshot.revision,
    ...(workerInstanceId ? { workerInstanceId } : {}),
    config,
    workspace,
    sandboxIsolationPassed,
  };
}

function sanitizeWorkerConfig(config: HarnessConfig): HarnessConfig {
  return {
    ...config,
    repositoryRoot: "/workspace",
    stateDirectory: "/tmp/agent-harness-state",
    knowledge: {
      ...config.knowledge,
      guidance: {
        ...config.knowledge.guidance,
        projectRoot: undefined,
        sharedRoot: undefined,
      },
    },
  };
}

/** Strip host filesystem paths from workspace metadata (ADR 0016 invariant 6). */
function sanitizeWorkspaceIdentity(workspace: RunWorkspace): Record<string, unknown> {
  const base: Record<string, unknown> = {
    version: workspace.version,
    kind: workspace.kind,
    createdAt: workspace.createdAt,
    ...(workspace.baseSha ? { baseSha: workspace.baseSha } : {}),
    ...(workspace.baseBranch ? { baseBranch: workspace.baseBranch } : {}),
    ...(workspace.branchName ? { branchName: workspace.branchName } : {}),
    ...(workspace.removedAt ? { removedAt: workspace.removedAt } : {}),
  };
  if (workspace.kind === "docker-clone") {
    return {
      ...base,
      containerName: workspace.containerName,
      workspaceVolumeName: workspace.workspaceVolumeName,
      workspacePath: workspace.workspacePath,
      imageDigest: workspace.imageDigest,
      seedBundleHash: workspace.seedBundleHash,
      generation: workspace.generation,
    };
  }
  return base;
}

/** Append one audit record; audit failures never mask the mutation result. */
async function audit(
  ctx: WorkerStateApiContext,
  runId: string,
  record: Omit<AuditRecord, "at" | "runId">,
): Promise<void> {
  try {
    const at = (ctx.now?.() ?? new Date()).toISOString();
    await ctx.store.appendJsonl(runId, WORKER_STATE_AUDIT_LOG, { at, runId, ...record });
  } catch {
    // Audit is best-effort; the port's own durability guarantees stand.
  }
}

function mutationContext(
  body: Record<string, unknown>,
  credentialWorkerInstanceId: string | undefined,
): MutationContext {
  const workerInstanceId = credentialWorkerInstanceId
    ? scopedWorkerInstanceId(body, credentialWorkerInstanceId)
    : optionalString(body.workerInstanceId, "workerInstanceId", 200);
  return {
    requestId: optionalString(body.requestId, "requestId", 200) ?? randomUUID(),
    idempotencyKey: requiredString(body.idempotencyKey, "idempotencyKey", 300),
    ...(workerInstanceId ? { workerInstanceId } : {}),
    ...(body.fencingToken !== undefined
      ? { fencingToken: requiredInteger(body.fencingToken, "fencingToken", 1) }
      : {}),
  };
}

function scopedWorkerInstanceId(
  body: Record<string, unknown>,
  credentialWorkerInstanceId: string | undefined,
): string {
  const presented = optionalString(body.workerInstanceId, "workerInstanceId", 200);
  if (credentialWorkerInstanceId && presented && presented !== credentialWorkerInstanceId) {
    throw new StateApiError(403, "forbidden", "Worker instance does not match the scoped credential");
  }
  return credentialWorkerInstanceId ?? requiredString(body.workerInstanceId, "workerInstanceId", 200);
}

function requiredTransition(value: unknown): TransitionResult {
  const record = requiredRecord(value, "transition");
  const state = requiredRecord(record.state, "transition.state");
  if (!Number.isInteger(state.revision)) {
    throw new StateApiError(400, "invalid_mutation", "transition.state.revision must be an integer");
  }
  if (record.events !== undefined && !Array.isArray(record.events)) {
    throw new StateApiError(400, "invalid_mutation", "transition.events must be an array");
  }
  // Deep validation happens in the store's schema parse; a malformed state
  // surfaces as invalid_mutation via the ZodError mapping.
  return {
    state: record.state,
    events: (record.events as TransitionResult["events"] | undefined) ?? [],
  } as TransitionResult;
}

function parseCasArtifacts(value: unknown): Array<{ ref: RunArtifactRef; contents: string }> {
  const items = requiredArray(value, "artifacts");
  return items.map((item, index) => {
    const record = requiredRecord(item, `artifacts[${index}]`);
    rejectRawPathFields(record);
    if (typeof record.contents !== "string") {
      throw new StateApiError(400, "bad_request", `artifacts[${index}].contents must be a string`);
    }
    return { ref: parseArtifactRef(record.ref), contents: record.contents };
  });
}

/**
 * Strictly parse a typed artifact reference. Unknown kinds, missing fields,
 * unexpected extra keys, and any raw `path`-style field are rejected: the
 * state API never accepts caller-selected host paths (ADR 0016 invariant 7).
 */
function parseArtifactRef(value: unknown): RunArtifactRef {
  const record = requiredRecord(value, "ref");
  rejectRawPathFields(record);
  const kind = record.kind;
  if (typeof kind !== "string") {
    throw new StateApiError(400, "invalid_artifact_ref", "ref.kind must be a string");
  }
  const idKinds = new Set([
    "packet",
    "packet-guidance",
    "packet-retrieval",
    "session",
    "session-steps",
    "issue",
    "tracker-task",
    "result-bundle-chunk",
  ]);
  if (idKinds.has(kind)) {
    assertOnlyKeys(record, ["kind", "id"], kind);
    return { kind: kind as RunArtifactRef["kind"], id: requiredIdentifier(record.id, "ref.id") } as RunArtifactRef;
  }
  if (kind === "document") {
    assertOnlyKeys(record, ["kind", "name"], kind);
    const name = requiredIdentifier(record.name, "ref.name");
    if (!RUN_DOCUMENT_NAMES.includes(name as (typeof RUN_DOCUMENT_NAMES)[number])) {
      throw new StateApiError(400, "invalid_artifact_ref", `Unknown run document: ${name}`, {
        name,
      });
    }
    return { kind: "document", name: name as (typeof RUN_DOCUMENT_NAMES)[number] };
  }
  if (kind === "task-artifact") {
    assertOnlyKeys(record, ["kind", "taskId", "name"], kind);
    return {
      kind: "task-artifact",
      taskId: requiredIdentifier(record.taskId, "ref.taskId"),
      name: requiredIdentifier(record.name, "ref.name"),
    };
  }
  if (
    kind === "install-log" ||
    kind === "activity" ||
    kind === "config" ||
    kind === "transport-import" ||
    kind === "result-manifest" ||
    kind === "sandbox-probe"
  ) {
    assertOnlyKeys(record, ["kind"], kind);
    return { kind };
  }
  throw new StateApiError(400, "invalid_artifact_ref", `Unknown artifact kind: ${kind}`, { kind });
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function requiredIdentifier(value: unknown, field: string): string {
  const text = requiredString(value, field, 300);
  if (!IDENTIFIER_PATTERN.test(text)) {
    throw new StateApiError(400, "invalid_artifact_ref", `Invalid artifact identifier for ${field}`, {
      field,
    });
  }
  return text;
}

/** Raw path fields are never accepted: artifacts are addressed by typed refs only. */
function rejectRawPathFields(record: Record<string, unknown>): void {
  for (const key of ["path", "paths", "hostPath", "absolutePath", "relativePath"]) {
    if (key in record) {
      throw new StateApiError(
        400,
        "invalid_artifact_ref",
        `Caller-selected paths are not accepted (field "${key}"); use a typed artifact ref`,
        { field: key },
      );
    }
  }
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: string[], kind: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new StateApiError(
        400,
        "invalid_artifact_ref",
        `Artifact kind "${kind}" does not accept field "${key}"`,
        { kind, field: key },
      );
    }
  }
}

function assertMethod(actual: string, expected: string, operation: string): void {
  if (actual !== expected) {
    throw new StateApiError(400, "bad_request", `${operation} requires ${expected}`);
  }
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StateApiError(400, "bad_request", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new StateApiError(400, "bad_request", `${field} must be an array`);
  }
  return value;
}

function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new StateApiError(400, "bad_request", `${field} is required`);
  }
  if (value.length > max) {
    throw new StateApiError(400, "bad_request", `${field} is too long`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (value == null || value === "") return undefined;
  return requiredString(value, field, max);
}

function requiredInteger(value: unknown, field: string, minimum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum) {
    throw new StateApiError(400, "bad_request", `${field} must be an integer >= ${minimum}`);
  }
  return Number(value);
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > RUN_STATE_API_MAX_BODY_BYTES) {
      throw new StateApiError(413, "body_too_large", "Request body is too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new StateApiError(400, "bad_request", "Request body must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StateApiError(400, "bad_request", "JSON body must be an object");
  }
  return parsed as Record<string, unknown>;
}

/** Map failures to the state API envelope; RunStateError codes pass through. */
function mapError(error: unknown): {
  status: number;
  code: RunStateApiErrorCode;
  message: string;
  details?: Record<string, unknown>;
} {
  if (error instanceof StateApiError) {
    return { status: error.status, code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof RunStateError) {
    return {
      status: statusForRunStateCode(error.code),
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }
  if (error instanceof ZodError) {
    return {
      status: 400,
      code: "invalid_mutation",
      message: "Mutation payload failed schema validation",
    };
  }
  return {
    status: 500,
    code: "internal",
    message: error instanceof Error ? error.message : String(error),
  };
}

function statusForRunStateCode(code: RunStateError["code"]): number {
  switch (code) {
    case "stale_revision":
    case "idempotency_conflict":
    case "lease_held":
    case "lease_required":
    case "lease_expired":
    case "stale_fencing_token":
      return 409;
    case "invalid_artifact_ref":
    case "invalid_mutation":
      return 400;
    case "artifact_too_large":
      return 413;
  }
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const raw = request.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(`${JSON.stringify(value)}\n`);
}
