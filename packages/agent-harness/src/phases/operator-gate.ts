import type { Phase, PhaseResult, Run } from "../domain/types.js";

export function createOperatorGatePhase(): Phase {
  return {
    id: "operator-gate",
    async advance(_run: Run): Promise<PhaseResult> {
      return {
        kind: "await",
        gate: {
          id: "operator-gate",
          title: "Review plan, PRD, and scenarios",
          questions: [],
        },
      };
    },
    async onAnswer(run, batch): Promise<PhaseResult> {
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
