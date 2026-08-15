import type {
  BuildTask,
  ProposedInstall,
  RunState,
  RunWorkspace,
} from "../domain.js";
import { CONFIG_FAILURE_PATTERN } from "../errors.js";

export type CancelResult = {
  state: RunState;
  pending: boolean;
};

export type CleanupResult = {
  state: RunState;
  removed: boolean;
  reason: string;
  retainedBranch?: string;
};

export type MigrateWorkspaceResult = {
  state: RunState;
  workspace: RunWorkspace;
};

export function pendingInstallApprovals(state: RunState): ProposedInstall[] {
  return state.proposedInstalls.filter((item) => !item.decision);
}

export function pendingGrillReady(state: RunState): RunState["grillReady"] | undefined {
  return state.grillReady;
}

export function pendingPlanReady(state: RunState): RunState["planReady"] | undefined {
  return state.planReady;
}

export function pendingVerificationReady(
  state: RunState,
): RunState["verificationReady"] | undefined {
  return state.verificationReady;
}

export function pendingVerificationBaselineReady(
  state: RunState,
): RunState["verificationBaselineReady"] | undefined {
  return state.verificationBaselineReady;
}

export function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

export function indexOfTaskForReportedPaths(state: RunState): number {
  const active = state.tasks.findIndex((task) => task.status === "active");
  if (active >= 0) return active;
  return state.tasks.findIndex((task) => task.status === "pending");
}

const DIRTY_TREE_PATH_LIMIT = 10;

export function dirtyTreeMessage(paths: string[]): string {
  const shown = paths.slice(0, DIRTY_TREE_PATH_LIMIT);
  const more = paths.length > shown.length ? ` (+${paths.length - shown.length} more)` : "";
  return `The working tree has uncommitted changes: ${shown.join(", ")}${more}. Commit or stash local changes in the repository, then retry the transition.`;
}

export type RepairRoute = "config-fixer" | "fixer";

/**
 * Deterministic recovery router: config-shaped failures always go to config-fixer
 * even when blockedKind is missing, stale, or misclassified as internal.
 */
export function repairRoute(input: {
  failure?: string;
  blockedKind?: string;
}): RepairRoute {
  if (input.blockedKind === "config") return "config-fixer";
  if (input.failure && CONFIG_FAILURE_PATTERN.test(input.failure)) return "config-fixer";
  return "fixer";
}

/** True when recovery should use the config-fixer (frozen snapshot patch), not a file fixer. */
export function isConfigFixerCandidate(blockedKind?: string, failure?: string): boolean {
  return repairRoute({ blockedKind, failure }) === "config-fixer";
}

const PACKET_DESCRIPTION_LIMIT = 2_000;
const PACKET_CRITERION_LIMIT = 500;

export function taskForPacket(task: BuildTask): Omit<BuildTask, "evidence"> {
  const { evidence: _evidence, ...rest } = task;
  return {
    ...rest,
    description: rest.description.slice(0, PACKET_DESCRIPTION_LIMIT),
    acceptanceCriteria: rest.acceptanceCriteria.map((item) =>
      item.slice(0, PACKET_CRITERION_LIMIT),
    ),
  };
}

export function normalizePathKey(filePath: string): string {
  return filePath.replaceAll("\\", "/").toLowerCase();
}

export const PROVIDER_RETRY_BACKOFF_MS = [1_000, 4_000, 16_000] as const;
export const CANCEL_LOCK_WAIT_MS = 5_000;
