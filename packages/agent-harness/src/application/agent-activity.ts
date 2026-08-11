import type { AgentRole, RunPhase } from "../domain.js";

export const INVOCATION_KINDS = [
  "initial",
  "continuation",
  "implementation-repair",
  "test-repair",
  "review-repair",
  "schema-repair",
] as const;
export type InvocationKind = (typeof INVOCATION_KINDS)[number];

export type InvocationTrigger = {
  event: string;
  classification: string;
  summary: string;
  previousInvocationId?: string;
  evidenceFingerprint?: string;
};

export type InvocationUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
};

export type InvocationRecord = {
  path: string;
  sessionId: string;
  invocationId?: string;
  role?: string;
  model?: string;
  status?: string;
  attempt?: number;
  startedAt?: string;
  endedAt?: string;
  providerSessionId?: string;
  providerSessionReused?: boolean;
  usage?: InvocationUsage;
  handoff?: { summary?: string };
  error?: string;
  taskId?: string;
  phase?: RunPhase;
  taskStep?: string;
  invocationKind?: InvocationKind;
  trigger?: InvocationTrigger;
};

export type InvocationSummary = {
  path: string;
  sessionId: string;
  invocationId?: string;
  role?: string;
  model?: string;
  status?: string;
  attempt: number;
  contextTurn: number;
  startedAt?: string;
  endedAt?: string;
  providerSessionId?: string;
  providerSessionReused?: boolean;
  usage?: InvocationUsage;
  handoff?: { summary?: string };
  error?: string;
  taskId?: string;
  phase?: RunPhase;
  taskStep?: string;
  invocationKind?: InvocationKind;
  trigger?: InvocationTrigger;
  triggerSummary: string;
};

export type ProviderContextGroup = {
  id: string;
  role: AgentRole | "mixed" | string;
  model: string;
  startedAt: string;
  endedAt?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  invocationCount: number;
  schemaRepairCount: number;
  usage: Required<Pick<InvocationUsage, "inputTokens" | "outputTokens" | "totalTokens">> &
    InvocationUsage;
  invocations: InvocationSummary[];
};

export type AgentActivity = {
  providerContexts: ProviderContextGroup[];
  totals: {
    providerContexts: number;
    invocations: number;
    continuedInvocations: number;
    schemaRepairs: number;
  };
};

export const HISTORICAL_TRIGGER_SUMMARY = "Reason unavailable for historical invocation";

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function emptyUsage(): Required<Pick<InvocationUsage, "inputTokens" | "outputTokens" | "totalTokens">> &
  InvocationUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function addUsage(into: InvocationUsage, add: InvocationUsage | undefined): void {
  if (!add) return;
  into.inputTokens = asNumber(into.inputTokens) + asNumber(add.inputTokens);
  into.outputTokens = asNumber(into.outputTokens) + asNumber(add.outputTokens);
  into.cacheReadTokens = asNumber(into.cacheReadTokens) + asNumber(add.cacheReadTokens);
  into.cacheWriteTokens = asNumber(into.cacheWriteTokens) + asNumber(add.cacheWriteTokens);
  into.totalTokens = asNumber(into.totalTokens) + asNumber(add.totalTokens);
  if (add.costUsd != null || into.costUsd != null) {
    into.costUsd = asNumber(into.costUsd) + asNumber(add.costUsd);
  }
}

function contextStatus(
  orderedStatuses: Array<string | undefined>,
): ProviderContextGroup["status"] {
  if (orderedStatuses.some((status) => status === "running")) return "running";
  if (orderedStatuses.some((status) => status === "cancelled")) return "cancelled";
  // Prefer the chronologically latest outcome so schema-repair success settles the group.
  const latest = [...orderedStatuses].reverse().find((status) => status === "completed" || status === "failed");
  if (latest === "completed" || latest === "failed") return latest;
  if (orderedStatuses.some((status) => status === "failed")) return "failed";
  return "completed";
}

function triggerSummary(record: InvocationRecord): string {
  if (record.trigger?.summary?.trim()) return record.trigger.summary.trim();
  return HISTORICAL_TRIGGER_SUMMARY;
}

function contextKey(record: InvocationRecord): string {
  const providerId = typeof record.providerSessionId === "string" ? record.providerSessionId.trim() : "";
  if (providerId) return `provider:${providerId}`;
  return `synthetic:${record.sessionId}`;
}

function toSummary(record: InvocationRecord, contextTurn: number): InvocationSummary {
  return {
    path: record.path,
    sessionId: record.sessionId,
    invocationId: record.invocationId,
    role: record.role,
    model: record.model,
    status: record.status,
    attempt: typeof record.attempt === "number" ? record.attempt : 0,
    contextTurn,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    providerSessionId: record.providerSessionId,
    providerSessionReused: record.providerSessionReused,
    usage: record.usage,
    handoff: record.handoff,
    error: record.error,
    taskId: record.taskId,
    phase: record.phase,
    taskStep: record.taskStep,
    invocationKind: record.invocationKind,
    trigger: record.trigger,
    triggerSummary: triggerSummary(record),
  };
}

