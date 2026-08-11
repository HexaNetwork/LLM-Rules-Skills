import type { AgentRole, RunPhase } from "../domain.js";
import { reviewRepairRoute } from "../domain/tdd-loop.js";

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

/** Compact role-specific result for timeline rows; never derived from prose in the UI. */
export type InvocationOutcome = {
  status?: string;
  summary?: string;
  blockingCount?: number;
  repairRoute?: string;
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
  outcome?: InvocationOutcome;
  /** Raw structured agent output; used only to backfill outcome for historical records. */
  output?: unknown;
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
  outcome?: InvocationOutcome;
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

export type ActivityTimelineEntry =
  | {
      type: "invocation";
      sequence: number;
      occurredAt: string;
      invocation: InvocationSummary;
    }
  | {
      type: "transition";
      sequence: number;
      occurredAt: string;
      event: string;
      eventSequence?: number;
      taskId?: string;
      round?: number;
      summary: string;
      status?: "passed" | "failed" | "blocking" | "completed";
      from?: string;
      to?: string;
      detail?: Record<string, unknown>;
    };

export type ActivityEventInput = {
  sequence: number;
  type: string;
  at: string;
  detail?: Record<string, unknown>;
};

export type AgentActivity = {
  timeline: ActivityTimelineEntry[];
  providerContexts: ProviderContextGroup[];
  totals: {
    providerContexts: number;
    invocations: number;
    continuedInvocations: number;
    schemaRepairs: number;
  };
};

export const HISTORICAL_TRIGGER_SUMMARY = "Reason unavailable for historical invocation";

/** Missing timestamps sort after dated entries so incomplete historical rows stay readable. */
const MISSING_TIMESTAMP_SORT_KEY = "\uffff";

const TIMELINE_TRANSITION_EVENTS = new Set([
  "task.gates_passed",
  "task.gates_failed",
  "task.tdd_round_started",
  "task.tdd_round_completed",
  "task.red_done",
  "task.green_observed",
  "task.redundant_green_skipped",
  "task.implementation_exhausted",
  "task.test_integrity_exhausted",
  "task.green_rejected",
  "task.test_issue_reported",
  "task.no_progress",
  "task.review_failed",
]);

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOutcome(value: unknown): InvocationOutcome | undefined {
  if (!isRecord(value)) return undefined;
  const outcome: InvocationOutcome = {};
  if (typeof value.status === "string") outcome.status = value.status;
  if (typeof value.summary === "string") outcome.summary = value.summary;
  if (typeof value.blockingCount === "number" && Number.isFinite(value.blockingCount)) {
    outcome.blockingCount = value.blockingCount;
  }
  if (typeof value.repairRoute === "string") outcome.repairRoute = value.repairRoute;
  return Object.keys(outcome).length > 0 ? outcome : undefined;
}

/**
 * Derive a compact outcome from structured agent output when the session record
 * predates the outcome field. Never used for browser-side prose parsing.
 */
export function deriveInvocationOutcome(
  role: string | undefined,
  output: unknown,
): InvocationOutcome | undefined {
  if (!isRecord(output)) return undefined;
  const summary = typeof output.summary === "string" ? output.summary : undefined;

  if (role === "red-writer" && typeof output.status === "string") {
    return { status: output.status, ...(summary ? { summary } : {}) };
  }

  if (role === "implementer" && typeof output.status === "string") {
    return { status: output.status, ...(summary ? { summary } : {}) };
  }

  if (role === "reviewer") {
    const findings = Array.isArray(output.findings) ? output.findings : [];
    const findingRows: Array<{
      severity: "blocking" | "advisory";
      kind: "production" | "test-coverage" | "advisory";
    }> = [];
    for (const finding of findings) {
      if (!isRecord(finding)) continue;
      const severity =
        finding.severity === "blocking" || finding.severity === "advisory"
          ? finding.severity
          : ("advisory" as const);
      const kind =
        finding.kind === "production" ||
        finding.kind === "test-coverage" ||
        finding.kind === "advisory"
          ? finding.kind
          : ("advisory" as const);
      findingRows.push({ severity, kind });
    }
    const blockingCount = findingRows.filter((finding) => finding.severity === "blocking").length;
    const approved = output.approved === true && blockingCount === 0;
    const route = reviewRepairRoute(findingRows);
    return {
      status: approved ? "approved" : "blocking",
      ...(summary ? { summary } : {}),
      blockingCount,
      ...(route !== "none" ? { repairRoute: route } : {}),
    };
  }

  if (typeof output.status === "string") {
    return { status: output.status, ...(summary ? { summary } : {}) };
  }
  if (typeof output.approved === "boolean") {
    return {
      status: output.approved ? "approved" : "blocking",
      ...(summary ? { summary } : {}),
    };
  }
  return summary ? { summary } : undefined;
}

/** Build outcome for a newly completed invocation at the write boundary. */
export function outcomeFromParsedOutput(
  role: string,
  parsed: unknown,
): InvocationOutcome | undefined {
  return deriveInvocationOutcome(role, parsed);
}

function resolveOutcome(record: InvocationRecord): InvocationOutcome | undefined {
  return record.outcome ?? deriveInvocationOutcome(record.role, record.output);
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
    outcome: resolveOutcome(record),
  };
}

