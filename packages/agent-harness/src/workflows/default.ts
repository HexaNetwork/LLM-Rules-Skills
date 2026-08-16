import type { WorkflowBundle } from "../domain/types.js";

export const DEFAULT_WORKFLOW: WorkflowBundle = {
  id: "default",
  phases: [
    "reflect",
    "grill",
    "glossary",
    "verification-settings",
    "plan",
    "prd",
    "scenarios",
    "operator-gate",
    "slice",
    "implement",
    "scenario-test",
    "crystallize",
    "final-review",
    "publish",
  ],
};
