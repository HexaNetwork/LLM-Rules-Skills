/** Shared planner / PRD / slicer fixtures for harness tests. */

export const HIGH_LEVEL_PLAN = {
  summary: "One high-level plan",
  problemStatement: "Users need a casual greeting.",
  solution: "Ship a greeting feature with a chosen tone.",
  approach: "Add a small greeting module, then wire it into the UI.",
  constraints: ["Keep scope narrow"],
  outOfScope: ["Localization"],
  openQuestions: [] as string[],
};

export const PRD_OUTPUT = {
  summary: "Greeting PRD",
  problemStatement: "Users need a casual greeting.",
  solution: "Ship a greeting feature with a chosen tone.",
  userStories: [
    "As a user, I want a casual greeting, so that the product feels friendly",
  ],
  implementationDecisions: ["Add a greeting module"],
  testingDecisions: ["Test public greeting behavior"],
  outOfScope: ["Localization"],
  furtherNotes: "",
};

export const SLICER_ONE_TASK = {
  summary: "One task",
  tasks: [
    {
      id: "greet",
      title: "Ship greeting",
      description: "Render the casual greeting.",
      acceptanceCriteria: ["Greeting is casual"],
      blockedBy: [] as string[],
      tdd: false,
    },
  ],
  proposedInstalls: [] as Array<{
    id: string;
    manager: "npm";
    packages: string[];
    reason: string;
  }>,
};

function isPrdRequest(request: {
  prompt?: string;
  continuationPrompt?: string;
}): boolean {
  const text = `${request.prompt ?? ""}\n${request.continuationPrompt ?? ""}`;
  return /local PRD|user stories|Expand the approved high-level plan/i.test(text);
}

/** Fake-backend planner that returns a high-level plan or PRD based on the objective. */
export function createPlannerPrdSequence(plan = HIGH_LEVEL_PLAN, prd = PRD_OUTPUT) {
  let plannerCalls = 0;
  let prdCalls = 0;
  return {
    planner: (request: { prompt?: string; continuationPrompt?: string } = {}) => {
      plannerCalls += 1;
      if (isPrdRequest(request)) {
        prdCalls += 1;
        return prd;
      }
      return plan;
    },
    plannerCallCount: () => plannerCalls,
    prdCallCount: () => prdCalls,
  };
}
