import { afterEach, describe, expect, it } from "vitest";
import { HarnessEngine } from "../../src/engine.js";
import { confirmGrillAndAdvance } from "../helpers.js";
import { withDiagnosticArtifacts } from "../testkit/diagnostics.js";
import { createProjectFixture, type ProjectFixture } from "../testkit/project-fixture.js";
import { createScriptedBackend } from "../testkit/scripted-backend.js";

const REFLECT_OUTPUT = {
  proposedTitle: "Add greeting tone",
  summary: "Restated greeting feature",
  restatement: "Add a greeting feature with a chosen tone.",
  goal: "Ship a greeting users understand",
  users: ["end users"],
  inScope: ["tone choice"],
  outOfScope: [],
  assumptions: [],
  unknowns: ["tone"],
};

describe("Phase 5 restart resilience", () => {
  let fixture: ProjectFixture | undefined;

  afterEach(async () => {
    await fixture?.cleanup();
    fixture = undefined;
  });

  it("reconstructs the engine after each major phase and continues from disk", async () => {
    fixture = await createProjectFixture({
      config: {
        agent: { promptBuilder: false, schemaRepairAttempts: 0, timeoutMs: 5_000, provider: "cursor" },
        workflow: { tdd: false, generateCommitMessages: false },
        commands: { test: 'node -e "process.exit(0)"', gates: [] },
        git: { enabled: false },
        knowledge: {
          graphify: { enabled: false },
          guidance: { enabled: false },
        },
      },
    });

    await withDiagnosticArtifacts(
      { testName: "restart-resilience-major-phases", fixture },
      async () => {
        const scripted = createScriptedBackend([
          { role: "reflector", output: REFLECT_OUTPUT },
          {
            role: "griller",
            output: {
              status: "needs_input",
              summary: "Need tone",
              questions: [
                {
                  prompt: "Should the greeting be formal or casual?",
                  context: "The choice sets the voice users encounter throughout the feature.",
                  options: [
                    { id: "formal", label: "Formal", description: "Polished and reserved." },
                    { id: "casual", label: "Casual", description: "Warm and direct." },
                  ],
                  recommendedOptionId: "casual",
                  recommendation: "Use casual for a lightweight greeting.",
                },
              ],
            },
          },
          {
            role: "griller",
            output: {
              status: "ready_to_plan",
              summary: "Ready",
              resolutions: [
                {
                  id: "tone",
                  question: "Should the greeting be formal or casual?",
                  answer: "Casual",
                  summary: "Casual",
                },
              ],
            },
          },
          {
            role: "planner",
            output: {
              summary: "One task",
              tasks: [
                {
                  id: "greet",
                  title: "Ship greeting",
                  description: "Render greeting.",
                  acceptanceCriteria: ["Works"],
                  blockedBy: [],
                  tdd: false,
                  testCommand: 'node -e "process.exit(0)"',
                },
              ],
            },
          },
          {
            role: "implementer",
            output: { summary: "Built", changedFiles: ["src/greet.ts"] },
          },
          {
            role: "reviewer",
            output: { approved: true, summary: "ok", findings: [] },
          },
        ]);

        const reopen = () => new HarnessEngine(fixture!.config, { backend: scripted.backend });

        let engine = reopen();
        let state = await engine.start("Add greeting");
        const runId = state.runId;
        state = await engine.advance(runId);
        expect(state.phase).toBe("awaiting_input");
        expect(state.questions.find((q) => q.id === state.activeQuestionId)?.purpose).toBe("reflect");

        engine = reopen();
        state = await engine.status(runId);
        state = await engine.answer(runId, state.activeQuestionId!, "Confirmed brief");
        state = await engine.advance(runId);
        expect(state.phase).toBe("awaiting_input");
        expect(state.questions.find((q) => q.id === state.activeQuestionId)?.purpose).toBe("grill");

        engine = reopen();
        state = await engine.status(runId);
        state = await engine.answer(runId, state.activeQuestionId!, "Casual");
        state = await engine.advance(runId);
        expect(state.grillReady?.summary).toBeTruthy();

        engine = reopen();
        state = await engine.status(runId);
        state = await confirmGrillAndAdvance(engine, runId);
        expect(state.phase).toBe("completed");
        expect(state.tasks[0]?.status).toBe("done");
        expect((await reopen().status(runId)).phase).toBe("completed");

        scripted.assertExhausted();
      },
    );
  });
});
