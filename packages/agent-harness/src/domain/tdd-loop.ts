import type {
  BuildTask,
  GreenImplementerOutput,
  RedWriterOutput,
  TddCompletedRound,
  TddLoop,
  TddPendingRound,
} from "../domain.js";
import { TDD_GREEN_EVIDENCE_PURPOSE, TddLoopSchema } from "../domain.js";

export type TddGuardResult = { ok: true } | { ok: false; reason: string };

/** Apply schema defaults for a fresh or partial TDD loop ledger. */
export function createTddLoop(partial: Partial<TddLoop> = {}): TddLoop {
  return TddLoopSchema.parse(partial);
}

export function ensureTddLoop(task: BuildTask): TddLoop {
  return task.tddLoop ?? createTddLoop();
}

/** Valid RED `continue`: at least one dirty test path and no non-test dirty paths. */
export function canAcceptRedContinue(input: {
  output: Extract<RedWriterOutput, { status: "continue" }>;
  dirtyTestPaths: readonly string[];
  dirtyNonTestPaths: readonly string[];
}): TddGuardResult {
  if (input.output.changedFiles.length === 0) {
    return { ok: false, reason: "RED continue requires at least one changed file in the output" };
  }
  if (input.output.behaviorsAdded.length === 0) {
    return { ok: false, reason: "RED continue requires at least one behavior description" };
  }
  if (input.dirtyTestPaths.length === 0) {
    return { ok: false, reason: "RED continue requires at least one dirty test path" };
  }
  if (input.dirtyNonTestPaths.length > 0) {
    return {
      ok: false,
      reason: `RED continue may only change test paths; non-test dirty: ${input.dirtyNonTestPaths.join(", ")}`,
    };
  }
  return { ok: true };
}

/**
 * Valid RED `done`: verified-green checkpoint, at least one completed round, no pending round,
 * and no dirty worktree paths (agent must also report an empty changedFiles list).
 */
export function canAcceptRedDone(input: {
  output: Extract<RedWriterOutput, { status: "done" }>;
  tddLoop: TddLoop;
  dirtyPaths: readonly string[];
}): TddGuardResult {
  if (input.output.changedFiles.length > 0) {
    return { ok: false, reason: "RED done must not change any files" };
  }
  if (input.dirtyPaths.length > 0) {
    return {
      ok: false,
      reason: `RED done requires a clean worktree; dirty: ${input.dirtyPaths.join(", ")}`,
    };
  }
  if (!input.tddLoop.atVerifiedGreen) {
    return { ok: false, reason: "RED done is only valid at a verified-green checkpoint" };
  }
  if (input.tddLoop.pendingRound) {
    return { ok: false, reason: "RED done is not valid while a pending round remains open" };
  }
  if (input.tddLoop.completedRounds.length === 0) {
    return { ok: false, reason: "RED done requires at least one completed GREEN round" };
  }
  return { ok: true };
}

/**
 * Valid round completion after harness targeted GREEN verification passed for a green /
 * already_green claim with an open pending round.
 */
export function canCompleteTddRound(input: {
  output: Extract<GreenImplementerOutput, { status: "green" | "already_green" }>;
  tddLoop: TddLoop;
  targetedEvidencePassed: boolean;
}): TddGuardResult {
  if (!input.tddLoop.pendingRound) {
    return { ok: false, reason: "Round completion requires an open pending round" };
  }
  if (!input.targetedEvidencePassed) {
    return { ok: false, reason: "Round completion requires passed targeted GREEN evidence" };
  }
  if (input.output.status !== "green" && input.output.status !== "already_green") {
    return { ok: false, reason: "Round completion requires a green or already_green claim" };
  }
  return { ok: true };
}

/** Valid test_issue routing back to the red-writer for the current pending round. */
export function canRouteTestIssue(input: {
  output: Extract<GreenImplementerOutput, { status: "test_issue" }>;
  tddLoop: TddLoop;
}): TddGuardResult {
  if (!input.tddLoop.pendingRound) {
    return { ok: false, reason: "test_issue requires an open pending round" };
  }
  if (!input.output.testPath.trim()) {
    return { ok: false, reason: "test_issue requires a testPath" };
  }
  if (!input.output.reason.trim()) {
    return { ok: false, reason: "test_issue requires a reason" };
  }
  if (!input.output.evidence.trim()) {
    return { ok: false, reason: "test_issue requires evidence" };
  }
  return { ok: true };
}

