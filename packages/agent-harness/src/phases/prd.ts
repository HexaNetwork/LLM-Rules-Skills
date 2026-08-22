import type { Context } from "@deepseek-ai/cordis";
import type { Phase, PhaseResult, Run } from "../domain/types.js";
import { asRecord, invokeRole } from "./helpers.js";

export function createPrdPhase(ctx: Context): Phase {
  return {
    id: "prd",
    async advance(run: Run): Promise<PhaseResult> {
      const output = asRecord(
        await invokeRole(ctx, run, "docs-writer", {
          brief: run.state.artifacts.reflectBrief,
          plan: run.state.artifacts.plan,
          resolutions: run.state.artifacts.resolutions,
          fog: run.state.fog,
          fogResolutions: run.state.artifacts.fogResolutions,
        }),
      );
      run.state.artifacts.prd = output;
      return { kind: "continue" };
    },
  };
}
