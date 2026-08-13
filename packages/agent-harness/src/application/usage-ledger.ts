import { reportedTotal } from "../infrastructure/agents/usage.js";
import type { RunState } from "../domain.js";
import type { ApplicationContext } from "./application-context.js";

/** Recompute run usage from durable session records and persist the aggregate. */
export async function accrueRunUsage(
  ctx: ApplicationContext,
  state: RunState,
): Promise<RunState> {
  const files = (await ctx.store.listFiles(state.runId, "sessions")).filter((file) =>
    file.endsWith(".json"),
  );
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalTokens = 0;
  let costUsd = 0;
  let costIsLowerBound = false;
  let sessionsRead = 0;
  let invocations = 0;

  for (const file of files) {
    let session: {
      model?: string;
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        totalTokens?: number;
      };
    };
    try {
      session = (await ctx.store.readJson(state.runId, file)) as typeof session;
    } catch {
      // Concurrently-written or partial files must not fail accrual.
      continue;
    }
    sessionsRead += 1;
    invocations += 1;
    const usage = session.usage ?? {};
    const input = Number(usage.inputTokens ?? 0);
    const output = Number(usage.outputTokens ?? 0);
    const cacheRead = Number(usage.cacheReadTokens ?? 0);
    const cacheWrite = Number(usage.cacheWriteTokens ?? 0);
    const total = reportedTotal(usage) ?? 0;
    inputTokens += input;
    outputTokens += output;
    cacheReadTokens += cacheRead;
    cacheWriteTokens += cacheWrite;
    totalTokens += total;

    const model = typeof session.model === "string" ? session.model : "";
    const pricing = model ? ctx.config.models.pricing[model] : undefined;
    if (!pricing) {
      if (input > 0 || output > 0 || total > 0) costIsLowerBound = true;
      continue;
    }
    costUsd +=
      (input / 1_000_000) * pricing.inputPerMillion +
      (output / 1_000_000) * pricing.outputPerMillion +
      (cacheRead / 1_000_000) * pricing.cacheReadPerMillion +
      (cacheWrite / 1_000_000) * pricing.cacheWritePerMillion;
  }

  const nextUsage = {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    costUsd,
    costIsLowerBound,
    invocations,
    sessionsRead,
  };
  if (
    state.usage.inputTokens === nextUsage.inputTokens &&
    state.usage.outputTokens === nextUsage.outputTokens &&
    state.usage.cacheReadTokens === nextUsage.cacheReadTokens &&
    state.usage.cacheWriteTokens === nextUsage.cacheWriteTokens &&
    state.usage.totalTokens === nextUsage.totalTokens &&
    state.usage.costUsd === nextUsage.costUsd &&
    state.usage.costIsLowerBound === nextUsage.costIsLowerBound &&
    state.usage.invocations === nextUsage.invocations &&
    state.usage.sessionsRead === nextUsage.sessionsRead
  ) {
    return state;
  }
  return ctx.store.writeState({ ...state, usage: nextUsage });
}
