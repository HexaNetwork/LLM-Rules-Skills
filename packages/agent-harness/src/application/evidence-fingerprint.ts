import { createHash } from "node:crypto";
import type { BuildTask, CommandEvidence } from "../domain.js";

export type EvidenceFingerprintInput = {
  taskId: string;
  step: BuildTask["step"];
  sourceTreeState: string;
  redCheckpointSha?: string;
  failingTestIds: string[];
  failureCategory: string;
  reviewFinding?: string;
  frozenConfigHash?: string;
};

/** Canonical hash of the evidence that would justify another repair invocation. */
export function evidenceFingerprint(input: EvidenceFingerprintInput): string {
  const payload = [
    input.taskId,
    input.step,
    input.sourceTreeState,
    input.redCheckpointSha ?? "",
    [...input.failingTestIds].map((id) => id.trim()).filter(Boolean).sort().join("\n"),
    input.failureCategory,
    (input.reviewFinding ?? "").trim(),
    input.frozenConfigHash ?? "",
  ].join("\0");
  return createHash("sha256").update(payload).digest("hex");
}

export function failureCategoryFromEvidence(
  evidence: CommandEvidence | undefined,
  fallback = "verification",
): string {
  if (!evidence) return fallback;
  const output = `${evidence.stdout}\n${evidence.stderr}`;
  if (/command not found|not recognized|ENOENT/i.test(output)) return "config";
  if (/SyntaxError|TS\d+|cannot find module|Compilation failed/i.test(output)) {
    return /tests?[\\/]|\.test\.|\.spec\./i.test(output) ? "test-repair" : "verification";
  }
  if (/baseline|known failure/i.test(output)) return "baseline";
  if (evidence.exitCode !== 0) return "verification";
  return fallback;
}

export function failingTestIdsFromEvidence(evidence: CommandEvidence | undefined): string[] {
  if (!evidence) return [];
  const output = `${evidence.stdout}\n${evidence.stderr}`;
  const ids = new Set<string>();
  for (const match of output.matchAll(/(?:FAIL|✗|×)\s+([^\n]+)/g)) {
    const value = match[1]?.trim();
    if (value) ids.add(value.slice(0, 200));
  }
  if (ids.size === 0 && evidence.exitCode !== 0) {
    ids.add(`${evidence.purpose}:${evidence.exitCode}`);
  }
  return [...ids];
}

export function repairEdgeKey(
  fingerprint: string,
  fromRole: string,
  toRole: string,
): string {
  return `${fingerprint}:${fromRole}->${toRole}`;
}

export type ProgressGateResult =
  | { allowed: true; fingerprint: string }
  | {
      allowed: false;
      fingerprint: string;
      reason: "no_progress" | "repeated_edge";
      summary: string;
    };

/**
 * Before invoking a repair role: identical evidence without new operator input
 * must not call a model; previously seen role edges for the same fingerprint are rejected.
 */
export function evaluateRepairProgress(args: {
  fingerprint: string;
  lastFingerprint?: string;
  seenFingerprints: string[];
  seenEdges: string[];
  fromRole: string;
  toRole: string;
  hasNewOperatorInput?: boolean;
}): ProgressGateResult {
  const edge = repairEdgeKey(args.fingerprint, args.fromRole, args.toRole);
  if (args.seenEdges.includes(edge) && !args.hasNewOperatorInput) {
    return {
      allowed: false,
      fingerprint: args.fingerprint,
      reason: "repeated_edge",
      summary: `Repeated ${args.fromRole} → ${args.toRole} edge for unchanged evidence`,
    };
  }
  if (
    !args.hasNewOperatorInput &&
    (args.lastFingerprint === args.fingerprint || args.seenFingerprints.includes(args.fingerprint))
  ) {
    return {
      allowed: false,
      fingerprint: args.fingerprint,
      reason: "no_progress",
      summary: "Identical deterministic evidence; no model retry",
    };
  }
  return { allowed: true, fingerprint: args.fingerprint };
}