/** Per-round GREEN attempt budget (`pendingRound.implementerAttempts` vs max). */
export function canRetryRoundImplementation(
  tddLoop: TddLoop | undefined,
  maxImplementationAttempts: number,
): boolean {
  const attempts = tddLoop?.pendingRound?.implementerAttempts ?? 0;
  return attempts < maxImplementationAttempts;
}

/** Increment the open pending round's implementer attempt counter. */
export function withIncrementedRoundImplementerAttempt(tddLoop: TddLoop): TddLoop {
  const pending = tddLoop.pendingRound;
  if (!pending) {
    throw new Error("Cannot increment implementer attempts without a pending round");
  }
  return {
    ...tddLoop,
    pendingRound: {
      ...pending,
      implementerAttempts: pending.implementerAttempts + 1,
    },
  };
}

/**
 * Flip the open pending round into test-repair mode without changing its number or
 * implementerAttempts (a completed GREEN round is what clears/advances the round).
 */
export function withTestRepairPendingRound(tddLoop: TddLoop): TddLoop {
  const pending = tddLoop.pendingRound;
  if (!pending) {
    throw new Error("Cannot enter test-repair mode without a pending round");
  }
  return {
    ...tddLoop,
    atVerifiedGreen: false,
    pendingRound: {
      ...pending,
      mode: "test-repair",
    },
  };
}

/** Record a completed GREEN round and open the next feature round counter. */
export function withCompletedTddRound(
  tddLoop: TddLoop,
  input: {
    outcome: TddCompletedRound["outcome"];
    completedAt: string;
    targetedEvidencePurpose?: string;
  },
): TddLoop {
  const pending = tddLoop.pendingRound;
  if (!pending) {
    throw new Error("Cannot complete a TDD round without a pending round");
  }
  const completed: TddCompletedRound = {
    number: pending.number,
    outcome: input.outcome,
    redCheckpointSha: pending.redCheckpointSha,
    testPathsAdded: pending.testPathsAdded,
    behaviorsAdded: pending.behaviorsAdded,
    edgeCasesAdded: pending.edgeCasesAdded,
    targetedEvidencePurpose: input.targetedEvidencePurpose ?? TDD_GREEN_EVIDENCE_PURPOSE,
    completedAt: input.completedAt,
  };
  const coverageBehaviors = uniqueStrings([
    ...tddLoop.coverage.behaviors,
    ...pending.behaviorsAdded,
  ]);
  const coverageEdgeCases = uniqueStrings([
    ...tddLoop.coverage.edgeCases,
    ...pending.edgeCasesAdded,
  ]);
  return {
    ...tddLoop,
    round: pending.number + 1,
    atVerifiedGreen: true,
    pendingRound: undefined,
    completedRounds: [...tddLoop.completedRounds, completed],
    coverage: {
      ...tddLoop.coverage,
      behaviors: coverageBehaviors,
      edgeCases: coverageEdgeCases,
    },
  };
}

/** Dedicated post-`done` final-repair budget (not the cumulative attempts.implementation). */
export function canRetryFinalRepair(
  tddLoop: TddLoop | undefined,
  maxImplementationAttempts: number,
): boolean {
  const attempts = tddLoop?.finalRepairAttempts ?? 0;
  return attempts < maxImplementationAttempts;
}

/** Route verify/review failure into a final production repair (budget + marker). */
export function withFinalRepairRouting(tddLoop: TddLoop): TddLoop {
  return {
    ...tddLoop,
    finalRepairPending: true,
    finalRepairAttempts: tddLoop.finalRepairAttempts + 1,
    atVerifiedGreen: false,
  };
}

/**
 * Clear the final-repair marker after a successful repair returns to RED.
 * Restores verified-green so RED may declare done again or add another batch.
 */
