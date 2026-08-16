import type { Phase, PhaseResult, Run } from "../domain/types.js";

export function createOperatorGatePhase(): Phase {
  return {
    id: "operator-gate",
    async advance(run: Run): Promise<PhaseResult> {
      return {
        kind: "await",
        gate: {
          id: "operator-gate",
          title: "Approve plan, PRD, and scenarios",
          questions: [
            {
              id: "approve",
              prompt: "Approve the plan, PRD, and scenarios?",
              kind: "confirm",
              recommended: "yes",
            },
          ],
        },
      };
    },
    async onAnswer(run, batch): Promise<PhaseResult> {
      const approve = (batch.answers.approve ?? "").toLowerCase();
      if (approve !== "yes" && approve !== "y") {
        return { kind: "block", reason: "Operator rejected the planning packet", retriable: true };
      }
      run.state.artifacts.operatorApproved = true;
      return { kind: "continue" };
    },
  };
}
