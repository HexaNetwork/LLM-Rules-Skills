import type { Context } from "@deepseek-ai/cordis";
import { buildScenarioPlannerInput } from "../domain/role-packets.js";
import type { AnswerBatch, Phase, PhaseResult, Run } from "../domain/types.js";
import { asRecord, invokeRole } from "./helpers.js";

export function createScenariosPhase(ctx: Context): Phase {
  return {
    id: "scenarios",
    async advance(run: Run): Promise<PhaseResult> {
      const output = asRecord(
        await invokeRole(
          ctx,
          run,
          "scenario-planner",
          buildScenarioPlannerInput({
            plan: run.state.artifacts.plan,
            prd: run.state.artifacts.prd,
            planningFeedback: run.state.artifacts.planningFeedback,
            operatorNotes: run.state.artifacts.operatorNotes,
          }),
        ),
      );
      run.state.artifacts.scenarios = output.scenarios ?? output;
      return {
        kind: "await",
        gate: {
          id: "operator-gate",
          title: "Review plan, PRD, and scenarios",
          questions: [],
        },
      };
    },
    async onAnswer(run: Run, batch: AnswerBatch): Promise<PhaseResult> {
      const decision = String(batch.answers.decision ?? "").toLowerCase();
      const notes = batch.notes?.trim() ?? "";

      if (decision === "approve") {
        appendOperatorNotes(run, notes);
        delete run.state.artifacts.planningFeedback;
        run.state.artifacts.operatorApproved = true;
        return { kind: "continue" };
      }

      if (decision === "request_changes") {
        if (!notes) {
          return {
            kind: "block",
            reason: "Notes are required when requesting changes",
            retriable: true,
          };
        }
        appendOperatorNotes(run, notes);
        run.state.artifacts.planningFeedback = notes;
        run.state.artifacts.operatorApproved = false;
        return { kind: "continue", next: "plan" };
      }

      return {
        kind: "block",
        reason: "Choose Approve or Request changes",
        retriable: true,
      };
    },
  };
}

function appendOperatorNotes(run: Run, notes: string): void {
  if (!notes) return;
  const prior = run.state.artifacts.operatorNotes;
  const parts: string[] = [];
  if (typeof prior === "string" && prior.trim()) parts.push(prior.trim());
  parts.push(notes);
  run.state.artifacts.operatorNotes = parts.join("\n\n");
}
