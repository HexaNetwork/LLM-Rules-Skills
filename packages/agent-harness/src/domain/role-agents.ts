import type { Run } from "./types.js";

export type RoleAgents = Record<string, string>;

export function readRoleAgents(artifacts: Record<string, unknown>): RoleAgents {
  const raw = artifacts.roleAgents;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).flatMap(([role, agentId]) =>
      role && typeof agentId === "string" && agentId.trim() ? [[role, agentId.trim()]] : [],
    ),
  );
}

export function clearRoleAgent(run: Run, role: string): void {
  const roleAgents = readRoleAgents(run.state.artifacts);
  if (!roleAgents[role]) return;
  delete roleAgents[role];
  if (Object.keys(roleAgents).length === 0) {
    delete run.state.artifacts.roleAgents;
  } else {
    run.state.artifacts.roleAgents = roleAgents;
  }
}
