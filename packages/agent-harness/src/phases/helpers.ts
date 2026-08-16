import type { Context } from "@deepseek-ai/cordis";
import type { Run } from "../domain/types.js";

export async function invokeRole(
  ctx: Context,
  run: Run,
  role: string,
  input: unknown,
): Promise<unknown> {
  const hits = await ctx.knowledge.search(run.state.idea, run.settings.guidance.extraPaths);
  const packet = ctx.packets.build({
    role,
    runId: run.identity.runId,
    phase: run.state.phase,
    input,
    guidance: hits.map((hit) => hit.excerpt).join("\n\n"),
    settings: run.settings,
  });
  return ctx.agents.invoke(role, packet);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}
