import type { Context } from "@deepseek-ai/cordis";
import type { Phase, PhaseResult, Run } from "../domain/types.js";
import { asRecord, invokeRole } from "./helpers.js";
import {
  environmentBlock,
  repairImageForEnvironmentFailure,
  verificationCommand,
} from "./verification.js";

export function createScenarioTestPhase(ctx: Context): Phase {
  return {
    id: "scenario-test",
    async advance(run: Run): Promise<PhaseResult> {
      let verification = await ctx.commands.verify(run.identity.runId, verificationCommand(run));
      if (verification && verification.classification === "environment_failure") {
        verification = await repairImageForEnvironmentFailure(ctx, run, verification);
      }
      if (verification && !verification.passed) {
        run.state.artifacts.scenarioTest = verification;
        if (verification.classification === "environment_failure") {
          return { kind: "block", reason: environmentBlock(verification), retriable: true };
        }
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
