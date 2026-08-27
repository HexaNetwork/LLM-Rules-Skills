import type { Context } from "@deepseek-ai/cordis";
import { clearRoleAgent, readRoleAgents } from "../domain/role-agents.js";
import type { Run } from "../domain/types.js";
import { workingOn } from "../domain/working.js";

const CHARS_PER_TOKEN = 4;

export type InvokeRoleOptions = {
  /** Resume the persisted Cursor agent for this role (grill turns, same-task retries). Default false. */
  resumeAgent?: boolean;
};

export async function invokeRole(
  ctx: Context,
  run: Run,
  role: string,
  input: unknown,
  options: InvokeRoleOptions = {},
): Promise<unknown> {
  await ctx.store.writeProgress(
    run.identity.runId,
    workingOn(`Invoking ${role}`, { phase: run.state.phase, role }),
  );
  const context = await ctx.roleGuidance.compileRoleContext(role, {
    projectKey: run.identity.projectKey,
    maxCharacters: run.settings.budgets.guidanceTokens * CHARS_PER_TOKEN,
  });
  const resumeAgent = options.resumeAgent === true;
  if (!resumeAgent) clearRoleAgent(run, role);
  const roleAgents = readRoleAgents(run.state.artifacts);
  const packet = ctx.packets.build({
    role,
    runId: run.identity.runId,
    phase: run.state.phase,
    input,
    guidance: context.text,
    settings: run.settings,
    resumeAgentId: resumeAgent ? roleAgents[role] : undefined,
  });
  const output = await ctx.agents.invoke(role, packet);
  const state = await ctx.store.readState(run.identity.runId);
  if (state?.artifacts.roleAgents) {
    run.state.artifacts.roleAgents = state.artifacts.roleAgents;
  }
  return output;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}
