import type { Context } from "@deepseek-ai/cordis";
import type { Run, VerificationEvidence } from "../domain/types.js";

export function inferFixCommandFromOutput(output: string): string | undefined {
  const spotless = output.match(/Run ['"]([^'"]*spotlessApply[^'"]*)['"] to fix/i);
  if (spotless?.[1]) return spotless[1];

  const prettier = output.match(/Run ['"]([^'"]*(?:prettier|format)[^'"]*)['"]/i);
  if (prettier?.[1]) return prettier[1];

  return undefined;
}

export function verificationCommand(run: Run): string | undefined {
  return verificationCommandsForRun(run).command;
}

/** Harness-configured verify/fix commands passed to the implementer and run in the sandbox. */
export function verificationCommandsForRun(
  run: Run,
  evidence?: VerificationEvidence | Record<string, unknown>,
): {
  command?: string;
  fixCommand?: string;
} {
  const configured = run.state.artifacts.verification as
    | { command?: string; proposal?: { fixCommand?: string } }
    | undefined;
  const command = configured?.command ?? run.settings.verification.command;
  const fixCommand =
    configured?.proposal?.fixCommand ??
    run.settings.verification.fixCommand ??
    (typeof evidence?.output === "string" ? inferFixCommandFromOutput(evidence.output) : undefined);
  return {
    command: command?.trim() || undefined,
    fixCommand: fixCommand?.trim() || undefined,
  };
}

/**
 * Runs the configured verification command in the sandbox. Returns undefined when no
 * command is configured — a missing configuration is not a broken environment, so
 * callers proceed to review without command evidence instead of blocking.
 */
export async function verifyWithHarness(
  ctx: Context,
  run: Run,
): Promise<VerificationEvidence | undefined> {
  const command = verificationCommand(run);
  if (!command?.trim()) return undefined;
  const result = await ctx.commands.verify(run.identity.runId, command);
  if (!result) {
    return {
      command,
      passed: false,
      output: "The harness did not produce verification evidence.",
      classification: "environment_failure",
    };
  }
  return result;
}

export function environmentBlock(evidence: VerificationEvidence): string {
  return [
    `Verification environment failure for \`${evidence.command || "unconfigured command"}\`: ${evidence.output}`,
    "Automatic image repair was exhausted or unavailable. Check the run's Worker image panel in the dashboard for a proposed Dockerfile update, or edit packages/agent-harness/docker/worker/Dockerfile manually, rebuild the image, then retry the run.",
  ].join(" ");
}

export async function repairImageForEnvironmentFailure(
  ctx: Context,
  run: Run,
  evidence: VerificationEvidence,
): Promise<VerificationEvidence> {
  let current = evidence;
  while (current.classification === "environment_failure") {
    const attempt = await ctx.imageRepair.repair(run, { evidence: current });
    if (!attempt.attempted || !attempt.evidence) return current;
    current = attempt.evidence;
  }
  return current;
}

export type ImplementerVerificationRequest = {
  runFix?: boolean;
  runVerify?: boolean;
};

/** Run implementer-requested fix/verify commands in the harness sandbox before the mandatory gate. */
export async function runImplementerHarnessVerification(
  ctx: Context,
  run: Run,
  implemented: Record<string, unknown> | undefined,
  priorEvidence?: VerificationEvidence | Record<string, unknown>,
): Promise<{ fix?: VerificationEvidence; verify?: VerificationEvidence }> {
  const commands = verificationCommandsForRun(run, priorEvidence);
  const request = (implemented?.verification ?? {}) as ImplementerVerificationRequest;
  const runFix = request.runFix !== false && Boolean(commands.fixCommand);
  const runVerify = request.runVerify === true && Boolean(commands.command);

  const result: { fix?: VerificationEvidence; verify?: VerificationEvidence } = {};
  if (runFix && commands.fixCommand) {
    const fix = await ctx.commands.verify(run.identity.runId, commands.fixCommand);
    if (fix) result.fix = fix;
  }
  if (runVerify && commands.command) {
    const verify = await ctx.commands.verify(run.identity.runId, commands.command);
    if (verify) result.verify = verify;
  }
  return result;
}