type TimelineCandidate = {
  occurredAt: string;
  sortAt: string;
  /** Events use persisted sequence; invocations use a high offset plus stable path order. */
  tieBreak: number;
  stableKey: string;
  entry:
    | { type: "invocation"; invocation: InvocationSummary }
    | {
        type: "transition";
        event: string;
        eventSequence?: number;
        taskId?: string;
        round?: number;
        summary: string;
        status?: "passed" | "failed" | "blocking" | "completed";
        from?: string;
        to?: string;
        detail?: Record<string, unknown>;
      };
};

function detailString(detail: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = detail?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function detailNumber(detail: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = detail?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function routingTransition(
  event: ActivityEventInput,
  from: string,
  to: string,
  summary: string,
): TimelineCandidate {
  const detail = isRecord(event.detail) ? event.detail : {};
  return {
    occurredAt: event.at,
    sortAt: event.at || MISSING_TIMESTAMP_SORT_KEY,
    tieBreak: event.sequence,
    stableKey: `event:${event.sequence}:routing`,
    entry: {
      type: "transition",
      event: "routing",
      eventSequence: event.sequence,
      taskId: detailString(detail, "taskId"),
      summary,
      from,
      to,
      detail,
    },
  };
}

function transitionCandidates(event: ActivityEventInput): TimelineCandidate[] {
  if (!TIMELINE_TRANSITION_EVENTS.has(event.type)) return [];
  const detail = isRecord(event.detail) ? event.detail : {};
  const taskId = detailString(detail, "taskId");
  const round =
    detailNumber(detail, "round") ??
    detailNumber(detail, "number") ??
    (isRecord(detail.pendingRound) ? detailNumber(detail.pendingRound, "number") : undefined);
  const base = {
    occurredAt: event.at,
    sortAt: event.at || MISSING_TIMESTAMP_SORT_KEY,
    tieBreak: event.sequence,
    stableKey: `event:${event.sequence}`,
  };

  switch (event.type) {
    case "task.gates_passed":
      return [
        {
          ...base,
          entry: {
            type: "transition",
            event: event.type,
            eventSequence: event.sequence,
            taskId,
            summary: "Final gates",
            status: "passed",
            detail,
          },
        },
      ];
    case "task.gates_failed": {
      const rows: TimelineCandidate[] = [
        {
          ...base,
          entry: {
            type: "transition",
            event: event.type,
            eventSequence: event.sequence,
            taskId,
            summary: "Final gates",
            status: "failed",
            detail,
          },
        },
      ];
      if (detail.finalRepairPending === true) {
        rows.push({
          ...routingTransition(event, "verification", "GREEN", "verification → GREEN final repair"),
          tieBreak: event.sequence + 0.5,
        });
      }
      return rows;
    }
    case "task.review_failed": {
      const route = detailString(detail, "reviewRepairRoute");
      if (route === "production") {
        return [routingTransition(event, "production", "GREEN", "production → GREEN")];
      }
      if (route === "test-coverage") {
        return [routingTransition(event, "GREEN", "RED", "GREEN → RED reassessment")];
      }
      if (detail.finalRepairPending === true) {
        return [routingTransition(event, "review", "GREEN", "review → GREEN final repair")];
      }
      return [
        {
          ...base,
          entry: {
            type: "transition",
            event: event.type,
            eventSequence: event.sequence,
            taskId,
            summary: "Review blocking",
            status: "blocking",
            detail,
          },
        },
      ];
    }
    case "task.tdd_round_started":
      return [
        {
          ...base,
          entry: {
            type: "transition",
            event: event.type,
            eventSequence: event.sequence,
            taskId,
            round,
            summary: round != null ? `TDD round ${round} started` : "TDD round started",
            detail,
          },
        },
      ];
    case "task.tdd_round_completed":
      return [
        {
          ...base,
          entry: {
            type: "transition",
            event: event.type,
            eventSequence: event.sequence,
            taskId,
            round,
            summary: round != null ? `TDD round ${round} completed` : "TDD round completed",
            status: "completed",
            detail,
          },
        },
      ];
    case "task.red_done":
      return [
        {
          ...base,
          entry: {
            type: "transition",
            event: event.type,
            eventSequence: event.sequence,
            taskId,
            summary: "RED completion declared",
            status: "completed",
            detail,
          },
        },
      ];
    case "task.green_observed": {
      if (detail.finalRepair === true) {
        return [routingTransition(event, "GREEN", "RED", "GREEN → RED reassessment")];
      }
      return [];
    }
    case "task.redundant_green_skipped":
      return [
        {
          ...base,
          entry: {
            type: "transition",
            event: event.type,
            eventSequence: event.sequence,
            taskId,
            summary: "Redundant GREEN invocation skipped",
            detail,
          },
        },
      ];
    case "task.implementation_exhausted":
    case "task.test_integrity_exhausted":
      return [
        {
          ...base,
          entry: {
            type: "transition",
            event: event.type,
            eventSequence: event.sequence,
            taskId,
            summary: "Repair budget exhausted",
            status: "failed",
            detail,
          },
        },
      ];
    case "task.green_rejected":
      return [
        {
          ...base,
          entry: {
            type: "transition",
            event: event.type,
            eventSequence: event.sequence,
            taskId,
            summary: "GREEN claim rejected",
            status: "failed",
            detail,
          },
        },
      ];
    case "task.test_issue_reported":
      return [
        {
          ...base,
          entry: {
            type: "transition",
            event: event.type,
            eventSequence: event.sequence,
            taskId,
            summary: "Test issue reported → RED",
            from: "GREEN",
            to: "RED",
            detail,
          },
        },
      ];
    case "task.no_progress":
      return [
        {
          ...base,
          entry: {
            type: "transition",
            event: event.type,
            eventSequence: event.sequence,
            taskId,
            summary: "No progress detected",
            status: "failed",
            detail,
          },
        },
      ];
    default:
      return [];
  }
}

function buildTimeline(
  summariesByPath: Map<string, InvocationSummary>,
  records: InvocationRecord[],
  events: ActivityEventInput[],
): ActivityTimelineEntry[] {
  const invocationOrder = [...records].sort((a, b) => {
    const at = String(a.startedAt ?? MISSING_TIMESTAMP_SORT_KEY).localeCompare(
      String(b.startedAt ?? MISSING_TIMESTAMP_SORT_KEY),
    );
    if (at !== 0) return at;
    return a.path.localeCompare(b.path);
  });

  const candidates: TimelineCandidate[] = [];
  invocationOrder.forEach((record, index) => {
    const summary = summariesByPath.get(record.path);
    if (!summary) return;
    const occurredAt = record.startedAt ?? record.endedAt ?? "";
    candidates.push({
      occurredAt,
      sortAt: occurredAt || MISSING_TIMESTAMP_SORT_KEY,
      // Keep invocations after same-timestamp events with real sequences when needed;
      // path order among invocations is the deterministic fallback.
      tieBreak: 1_000_000_000 + index,
      stableKey: `invocation:${record.path}`,
      entry: { type: "invocation", invocation: summary },
    });
  });

  for (const event of events) {
    candidates.push(...transitionCandidates(event));
  }

  candidates.sort((a, b) => {
    const byTime = a.sortAt.localeCompare(b.sortAt);
    if (byTime !== 0) return byTime;
    if (a.tieBreak !== b.tieBreak) return a.tieBreak - b.tieBreak;
    return a.stableKey.localeCompare(b.stableKey);
  });

  return candidates.map((candidate, index) => {
    const sequence = index + 1;
    if (candidate.entry.type === "invocation") {
      return {
        type: "invocation" as const,
        sequence,
        occurredAt: candidate.occurredAt,
        invocation: candidate.entry.invocation,
      };
    }
    return {
      type: "transition" as const,
      sequence,
      occurredAt: candidate.occurredAt,
      event: candidate.entry.event,
      eventSequence: candidate.entry.eventSequence,
      taskId: candidate.entry.taskId,
      round: candidate.entry.round,
      summary: candidate.entry.summary,
      status: candidate.entry.status,
      from: candidate.entry.from,
      to: candidate.entry.to,
      detail: candidate.entry.detail,
    };
  });
}

/**
 * Group flat invocation records into provider-context timeline rows, and build a
 * globally chronological execution sequence from invocations plus selected events.
 * Usage is summed once per invocation record; never roll context totals into run usage.
 * Transition rows do not affect invocation or token totals.
 */
export function buildAgentActivity(
  records: InvocationRecord[],
  events: ActivityEventInput[] = [],
): AgentActivity {
  const byContext = new Map<string, InvocationRecord[]>();
  for (const record of records) {
    const key = contextKey(record);
    const group = byContext.get(key);
    if (group) group.push(record);
    else byContext.set(key, [record]);
  }

  const providerContexts: ProviderContextGroup[] = [];
  const summariesByPath = new Map<string, InvocationSummary>();
  let continuedInvocations = 0;
  let schemaRepairs = 0;

  for (const [key, group] of byContext) {
    const ordered = [...group].sort((a, b) =>
      String(a.startedAt ?? "").localeCompare(String(b.startedAt ?? "")),
    );
    const invocations = ordered.map((record, index) => toSummary(record, index + 1));
    for (const invocation of invocations) {
      summariesByPath.set(invocation.path, invocation);
    }
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
    timeline: buildTimeline(summariesByPath, records, events),
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
  const outcome = parseOutcome(value.outcome);
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
    outcome,
    output: value.output,
  };
}
