import type { AgentBackendResult } from "./types.js";

export function usageRecord(result: Partial<AgentBackendResult>): Record<string, number> | undefined {
  const usage = {
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheReadTokens: result.cacheReadTokens,
    cacheWriteTokens: result.cacheWriteTokens,
    totalTokens: reportedTotal(result),
    reasoningTokens: result.reasoningTokens,
  };
  const present = Object.entries(usage).filter(
    (entry): entry is [string, number] => typeof entry[1] === "number",
  );
  return present.length > 0 ? Object.fromEntries(present) : undefined;
}

/**
 * Derive a non-double-counted total. Cursor SDK usage reports inputTokens
 * inclusive of cache reads, yet its own totalTokens adds cacheReadTokens (and
 * cacheWriteTokens) on top, so the provider total is never trusted when the
 * input/output components are available.
 */
export function reportedTotal(
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined,
): number | undefined {
  if (typeof usage?.inputTokens !== "number" || typeof usage.outputTokens !== "number") {
    return usage?.totalTokens;
  }
  return usage.inputTokens + usage.outputTokens;
}
