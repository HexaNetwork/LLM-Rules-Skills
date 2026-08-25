import type { Context } from "@deepseek-ai/cordis";
import type { Run, VerificationEvidence } from "../domain/types.js";

export function verificationCommand(run: Run): string | undefined {
  return (
    (run.state.artifacts.verification as { command?: string } | undefined)?.command ??
    run.settings.verification.command
  );
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