/**
 * Group flat invocation records into provider-context timeline rows.
 * Usage is summed once per invocation record; never roll context totals into run usage.
 */
export function buildAgentActivity(records: InvocationRecord[]): AgentActivity {
  const byContext = new Map<string, InvocationRecord[]>();
  for (const record of records) {
    const key = contextKey(record);
    const group = byContext.get(key);
    if (group) group.push(record);
    else byContext.set(key, [record]);
  }

  const providerContexts: ProviderContextGroup[] = [];
  let continuedInvocations = 0;
  let schemaRepairs = 0;

  for (const [key, group] of byContext) {
    const ordered = [...group].sort((a, b) =>
      String(a.startedAt ?? "").localeCompare(String(b.startedAt ?? "")),
    );
    const invocations = ordered.map((record, index) => toSummary(record, index + 1));
    const usage = emptyUsage();
    for (const invocation of invocations) {
      addUsage(usage, invocation.usage);
      if (invocation.providerSessionReused === true || invocation.invocationKind === "continuation") {
        continuedInvocations += 1;
      }
      if (
        invocation.invocationKind === "schema-repair" ||
        (invocation.attempt > 0 && invocation.invocationKind == null)
      ) {
        schemaRepairs += 1;
      }
    }

    const roles = [...new Set(invocations.map((item) => item.role).filter(Boolean))] as string[];
    const models = [...new Set(invocations.map((item) => item.model).filter(Boolean))] as string[];
    const startedAt = invocations[0]?.startedAt ?? "";
    const endedCandidates = invocations
      .map((item) => item.endedAt)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    const endedAt =
      endedCandidates.length === invocations.length
        ? endedCandidates.sort().at(-1)
        : undefined;

    providerContexts.push({
      id: key.startsWith("provider:") ? key.slice("provider:".length) : key,
      role: roles.length === 1 ? roles[0]! : roles.length > 1 ? "mixed" : "unknown",
      model: models.length === 1 ? models[0]! : models.join(", ") || "unknown",
      startedAt,
      endedAt,
      status: contextStatus(invocations.map((item) => item.status)), // chronological order
      invocationCount: invocations.length,
      schemaRepairCount: invocations.filter(
        (item) =>
          item.invocationKind === "schema-repair" ||
          (item.attempt > 0 && item.invocationKind == null),
      ).length,
      usage,
      invocations,
    });
  }

  // Newest provider contexts first so live monitoring surfaces latest activity.
  providerContexts.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  return {
    providerContexts,
    totals: {
      providerContexts: providerContexts.length,
      invocations: records.length,
      continuedInvocations,
      schemaRepairs,
    },
  };
}

export function parseInvocationRecord(
  path: string,
  value: Record<string, unknown>,
): InvocationRecord | null {
  const sessionId = typeof value.sessionId === "string" ? value.sessionId : undefined;
  if (!sessionId) return null;
  const triggerValue = value.trigger;
  const trigger =
    triggerValue && typeof triggerValue === "object" && !Array.isArray(triggerValue)
      ? (triggerValue as InvocationTrigger)
      : undefined;
  const kind = value.invocationKind;
  return {
    path,
    sessionId,
    invocationId: typeof value.invocationId === "string" ? value.invocationId : undefined,
    role: typeof value.role === "string" ? value.role : undefined,
    model: typeof value.model === "string" ? value.model : undefined,
    status: typeof value.status === "string" ? value.status : undefined,
    attempt: typeof value.attempt === "number" ? value.attempt : undefined,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : undefined,
    endedAt: typeof value.endedAt === "string" ? value.endedAt : undefined,
    providerSessionId:
      typeof value.providerSessionId === "string" ? value.providerSessionId : undefined,
    providerSessionReused:
      typeof value.providerSessionReused === "boolean" ? value.providerSessionReused : undefined,
    usage:
      value.usage && typeof value.usage === "object" && !Array.isArray(value.usage)
        ? (value.usage as InvocationUsage)
        : undefined,
    handoff:
      value.handoff && typeof value.handoff === "object" && !Array.isArray(value.handoff)
        ? (value.handoff as { summary?: string })
        : undefined,
    error: typeof value.error === "string" ? value.error : undefined,
    taskId: typeof value.taskId === "string" ? value.taskId : undefined,
    phase: typeof value.phase === "string" ? (value.phase as RunPhase) : undefined,
    taskStep: typeof value.taskStep === "string" ? value.taskStep : undefined,
    invocationKind:
      typeof kind === "string" && (INVOCATION_KINDS as readonly string[]).includes(kind)
        ? (kind as InvocationKind)
        : undefined,
    trigger,
  };
}
