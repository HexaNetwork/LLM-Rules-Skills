import path from "node:path";
import {
  RunEventSchema,
  RunStateSchema,
  type RunEvent,
  type RunState,
  type TaskRuntimeState,
} from "../schemas/reports.js";
import type { RunManifest } from "../schemas/manifest.js";
import type { RunStatus, TaskStatus, BlockedReason } from "../schemas/common.js";
import { appendJsonl, ensureDir, readJson, writeJson } from "../util/fs.js";
import { sha256Json } from "../util/hash.js";

export function createInitialRunState(
  runId: string,
  manifest: RunManifest,
): RunState {
  const now = new Date().toISOString();
  return {
    contractVersion: "1",
    runId,
    status: "approved",
    createdAt: now,
    updatedAt: now,
    manifestHash: manifest.manifestHash,
    tasks: manifest.taskOrder.map((taskId) => ({
      taskId,
      status: "pending" as TaskStatus,
      commandRepairsUsed: 0,
      reviewRepairsUsed: 0,
      lastGateResults: [],
      advisories: [],
    })),
    finalBranchRepairsUsed: 0,
    cost: { inputTokens: 0, outputTokens: 0, agentLaunches: 0 },
    events: [],
  };
}

export function runDir(base: string, runId: string): string {
  return path.join(base, runId);
}

export async function persistRunState(
  directory: string,
  state: RunState,
): Promise<void> {
  const parsed = RunStateSchema.parse(state);
  await ensureDir(directory);
  await writeJson(path.join(directory, "state.json"), parsed);
  await writeJson(path.join(directory, "snapshot.json"), {
    ...parsed,
    snapshotHash: await sha256Json(parsed),
  });
}

export async function loadRunState(directory: string): Promise<RunState> {
  const raw = await readJson<unknown>(path.join(directory, "state.json"));
  return RunStateSchema.parse(raw);
}

export async function appendEvent(
  directory: string,
  state: RunState,
  event: {
    type: string;
    taskId?: string;
    detail?: Record<string, unknown>;
    at?: string;
  },
): Promise<RunState> {
  const full = RunEventSchema.parse({
    at: event.at ?? new Date().toISOString(),
    type: event.type,
    taskId: event.taskId,
    detail: event.detail ?? {},
  });
  const next: RunState = {
    ...state,
    updatedAt: full.at,
    events: [...state.events, full],
  };
  await appendJsonl(path.join(directory, "events.jsonl"), full);
  await persistRunState(directory, next);
  return next;
}

export function getTaskState(
  state: RunState,
  taskId: string,
): TaskRuntimeState {
  const task = state.tasks.find((item) => item.taskId === taskId);
  if (!task) throw new Error(`Unknown task ${taskId}`);
  return task;
}

export function updateTaskState(
  state: RunState,
  taskId: string,
  patch: Partial<TaskRuntimeState>,
): RunState {
  return {
    ...state,
    updatedAt: new Date().toISOString(),
    tasks: state.tasks.map((task) =>
      task.taskId === taskId ? { ...task, ...patch } : task,
    ),
  };
}

export function setRunStatus(state: RunState, status: RunStatus): RunState {
  return { ...state, status, updatedAt: new Date().toISOString() };
}

export function blockTask(
  state: RunState,
  taskId: string,
  reason: BlockedReason,
  detail: string,
): RunState {
  return updateTaskState(state, taskId, {
    status: reason === "BLOCKED_DEPENDENCY" ? "blocked_dependency" : "blocked",
    blockedReason: reason,
    blockedDetail: detail,
  });
}

export function assertResumeInvariants(input: {
  state: RunState;
  manifestHash: string;
  worktreePath?: string;
  branchName?: string;
  headSha?: string;
}): void {
  if (input.state.manifestHash !== input.manifestHash) {
    throw new Error("RESUME_INVARIANT: manifest hash mismatch");
  }
  if (
    input.state.worktreePath &&
    input.worktreePath &&
    path.resolve(input.state.worktreePath) !== path.resolve(input.worktreePath)
  ) {
    throw new Error("RESUME_INVARIANT: worktree path mismatch");
  }
  if (
    input.state.branchName &&
    input.branchName &&
    input.state.branchName !== input.branchName
  ) {
    throw new Error("RESUME_INVARIANT: branch mismatch");
  }
  if (input.state.headSha && input.headSha && input.state.headSha !== input.headSha) {
    throw new Error("RESUME_INVARIANT: HEAD mismatch");
  }
}
