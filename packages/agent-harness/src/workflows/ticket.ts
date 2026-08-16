import type { WorkflowBundle } from "../domain/types.js";

export const TICKET_WORKFLOW: WorkflowBundle = {
  id: "ticket",
  phases: ["implement", "scenario-test", "publish"],
};
