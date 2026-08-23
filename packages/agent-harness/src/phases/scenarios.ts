import type { Context } from "@deepseek-ai/cordis";
import type { Phase, PhaseResult, Run } from "../domain/types.js";
import { asRecord, invokeRole } from "./helpers.js";

export function createScenariosPhase(ctx: Context): Phase {
  return {
    id: "scenarios",
    async advance(run: Run): Promise<PhaseResult> {
      const output = asRecord(
        await invokeRole(ctx, run, "scenario-planner", {
          plan: run.state.artifacts.plan,
          prd: run.state.artifacts.prd,
          planningFeedback: run.state.artifacts.planningFeedback,
          operatorNotes: run.state.artifacts.operatorNotes,
        }),
      );
      run.state.artifacts.scenarios = output.scenarios ?? output;
      return { kind: "continue" };
    },
  };
}
