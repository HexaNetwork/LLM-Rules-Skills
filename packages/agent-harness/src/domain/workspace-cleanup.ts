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

/**
 * Facts for Docker-clone cleanup (ADR 0015 §10).
 * Volume removal requires settled run, stopped worker, no active RPC,
 * no dirty unexported tree, and imported/reachable commits — or explicit discard.
 */
export type DockerCleanupFacts = {
  phase: RunPhase;
  workspaceKind: RunWorkspaceKind;
  alreadyRemoved: boolean;
  /** Worker container is stopped or absent. */
  workerStopped: boolean;
  /** Host still has an in-flight RPC / job against the worker. */
  activeRpc: boolean;
  /** Working tree dirty and result not yet exported/imported. */
  dirtyUnexportedTree: boolean;
  /**
   * Commits are durable on the host (import promoted / no-change / reachable
   * from a retained delivery ref) so the volume may be removed.
   */
  commitsImportedOrReachable: boolean;
  discard: boolean;
};

export type DockerCleanupDecision =
  | {
      allow: true;
      reason: "published-complete" | "discarded-unpublished" | "already-removed";
      /** When true, remove the named workspace volume as well as the container. */
      removeVolume: boolean;
    }
  | {
      allow: false;
      reason:
        | "not-docker-clone"
        | "run-not-settled"
        | "worker-still-running"
        | "active-rpc"
        | "dirty-unexported-tree"
        | "unpublished-requires-discard";
    };

/** Discriminated cleanup policy input (worktree vs docker-clone). */
export type WorkspaceCleanupFacts =
  | ({ kind: "git-worktree" } & Omit<WorktreeCleanupFacts, "workspaceKind">)
  | ({ kind: "docker-clone" } & Omit<DockerCleanupFacts, "workspaceKind">);

export type WorkspaceCleanupDecision =
  | ({ kind: "git-worktree" } & WorktreeCleanupDecision)
  | ({ kind: "docker-clone" } & DockerCleanupDecision);

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

/**
 * Conservative cleanup gate for Docker-clone runs.
 * Container stop is always part of an allowed cleanup; volume removal only when
 * durable import/publish (or discard) allows it.
 */
export function decideDockerCleanup(facts: DockerCleanupFacts): DockerCleanupDecision {
  if (facts.workspaceKind !== "docker-clone") {
    return { allow: false, reason: "not-docker-clone" };
  }
  if (facts.alreadyRemoved) {
    return { allow: true, reason: "already-removed", removeVolume: false };
  }
  if (!isCleanupSettledPhase(facts.phase)) {
    return { allow: false, reason: "run-not-settled" };
  }
  if (!facts.workerStopped) {
    return { allow: false, reason: "worker-still-running" };
  }
  if (facts.activeRpc) {
    return { allow: false, reason: "active-rpc" };
  }
  if (facts.dirtyUnexportedTree && !facts.discard) {
    return { allow: false, reason: "dirty-unexported-tree" };
  }

  if (facts.commitsImportedOrReachable) {
    return { allow: true, reason: "published-complete", removeVolume: true };
  }
  if (facts.discard) {
    return { allow: true, reason: "discarded-unpublished", removeVolume: true };
  }
  return { allow: false, reason: "unpublished-requires-discard" };
}

/** Kind-discriminated cleanup decision. */
export function decideWorkspaceCleanup(facts: WorkspaceCleanupFacts): WorkspaceCleanupDecision {
  if (facts.kind === "git-worktree") {
    return {
      kind: "git-worktree",
      ...decideWorktreeCleanup({ ...facts, workspaceKind: "git-worktree" }),
    };
  }
  return {
    kind: "docker-clone",
    ...decideDockerCleanup({ ...facts, workspaceKind: "docker-clone" }),
  };
}
