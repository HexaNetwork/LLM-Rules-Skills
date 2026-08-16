import type { Context } from "@deepseek-ai/cordis";
import type { Phase, PhaseResult, Run } from "../domain/types.js";

export function createCrystallizePhase(ctx: Context): Phase {
  return {
    id: "crystallize",
    async advance(run: Run): Promise<PhaseResult> {
      if (!run.settings.coverage.enabled) {
        run.state.artifacts.coverage = { skipped: true };
        return { kind: "continue" };
      }
      const result = await ctx.commands.verify(run.identity.runId, run.settings.coverage.command);
      run.state.artifacts.coverage = result ?? { skipped: true };
      if (result && !result.passed) {
        return { kind: "block", reason: "Coverage command failed", retriable: true };
      }
      return { kind: "continue" };
    },
  };
}
