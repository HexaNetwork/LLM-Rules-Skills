import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentBackend, AgentRequest } from "../../infrastructure/agents/types.js";

/**
 * Deterministic provider used only by the blocking Docker acceptance profile.
 * It performs real workspace edits while keeping model behavior reproducible.
 */
export function createDeterministicWorkflowBackend(): AgentBackend {
  return {
    workspaceCapabilities() {
      return { canRestrictWritableWorkspace: true, providerId: "deterministic-test" };
    },
    async run(request) {
      const output = await deterministicOutput(request);
      const providerSessionId = request.providerSessionId ?? randomUUID();
      return {
        output,
        providerSessionId,
        providerRunId: randomUUID(),
        providerSessionReused: request.providerSessionId != null,
        submittedPrompt: request.continuationPrompt ?? request.prompt,
      };
    },
    async release() {},
  };
}

async function deterministicOutput(
  request: AgentRequest,
): Promise<unknown> {
  switch (request.role) {
    case "reflector":
      return {
        proposedTitle: "Docker greeting",
        summary: "Restated deterministic Docker feature",
        restatement: "Add a deterministic greeting inside the isolated workspace.",
        goal: "Prove the complete containerized workflow",
        users: ["acceptance operator"],
        inScope: ["greeting module", "verification"],
        outOfScope: ["network services"],
        assumptions: ["deterministic provider"],
        unknowns: ["greeting tone"],
      };
    case "griller":
      return {
        status: "ready_to_plan",
        summary: "The deterministic fixture has no blocking unknowns",
        resolutions: [],
        openUnknowns: [],
      };
    case "docs-writer":
      return { summary: "No glossary changes needed", changedFiles: [] };
    case "project-profiler":
      return { summary: "Keep config-owned verification", configPatch: {} };
    case "planner":
      return /local PRD|user stories|Expand the approved high-level plan/i.test(
        `${request.prompt}\n${request.continuationPrompt ?? ""}`,
      )
        ? {
            summary: "Docker greeting PRD",
            problemStatement: "The Docker topology needs complete workflow evidence.",
            solution: "Create and verify one greeting module in the isolated volume.",
            userStories: ["As an operator, I can observe a completed isolated workflow."],
            implementationDecisions: ["Write src/greeting.js"],
            testingDecisions: ["Run config-owned Node verification"],
            outOfScope: ["External publication"],
            furtherNotes: "",
          }
        : {
            summary: "Docker greeting plan",
            problemStatement: "The Docker topology lacks complete workflow evidence.",
            solution: "Implement and verify one greeting module in the isolated volume.",
            approach: "Write the module, verify it, review it, and export the resulting commit.",
            constraints: ["Do not touch the host checkout"],
            outOfScope: ["External publication"],
            openQuestions: [],
          };
    case "scenario-planner":
      return {
        summary: "Greeting scenario",
        scenarios: [
          {
            id: "docker-greeting",
            title: "Casual greeting",
            kind: "happy-path",
            intent: "The module returns the selected greeting",
            given: "The isolated workspace is seeded",
            when: "The greeting module is loaded",
            then: "It returns Hello from Docker!",
          },
        ],
      };
    case "issue-slicer":
      return {
        summary: "One tracer bullet",
        tasks: [
          {
            id: "docker-greeting",
            title: "Implement Docker greeting",
            description: "Create the deterministic greeting module.",
            acceptanceCriteria: ["Module returns Hello from Docker!"],
            affectedPaths: ["src/greeting.js"],
            blockedBy: [],
            scenarioIds: ["docker-greeting"],
          },
        ],
        proposedInstalls: [],
      };
    case "implementer": {
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(
        path.join(request.cwd, "src", "greeting.js"),
        'export function greeting() { return "Hello from Docker!"; }\n',
        "utf8",
      );
      return { summary: "Implemented Docker greeting", changedFiles: ["src/greeting.js"] };
    }
    case "task-reviewer":
      return { approved: true, summary: "Task implementation is correct", findings: [] };
    case "scenario-writer": {
      await mkdir(path.join(request.cwd, "tests"), { recursive: true });
      await writeFile(
        path.join(request.cwd, "tests", "greeting.test.js"),
        [
          'import { greeting } from "../src/greeting.js";',
          'if (greeting() !== "Hello from Docker!") process.exit(1);',
          "",
        ].join("\n"),
        "utf8",
      );
      return {
        status: "implemented",
        summary: "Wrote deterministic scenario",
        testPaths: ["tests/greeting.test.js"],
        changedFiles: ["tests/greeting.test.js"],
      };
    }
    case "reviewer":
      return { approved: true, summary: "Final Docker review passed", findings: [] };
    default:
      throw new Error(`Deterministic Docker profile has no handler for ${request.role}`);
  }
}
