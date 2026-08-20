import type { Context } from "@deepseek-ai/cordis";
import { assignmentFor } from "../domain/agent-roles.js";
import type { Run } from "../domain/types.js";
import { workingOn } from "../domain/working.js";

const CHARS_PER_TOKEN = 4;

export async function invokeRole(
  ctx: Context,
  run: Run,
  role: string,
  input: unknown,
): Promise<unknown> {
  await ctx.store.writeProgress(
    run.identity.runId,
    workingOn(`Invoking ${role}`, { phase: run.state.phase, role }),
  );
  const assignment = assignmentFor(run.settings.guidance.assignments, role);
  const pack = await ctx.knowledge.compileRoleGuidancePack({
    assignment,
    maxCharacters: run.settings.budgets.guidanceTokens * CHARS_PER_TOKEN,
    extraPaths: run.settings.guidance.extraPaths,
  });
  const packet = ctx.packets.build({
    role,
    runId: run.identity.runId,
    phase: run.state.phase,
    input,
    guidance: pack.text,
    settings: run.settings,
  });
  return ctx.agents.invoke(role, packet);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}
