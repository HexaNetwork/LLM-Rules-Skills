import type { Context } from "@deepseek-ai/cordis";
import type { Phase, PhaseResult, Run } from "../domain/types.js";
import { asRecord, invokeRole } from "./helpers.js";
import {
  environmentBlock,
  repairImageForEnvironmentFailure,
  verifyWithHarness,
} from "./verification.js";

export function createFinalReviewPhase(ctx: Context): Phase {
  return {
    id: "final-review",
    async advance(run: Run): Promise<PhaseResult> {
      const maxAttempts = run.settings.workflow.maxFinalReviewAttempts;
      let review = await reviewSlice(ctx, run);
      while (String(review.verdict ?? "approve") !== "approve") {
        const attempt = Number(run.state.artifacts.finalReviewAttempts ?? 0) + 1;
        run.state.artifacts.finalReviewAttempts = attempt;
        if (attempt > maxAttempts) {
          const summary = String(review.summary ?? "Reviewer requested changes without a summary.");
          return {
            kind: "block",
            reason: `Final review requested changes after ${maxAttempts} repair attempt(s): ${summary}`,
            retriable: true,
          };
        }
        await invokeRole(ctx, run, "implementer", {
          repair: true,
          finalReview: review,
          plan: run.state.artifacts.plan,
          tasks: run.state.tasks,
        });
        let evidence = await verifyWithHarness(ctx, run);
        if (evidence && evidence.classification === "environment_failure") {
          evidence = await repairImageForEnvironmentFailure(ctx, run, evidence);
        }
        if (evidence) {
          run.state.artifacts.finalReviewVerification = evidence;
          if (evidence.classification === "environment_failure") {
            return { kind: "block", reason: environmentBlock(evidence), retriable: true };
          }
        }
        review = await reviewSlice(ctx, run);
      }
      return { kind: "continue" };
    },
  };
}

async function reviewSlice(ctx: Context, run: Run): Promise<Record<string, unknown>> {
  const review = asRecord(
    await invokeRole(ctx, run, "reviewer", {
      plan: run.state.artifacts.plan,
      tasks: run.state.tasks,
      scenarios: run.state.artifacts.scenarioTest,
      verification: run.state.artifacts.finalReviewVerification,
    }),
  );
  run.state.artifacts.finalReview = review;
  return review;
}
