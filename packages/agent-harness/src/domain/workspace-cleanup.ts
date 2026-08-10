import type { RunPhase } from "../domain.js";
import type { RunWorkspaceKind } from "./workspace.js";

/** Observable facts used to decide whether a run worktree may be removed. */
export type WorktreeCleanupFacts = {
  phase: RunPhase;
  workspaceKind: RunWorkspaceKind;
  alreadyRemoved: boolean;
  dirty: boolean;
  pathValid: boolean;
  registered: boolean;
  gitCommonDirMatches: boolean;
  /** HEAD (and its unique commits) are reachable from a retained named ref. */
  commitsReachableFromRetainedRef: boolean;
  hasRetainedNamedRef: boolean;
  /** Explicit operator confirmation to discard unpublished work. */
  discard: boolean;
};

export type WorktreeCleanupDecision =
  | { allow: true; reason: "published-complete" | "discarded-unpublished" | "already-removed" }
  | {
      allow: false;
      reason:
        | "not-git-worktree"
        | "run-not-settled"
        | "dirty-worktree"
        | "path-invalid"
        | "not-registered"
        | "git-common-dir-mismatch"
        | "unpublished-requires-discard";
    };

/** True when the run has finished (completed or cancelled), not merely blocked. */
export function isCleanupSettledPhase(phase: RunPhase): boolean {
  return phase === "completed" || phase === "cancelled";
}

/**
 * Conservative cleanup gate for per-run worktrees.
 * Does not mutate Git; callers gather facts then act only when `allow` is true.
 */
export function decideWorktreeCleanup(facts: WorktreeCleanupFacts): WorktreeCleanupDecision {
  if (facts.workspaceKind !== "git-worktree") {
    return { allow: false, reason: "not-git-worktree" };
  }
  if (facts.alreadyRemoved) {
    return { allow: true, reason: "already-removed" };
  }
  if (!isCleanupSettledPhase(facts.phase)) {
    return { allow: false, reason: "run-not-settled" };
  }
  if (!facts.pathValid) {
    return { allow: false, reason: "path-invalid" };
  }
  if (!facts.registered) {
    return { allow: false, reason: "not-registered" };
  }
  if (!facts.gitCommonDirMatches) {
    return { allow: false, reason: "git-common-dir-mismatch" };
  }
  if (facts.dirty) {
    return { allow: false, reason: "dirty-worktree" };
  }

  // Safe when HEAD has no unique commits, or those commits live on a retained ref
  // (delivery branch and/or base branch). Otherwise require explicit discard.
  if (facts.commitsReachableFromRetainedRef) {
    return { allow: true, reason: "published-complete" };
  }
  if (facts.discard) {
    return { allow: true, reason: "discarded-unpublished" };
  }
  return { allow: false, reason: "unpublished-requires-discard" };
}
