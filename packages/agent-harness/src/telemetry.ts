import type { TurnRecord, UsageBreakdown, UsageReport } from "./types.js";

export function summarizeUsage(turns: readonly TurnRecord[]): UsageReport {
  const total = empty("all");
  const roles = new Map<string, UsageBreakdown>();
  const steps = new Map<string, UsageBreakdown>();
  for (const turn of turns) {
    add(total, turn);
    add(row(roles, turn.role || "unknown"), turn);
    add(row(steps, turn.stepId || "unknown"), turn);
  }
  const sorted = (values: Map<string, UsageBreakdown>) => [...values.values()].sort((a, b) => b.usage.totalTokens - a.usage.totalTokens || a.key.localeCompare(b.key));
  return { total, byRole: sorted(roles), byStep: sorted(steps) };
}

function row(rows: Map<string, UsageBreakdown>, key: string): UsageBreakdown {
  const found = rows.get(key);
  if (found) return found;
  const value = empty(key);
  rows.set(key, value);
  return value;
}

function empty(key: string): UsageBreakdown {
  return { key, sessions: 0, completedSessions: 0, failedSessions: 0, usageReportedSessions: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 } };
}

function add(target: UsageBreakdown, turn: TurnRecord): void {
  target.sessions += 1;
  if (turn.status === "completed") target.completedSessions += 1;
  if (turn.status === "blocked" || turn.status === "stalled") target.failedSessions += 1;
  if (!turn.usage) return;
  target.usageReportedSessions += 1;
  target.usage.inputTokens += turn.usage.inputTokens ?? 0;
  target.usage.outputTokens += turn.usage.outputTokens ?? 0;
  target.usage.totalTokens += turn.usage.totalTokens ?? ((turn.usage.inputTokens ?? 0) + (turn.usage.outputTokens ?? 0));
  target.usage.costUsd += turn.usage.costUsd ?? 0;
}
