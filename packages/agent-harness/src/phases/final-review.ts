import type { Context } from "@deepseek-ai/cordis";
import type { Phase, PhaseResult, Run } from "../domain/types.js";
import { asRecord, invokeRole } from "./helpers.js";

export function createFinalReviewPhase(ctx: Context): Phase {
  return {
    id: "final-review",
    async advance(run: Run): Promise<PhaseResult> {
      const review = asRecord(
        await invokeRole(ctx, run, "reviewer", {
          plan: run.state.artifacts.plan,
          tasks: run.state.tasks,
          scenarios: run.state.artifacts.scenarioTest,
        }),
      );
      run.state.artifacts.finalReview = review;
      if (String(review.verdict ?? "approve") !== "approve") {
        return { kind: "block", reason: "Final review rejected the slice", retriable: true };
      }
      return { kind: "continue" };
    },
  };
}
