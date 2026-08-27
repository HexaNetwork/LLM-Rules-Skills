import type { Run, Task } from "./types.js";

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

/** Resume implementer only when retrying the same task after verification or review failure. */
export function shouldResumeImplementer(task: Task): boolean {
  return (task.attempts?.implementation ?? 0) > 0 || Boolean(task.reviewSummary?.trim());
}

/** Resume task-reviewer when re-reviewing after a rejection on the same task. */
export function shouldResumeTaskReviewer(task: Task): boolean {
  return (task.attempts?.review ?? 0) > 0;
}

/** Resume final reviewer when re-reviewing after an implementer repair pass. */
export function shouldResumeFinalReviewer(run: Run): boolean {
  return Number(run.state.artifacts.finalReviewAttempts ?? 0) > 0;
}
