import path from "node:path";
import { HarnessFailure } from "../errors.js";
import { matchesGlob } from "../knowledge.js";
import type { BuildTask, RunPhase, RunState } from "../domain.js";

/** Phases that reject normal workflow advancement. */
export function isTerminalPhase(phase: RunPhase): boolean {
  return phase === "completed" || phase === "blocked" || phase === "cancelled";
}

/** Throws when the run cannot accept a normal advancement transition. */
export function assertCanAdvance(state: RunState): void {
  if (isTerminalPhase(state.phase)) {
    throw new Error(
      `Run ${state.runId} cannot advance from terminal phase ${state.phase}`,
    );
  }
}

/** True when a blocked run has enough context to clear the block. */
export function canClearBlock(state: RunState): boolean {
  return state.phase === "blocked" && state.blockedFrom != null;
}

/** Clear blocked-* fields and resume at `phase`. */
export function clearBlock(state: RunState, phase: RunPhase): RunState {
  return {
    ...state,
    phase,
    blockedFrom: undefined,
    failure: undefined,
    blockedKind: undefined,
    blockedRetriable: undefined,
  };
}

/** Pending tasks whose blockers are all done, sorted by id. */
export function taskFrontier(tasks: BuildTask[]): BuildTask[] {
  const done = new Set(tasks.filter((task) => task.status === "done").map((task) => task.id));
  return tasks
    .filter(
      (task) => task.status === "pending" && task.blockedBy.every((blocker) => done.has(blocker)),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Validate dependency graph completeness and acyclicity. */
export function assertAcyclic(items: Array<{ id: string; blockedBy: string[] }>): void {
  const ids = new Set(items.map((item) => item.id));
  for (const item of items) {
    for (const blocker of item.blockedBy) {
      if (!ids.has(blocker)) {
        throw new HarnessFailure(
          `${item.id} references unknown blocker ${blocker}`,
          "internal",
          false,
        );
      }
      if (blocker === item.id) {
        throw new HarnessFailure(`${item.id} cannot block itself`, "internal", false);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(items.map((item) => [item.id, item] as const));
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new HarnessFailure(`Dependency cycle includes ${id}`, "internal", false);
    }
    visiting.add(id);
    for (const blocker of byId.get(id)?.blockedBy ?? []) visit(blocker);
    visiting.delete(id);
    visited.add(id);
  };
  for (const item of items) visit(item.id);
}

/**
 * Before execution, dependencies must be acyclic and every pending task must
 * eventually become frontier-reachable (no stuck incomplete blockers).
 */
export function assertDependenciesExecutable(tasks: BuildTask[]): void {
  assertAcyclic(tasks);
  const pending = tasks.filter((task) => task.status === "pending" || task.status === "active");
  if (pending.length === 0) return;
  if (taskFrontier(tasks).length === 0 && !tasks.some((task) => task.status === "active")) {
    throw new HarnessFailure(
      "Build frontier is empty while pending tasks remain",
      "internal",
      false,
    );
  }
}

/** Operator may toggle TDD only before the task starts. */
export function canToggleTaskTdd(task: BuildTask): boolean {
  return task.status === "pending" && task.step === "pending";
}

export function isTddEligible(task: BuildTask): boolean {
  return task.tdd === true;
}

export function isTestPath(filePath: string, patterns: readonly string[]): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  return patterns.some((pattern) => matchesGlob(pattern, normalized));
}

export function isSourcePath(filePath: string, extensions: readonly string[]): boolean {
  const allowed = new Set(extensions.map((ext) => ext.toLowerCase()));
  const normalized = filePath.replaceAll("\\", "/");
  return allowed.has(path.extname(normalized).toLowerCase());
}

export function includesSourcePath(paths: string[], extensions: readonly string[]): boolean {
  return paths.some((filePath) => isSourcePath(filePath, extensions));
}

export type AttemptBudgets = {
  maxTestAttempts: number;
  maxImplementationAttempts: number;
  maxReviewAttempts: number;
};

export function canRetryTests(task: BuildTask, budgets: AttemptBudgets): boolean {
  return task.attempts.tests < budgets.maxTestAttempts;
}

export function canRetryImplementation(task: BuildTask, budgets: AttemptBudgets): boolean {
  return task.attempts.implementation < budgets.maxImplementationAttempts;
}

export function canRetryReview(task: BuildTask, budgets: AttemptBudgets): boolean {
  return (
    task.attempts.review < budgets.maxReviewAttempts &&
    task.attempts.implementation < budgets.maxImplementationAttempts
  );
}

/** True when any open question exists (at most one batch may be open). */
export function hasOpenQuestionBatch(state: RunState): boolean {
  return state.questions.some((question) => question.status === "open");
}

/**
 * A task may be marked done only after review approval (committing step) and
 * required verification command evidence.
 */
export function canMarkTaskDone(task: BuildTask): boolean {
  if (task.status === "done" && task.step === "done") return true;
  if (task.step !== "committing") return false;
  const requiredPurpose = task.tdd ? "tdd:green" : "test";
  return task.evidence.some((item) => item.purpose === requiredPurpose && item.passed);
}

export function assertCanMarkTaskDone(task: BuildTask): void {
  if (!canMarkTaskDone(task)) {
    throw new Error(
      `Task ${task.id} cannot be marked done before review approval and required command evidence`,
    );
  }
}
