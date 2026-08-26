import type { Context } from "@deepseek-ai/cordis";
import { buildPlannerInput } from "../domain/role-packets.js";
import type { FogResolution, Phase, PhaseResult, Run } from "../domain/types.js";
import { asRecord, invokeRole } from "./helpers.js";

export function createPlanPhase(ctx: Context): Phase {
  return {
    id: "plan",
    async advance(run: Run): Promise<PhaseResult> {
      const output = asRecord(
        await invokeRole(
          ctx,
          run,
          "planner",
          buildPlannerInput({
            brief: run.state.artifacts.reflectBrief,
            resolutions: run.state.artifacts.resolutions,
            fogResolutions: run.state.artifacts.fogResolutions as FogResolution[] | undefined,
            planningFeedback: run.state.artifacts.planningFeedback,
            operatorNotes: run.state.artifacts.operatorNotes,
          }),
        ),
      );
      run.state.artifacts.plan = output.plan ?? output;
      return { kind: "continue" };
    },
  };
}
