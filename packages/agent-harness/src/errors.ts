export type FailureKind =
  | "provider" // transient backend/network/timeout — retry is likely to work
  | "workspace" // dirty tree, missing graph, unreported paths — human fixes, then retry
  | "config" // run config drift, version mismatch — retry cannot help
  | "budget" // step/token/cost ceiling — retry only after raising the ceiling
  | "contract" // model could not satisfy the schema after repair attempts
  | "test_integrity" // recorded RED tests were edited after the checkpoint
  | "verification" // production compile/behavior failure under targeted verification
  | "baseline" // unchanged known baseline failures; no implementer retry
  | "no_progress" // repeated evidence fingerprint with no new operator input
  | "internal"; // harness bug

/** Failures that must be repaired via config-fixer (frozen run snapshot), not a file fixer. */
export const CONFIG_FAILURE_PATTERN =
  /run configuration changed|configurationHash|resume with the persisted run config|configVersion .+ is newer than harness|Test writer changed non-test paths|Red writer changed non-test paths|Red writer changed paths outside tests and affectedPaths|Test command could not be launched/i;

export class HarnessFailure extends Error {
  readonly kind: FailureKind;
  readonly retriable: boolean;

  constructor(
    message: string,
    kind: FailureKind,
    retriable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "HarnessFailure";
    this.kind = kind;
    this.retriable = retriable;
  }
}

/** Operator cancellation — must not be classified as blocked/provider-retry. */
export class RunCancelledError extends Error {
  constructor(message = "Run cancelled") {
    super(message);
    this.name = "RunCancelledError";
  }
}

/** Prefer structured fields; fall back to message patterns for pre-classification errors. */
export function classifyFailure(error: unknown): { kind: FailureKind; retriable: boolean } {
  if (error instanceof HarnessFailure) {
    return { kind: error.kind, retriable: error.retriable };
  }
  const message = error instanceof Error ? error.message : String(error);
  return classifyByMessage(message);
}

function classifyByMessage(message: string): { kind: FailureKind; retriable: boolean } {
  if (
    /dirty working tree|uncommitted changes|working tree is not clean|changed unreported paths|produced no git changes|not a git repository/i.test(
      message,
    )
  ) {
    return { kind: "workspace", retriable: true };
  }
  if (/graphify-out[/\\]graph\.json|graphify graph|missing graph/i.test(message)) {
    return { kind: "workspace", retriable: true };
  }
  if (/CURSOR_API_KEY|agent backend (is )?unavailable|missing.*api.?key|timed out|aborted|Cursor run /i.test(message)) {
    return { kind: "provider", retriable: true };
  }
  if (CONFIG_FAILURE_PATTERN.test(message)) {
    return { kind: "config", retriable: false };
  }
  if (/Task .+ failed:|could not satisfy|Validation error|schema/i.test(message)) {
    return { kind: "contract", retriable: /schema|Validation error|could not satisfy/i.test(message) };
  }
  if (/Build frontier is empty|Dependency cycle|cannot block itself|references unknown blocker/i.test(message)) {
    return { kind: "internal", retriable: false };
  }
  return { kind: "internal", retriable: false };
}
