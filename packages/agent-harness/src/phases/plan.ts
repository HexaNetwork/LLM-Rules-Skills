import type { Context } from "@deepseek-ai/cordis";
import type { Phase, PhaseResult, Run } from "../domain/types.js";
import { asRecord, invokeRole } from "./helpers.js";

export function createPlanPhase(ctx: Context): Phase {
  return {
    id: "plan",
    async advance(run: Run): Promise<PhaseResult> {
      const output = asRecord(
        await invokeRole(ctx, run, "planner", {
          brief: run.state.artifacts.reflectBrief,
          glossary: run.state.artifacts.glossaryContext ?? run.state.artifacts.glossary,
          resolutions: run.state.artifacts.resolutions,
          fog: run.state.fog,
          fogResolutions: run.state.artifacts.fogResolutions,
          planningFeedback: run.state.artifacts.planningFeedback,
          operatorNotes: run.state.artifacts.operatorNotes,
        }),
      );
      run.state.artifacts.plan = output.plan ?? output;
      return { kind: "continue" };
    },
  };
}
