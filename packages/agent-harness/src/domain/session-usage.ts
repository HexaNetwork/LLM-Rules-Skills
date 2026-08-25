import type { AgentInvocation, TokenUsage, UsageCost } from "./types.js";

export type UsageBreakdownRow = {
  key: string;
  sessions: number;
  failedSessions: number;
  usageReportedSessions: number;
  costReportedSessions: number;
  usage: TokenUsage;
  cost: UsageCost;
};

export type SessionUsageReport = {
  total: UsageBreakdownRow;
  byModel: UsageBreakdownRow[];
  byAgentType: UsageBreakdownRow[];
};

export function summarizeSessionUsage(sessions: readonly AgentInvocation[]): SessionUsageReport {
  const total = emptyRow("all");
  const byModel = new Map<string, UsageBreakdownRow>();
  const byAgentType = new Map<string, UsageBreakdownRow>();

  for (const session of sessions) {
    addSession(total, session);
    addSession(rowFor(byModel, session.telemetry?.model ?? session.packet.model ?? "unknown"), session);
    addSession(rowFor(byAgentType, session.role || "unknown"), session);
  }

  return {
    total,
    byModel: [...byModel.values()].sort(compareRows),
    byAgentType: [...byAgentType.values()].sort(compareRows),
  };
}

function rowFor(rows: Map<string, UsageBreakdownRow>, key: string): UsageBreakdownRow {
  const current = rows.get(key);
  if (current) return current;
  const row = emptyRow(key);
  rows.set(key, row);
  return row;
}

function emptyRow(key: string): UsageBreakdownRow {
  return {
    key,
    sessions: 0,
    failedSessions: 0,
    usageReportedSessions: 0,
    costReportedSessions: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      reasoningTokens: 0,
    },
    cost: { rawCostCents: 0, chargedCents: 0 },
  };
}

function addSession(row: UsageBreakdownRow, session: AgentInvocation): void {
  row.sessions += 1;
  if (session.status === "failed") row.failedSessions += 1;
  const usage = session.telemetry?.usage;
  if (usage) {
    row.usageReportedSessions += 1;
    row.usage.inputTokens += usage.inputTokens;
    row.usage.outputTokens += usage.outputTokens;
    row.usage.cacheReadTokens += usage.cacheReadTokens;
    row.usage.cacheWriteTokens += usage.cacheWriteTokens;
    row.usage.totalTokens += usage.totalTokens;
    row.usage.reasoningTokens = (row.usage.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0);
  }
  const cost = session.telemetry?.cost;
  if (cost) {
    row.costReportedSessions += 1;
    row.cost.rawCostCents += cost.rawCostCents;
    row.cost.chargedCents += cost.chargedCents;
  }
}

function compareRows(a: UsageBreakdownRow, b: UsageBreakdownRow): number {
  return b.cost.chargedCents - a.cost.chargedCents || b.usage.totalTokens - a.usage.totalTokens || a.key.localeCompare(b.key);
}