export function withFinalRepairCleared(tddLoop: TddLoop): TddLoop {
  return {
    ...tddLoop,
    finalRepairPending: false,
    atVerifiedGreen: true,
  };
}

/** Structured review routing: production → GREEN, test-coverage → RED. Never parse prose. */
export type ReviewRepairRoute = "production" | "test-coverage" | "none";

export function reviewRepairRoute(
  findings: ReadonlyArray<{
    severity: "blocking" | "advisory";
    kind: "production" | "test-coverage" | "advisory";
  }>,
): ReviewRepairRoute {
  const blocking = findings.filter((finding) => finding.severity === "blocking");
  if (blocking.some((finding) => finding.kind === "production")) {
    return "production";
  }
  if (blocking.some((finding) => finding.kind === "test-coverage")) {
    return "test-coverage";
  }
  // Unexpected blocking+advisory-kind: treat as production repair.
  if (blocking.length > 0) {
    return "production";
  }
  return "none";
}

/** Final verification is only valid after RED declared done at verified green. */
export function canEnterFinalVerification(tddLoop: TddLoop | undefined): TddGuardResult {
  const loop = tddLoop ?? createTddLoop();
  if (!loop.atVerifiedGreen) {
    return { ok: false, reason: "Final verification requires a verified-green checkpoint after RED done" };
  }
  if (loop.pendingRound) {
    return { ok: false, reason: "Final verification is not valid while a pending round remains open" };
  }
  if (loop.completedRounds.length === 0) {
    return { ok: false, reason: "Final verification requires at least one completed GREEN round" };
  }
  if (loop.finalRepairPending) {
    return { ok: false, reason: "Final verification is not valid while a final repair is pending" };
  }
  return { ok: true };
}

export function withGreenImplementerSession(
  tddLoop: TddLoop | undefined,
  session: TddLoop["greenImplementerSession"],
): TddLoop {
  return {
    ...(tddLoop ?? createTddLoop()),
    greenImplementerSession: session,
  };
}

export function withRedWriterSession(
  tddLoop: TddLoop | undefined,
  session: TddLoop["redWriterSession"],
): TddLoop {
  return {
    ...(tddLoop ?? createTddLoop()),
    redWriterSession: session,
  };
}

export function pendingRoundNumber(tddLoop: TddLoop | undefined): number {
  return tddLoop?.pendingRound?.number ?? tddLoop?.round ?? 1;
}

/** UI/CLI label for the active TDD worker or final-phase step. */
export function activeTddRoleLabel(task: BuildTask): string | undefined {
  if (!task.tdd) return undefined;
  switch (task.step) {
    case "writing_tests":
    case "red":
      return task.tddLoop?.pendingRound?.mode === "test-repair"
        ? "red-writer (test-repair)"
        : "red-writer";
    case "implementing":
      return task.tddLoop?.finalRepairPending ? "green-implementer (final-repair)" : "green-implementer";
    case "verifying":
      return "final-verification";
    case "reviewing":
      return "reviewer";
    case "committing":
      return "committing";
    default:
      return undefined;
  }
}

/** One-line status for CLI/dashboard: round, role, completed count, session turns. */
export function describeActiveTddStatus(task: BuildTask): string | undefined {
  if (!task.tdd || task.status === "pending") return undefined;
  const loop = task.tddLoop;
  const round = pendingRoundNumber(loop);
  const role = activeTddRoleLabel(task) ?? task.step;
  const completed = loop?.completedRounds.length ?? 0;
  const redTurns = loop?.redWriterSession?.turns ?? 0;
  const greenTurns = loop?.greenImplementerSession?.turns ?? 0;
  const parts = [
    `round ${round}`,
    role,
    `${completed} completed`,
    `red ${redTurns} turns`,
    `green ${greenTurns} turns`,
  ];
  if (loop?.atVerifiedGreen) parts.push("at verified green");
  if (loop?.pendingRound) {
    const behaviors = loop.pendingRound.behaviorsAdded.length;
    const edges = loop.pendingRound.edgeCasesAdded.length;
    if (behaviors || edges) parts.push(`batch ${behaviors} behaviors / ${edges} edge cases`);
  }
  return parts.join(" · ");
}

export type { TddPendingRound };

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}
