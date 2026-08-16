import type { Context } from "@deepseek-ai/cordis";
import { seedFog } from "../domain/fog.js";
import type { AnswerBatch, Phase, PhaseResult, Run } from "../domain/types.js";
import { asRecord, invokeRole } from "./helpers.js";

export function createReflectPhase(ctx: Context): Phase {
  return {
    id: "reflect",
    async enter(run: Run) {
      run.state.artifacts.idea = run.state.idea;
    },
    async advance(run: Run): Promise<PhaseResult> {
      const output = asRecord(await invokeRole(ctx, run, "reflector", { idea: run.state.idea }));
      run.state.artifacts.reflect = output;
      const unknowns = Array.isArray(output.unknowns) ? output.unknowns.map(String) : [];
      run.state.fog = seedFog(unknowns, run.state.fog);
      return {
        kind: "await",
        gate: {
          id: "reflect-confirm",
          title: "Confirm the restatement",
          questions: [
            {
              id: "restatement",
              prompt: String(output.restatement ?? run.state.idea),
              kind: "confirm",
              recommended: "yes",
            },
          ],
        },
      };
    },
    async onAnswer(run: Run, batch: AnswerBatch): Promise<PhaseResult> {
      const restatement = batch.answers.restatement?.trim();
      if (!restatement) {
        return { kind: "block", reason: "Reflect confirmation is required", retriable: true };
      }
      const confirmed = restatement === "yes" || restatement === "y"
        ? String((run.state.artifacts.reflect as { restatement?: string } | undefined)?.restatement ?? run.state.idea)
        : restatement;
      run.state.artifacts.reflectBrief = { confirmed, notes: batch.notes };
      return { kind: "continue" };
    },
  };
}
