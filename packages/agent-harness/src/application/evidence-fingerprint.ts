import { createHash } from "node:crypto";
import type { BuildTask, CommandEvidence } from "../domain.js";

export type EvidenceFingerprintInput = {
  taskId: string;
  /** Task step or run-phase label used to scope the fingerprint. */
  step: BuildTask["step"] | string;
  sourceTreeState: string;
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
  // An empty targeted run means the filter/template is broken, not production code.
  if (/no tests found|no test files found|0 tests? (found|executed|run)/i.test(output)) {
    return "config";
  }
  // Missing production symbols (even when cited under test sources) belong to the implementer.
  if (looksLikeMissingProductionSymbol(output)) return "verification";
  if (/SyntaxError|TS\d+|Compilation failed/i.test(output)) {
    return /tests?[\\/]|\.test\.|\.spec\./i.test(output) ? "test-repair" : "verification";
  }
  if (/cannot find module/i.test(output)) {
    return /tests?[\\/]|\.test\.|\.spec\./i.test(output) ? "test-repair" : "verification";
  }
  if (/baseline|known failure/i.test(output)) return "baseline";
  if (evidence.exitCode !== 0) return "verification";
  return fallback;
}

/** Compile diagnostics for missing production types/methods — not test-setup breakage. */
function looksLikeMissingProductionSymbol(output: string): boolean {
  if (!/cannot find symbol|cannot find type|error CS\d+|package .+ does not exist/i.test(output)) {
    return false;
  }
  // Missing test helper / *Test type is still a test-repair concern.
  if (
    /cannot find symbol[\s\S]{0,240}symbol:\s+(?:class|interface|method|variable)\s+\w*(Test|Tests|Spec|Mock|Fake)\b/i.test(
      output,
    )
  ) {
    return false;
  }
  return true;
}

export type RunnableRedClassification =
  | { runnable: true }
  | { runnable: false; reason: "command_missing" | "no_tests" | "compile_only" | "timeout" | "not_red" };

/**
 * TDD initial RED must be runnable: tests execute and fail on behavior,
 * not on missing symbols / compile-only failures.
 */
export function classifyRunnableRed(evidence: CommandEvidence | undefined): RunnableRedClassification {
  if (!evidence) return { runnable: false, reason: "not_red" };
  const output = `${evidence.stdout}\n${evidence.stderr}`;
  if (/command not found|not recognized|ENOENT/i.test(output)) {
    return { runnable: false, reason: "command_missing" };
  }
  if (evidence.exitCode === 124 || /\btimed?\s*out\b/i.test(output)) {
    return { runnable: false, reason: "timeout" };
  }
  if (/no tests found|no test files found|0 tests? (found|executed|run)/i.test(output)) {
    return { runnable: false, reason: "no_tests" };
  }
  if (evidence.exitCode === 0) {
    return { runnable: false, reason: "not_red" };
  }
  if (isCompileOnlyFailure(output)) {
    return { runnable: false, reason: "compile_only" };
  }
  return { runnable: true };
}

function isCompileOnlyFailure(output: string): boolean {
  const compileMarkers =
    /compileTestJava|Compilation failed|cannot find symbol|error: cannot find|javac:|error CS\d+|TS\d+:|cannot find module|package .+ does not exist/i;
  if (!compileMarkers.test(output)) return false;
  // Assertion / behavioral failure patterns mean tests did execute.
  if (
    /AssertionError|assert(?:Equals|True|False|That)?\b|expected:|Expected:|FAIL\s+\S|✗|×|org\.opentest4j|JUnit|failed:\s*\d+/i.test(
      output,
    )
  ) {
    return false;
  }
  return true;
}

/**
 * Hash the frozen command settings that shape scenario/verification evidence,
 * so a config fix (e.g. testTargetTemplate) invalidates prior fingerprints.
 */
export function frozenCommandsHash(commands: {
  verification: readonly unknown[];
  testTargetTemplate?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        verification: commands.verification,
        testTargetTemplate: commands.testTargetTemplate ?? null,
      }),
    )
    .digest("hex");
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
