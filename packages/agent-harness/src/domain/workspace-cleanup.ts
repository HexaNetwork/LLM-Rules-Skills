import type { RunPhase } from "../domain.js";
import type { RunWorkspaceKind } from "./workspace.js";

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

/** Cleanup policy input for the production Docker workspace. */
export type WorkspaceCleanupFacts =
  { kind: "docker-clone" } & Omit<DockerCleanupFacts, "workspaceKind">;

export type WorkspaceCleanupDecision =
  { kind: "docker-clone" } & DockerCleanupDecision;

/** True when the run has finished (completed or cancelled), not merely blocked. */
export function isCleanupSettledPhase(phase: RunPhase): boolean {
  return phase === "completed" || phase === "cancelled";
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
  return {
    kind: "docker-clone",
    ...decideDockerCleanup({ ...facts, workspaceKind: "docker-clone" }),
  };
}
