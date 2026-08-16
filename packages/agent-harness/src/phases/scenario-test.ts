import type { Context } from "@deepseek-ai/cordis";
import type { Phase, PhaseResult, Run } from "../domain/types.js";
import { asRecord, invokeRole } from "./helpers.js";

export function createScenarioTestPhase(ctx: Context): Phase {
  return {
    id: "scenario-test",
    async advance(run: Run): Promise<PhaseResult> {
      const command =
        (run.state.artifacts.verification as { command?: string } | undefined)?.command ??
        run.settings.verification.command;
      const verification = await ctx.commands.verify(run.identity.runId, command);
      if (verification && !verification.passed) {
        const repair = asRecord(
          await invokeRole(ctx, run, "fixer", {
            failure: verification.output,
            scenarios: run.state.artifacts.scenarios,
          }),
        );
        run.state.artifacts.scenarioRepair = repair;
        if (repair.passed === true) return { kind: "continue" };
        return { kind: "block", reason: `Scenario verification failed: ${verification.output}`, retriable: true };
      }
      run.state.artifacts.scenarioTest = verification ?? { passed: true, output: "no command configured" };
      return { kind: "continue" };
    },
  };
}
