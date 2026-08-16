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
          glossary: run.state.artifacts.glossary,
        }),
      );
      run.state.artifacts.plan = output.plan ?? output;
      return { kind: "continue" };
    },
  };
}
