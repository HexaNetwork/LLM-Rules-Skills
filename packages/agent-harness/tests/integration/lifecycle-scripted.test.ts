import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentBackend, AgentRequest } from "../../src/agent.js";
import { HarnessEngine } from "../../src/engine.js";
import { confirmGrillAndAdvance } from "../helpers.js";
import { withDiagnosticArtifacts } from "../testkit/diagnostics.js";
import { createProjectFixture, type ProjectFixture } from "../testkit/project-fixture.js";
import { createScriptedBackend } from "../testkit/scripted-backend.js";

const REFLECT_OUTPUT = {
  summary: "Restated greeting feature",
  restatement: "Add a greeting feature with a chosen tone.",
  goal: "Ship a greeting users understand",
  users: ["end users"],
  inScope: ["tone choice", "greeting copy"],
  outOfScope: ["localization"],
  assumptions: ["English only"],
  unknowns: ["formal vs casual"],
};

describe("Phase 5 scripted full lifecycle", () => {
  let fixture: ProjectFixture | undefined;

  afterEach(async () => {
    delete process.env.HARNESS_FORCE_RED;
    await fixture?.cleanup();
    fixture = undefined;
  });

  it("reflect → grill → plan → TDD RED → implement → GREEN → review → commit with observable artifacts", async () => {
    fixture = await createProjectFixture({
      config: {
        agent: { promptBuilder: false, schemaRepairAttempts: 0, timeoutMs: 5_000, provider: "cursor" },
        workflow: {
          tdd: true,
          generateCommitMessages: false,
          maxGrillQuestionsPerEpisode: 5,
        },
        commands: {
          test: 'node -e "process.exit(process.env.HARNESS_FORCE_RED ? 1 : 0)"',
          passEnv: ["HARNESS_FORCE_RED"],
          gates: [],
        },
        git: { enabled: true },
        knowledge: {
          graphify: { enabled: false },
          guidance: { enabled: false },
        },
      },
      initialFiles: {
        "README.md": "# Fixture\n",
        "docs/.gitkeep": "",
        "src/.gitkeep": "",
        "tests/.gitkeep": "",
      },
    });
    await fixture.initGit();

    await withDiagnosticArtifacts(
      { testName: "lifecycle-scripted-full-tdd", fixture },
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
              summary: "Tone decided",
              resolutions: [
                {
                  id: "tone",
                  question: "Should the greeting be formal or casual?",
                  answer: "Casual",
                  summary: "Use a casual greeting",
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
                  description: "Render the casual greeting.",
                  acceptanceCriteria: ["Greeting is casual"],
                  blockedBy: [],
                  tdd: true,
                  testCommand:
                    'node -e "process.exit(process.env.HARNESS_FORCE_RED ? 1 : 0)"',
                },
              ],
            },
          },
          {
            role: "test-writer",
            output: { summary: "RED test", changedFiles: ["tests/greet.test.ts"] },
          },
          {
            role: "implementer",
            output: { summary: "GREEN", changedFiles: ["src/greet.ts"] },
          },
          {
            role: "reviewer",
            output: { approved: true, summary: "Looks good", findings: [] },
          },
        ]);

        const backend = withWorkspaceSideEffects(scripted.backend, fixture!);
        const engine = new HarnessEngine(fixture!.config, { backend });

        let state = await engine.start("Add a greeting feature");
        state = await engine.advance(state.runId);
        expect(state.phase).toBe("awaiting_input");
        const reflectQuestion = state.questions.find((item) => item.id === state.activeQuestionId);
        expect(reflectQuestion?.purpose).toBe("reflect");

        state = await engine.answer(
          state.runId,
          reflectQuestion!.id,
          "Confirmed brief: casual greeting feature.",
        );
        state = await engine.advance(state.runId);
        expect(state.phase).toBe("awaiting_input");
        const grillQuestion = state.questions.find((item) => item.id === state.activeQuestionId);
        expect(grillQuestion?.purpose).toBe("grill");

        state = await engine.answer(state.runId, grillQuestion!.id, "Casual");
        state = await engine.advance(state.runId);
        expect(state.grillReady?.summary).toBeTruthy();
        state = await confirmGrillAndAdvance(engine, state.runId);

        expect(state.phase).toBe("completed");
        expect(state.tasks[0]?.status).toBe("done");
        expect(state.tasks[0]?.evidence.some((item) => item.purpose === "tdd:red")).toBe(true);
        expect(state.tasks[0]?.evidence.some((item) => item.passed)).toBe(true);
        expect(state.branchName).toMatch(/^harness\//);

        const runDir = path.join(fixture!.root, ".agent-harness", "runs", state.runId);
        const events = await readFile(path.join(runDir, "events.jsonl"), "utf8");
        expect(events).toContain("task.red_observed");
        expect(events).toContain("task.committed");

        const packets = (await readdir(path.join(runDir, "packets"))).filter((name) =>
          name.endsWith(".json"),
        );
        expect(packets.length).toBeGreaterThan(0);
        const sessions = (await readdir(path.join(runDir, "sessions"))).filter((name) =>
          name.endsWith(".json"),
        );
        expect(sessions.some((name) => name)).toBe(true);
        expect(sessions.length).toBeGreaterThanOrEqual(5);

        const brief = await readFile(path.join(runDir, "brief.md"), "utf8");
        expect(brief).toContain("Confirmed brief");

        const log = await fixture!.git("log", "-1", "--format=%B");
        expect(log).toContain("Harness-Task: greet");
        expect(await fixture!.git("show", "--pretty=", "--name-only", "HEAD")).toContain(
          "src/greet.ts",
        );

        scripted.assertExhausted();
        expect(scripted.calls.map((call) => call.role)).toEqual([
          "reflector",
          "griller",
          "griller",
          "project-profiler",
          "planner",
          "test-writer",
          "implementer",
          "reviewer",
        ]);
      },
    );
  });
});

function withWorkspaceSideEffects(
  inner: AgentBackend,
  fixture: ProjectFixture,
): AgentBackend {
  return {
    readiness: inner.readiness?.bind(inner),
    release: inner.release?.bind(inner),
    async run(request: AgentRequest) {
      if (request.role === "test-writer") {
        process.env.HARNESS_FORCE_RED = "1";
        await fixture.write(
          "tests/greet.test.ts",
          'test("greets", () => { throw new Error("not implemented"); });\n',
        );
      }
      if (request.role === "implementer") {
        delete process.env.HARNESS_FORCE_RED;
        await fixture.write("src/greet.ts", 'export const greet = () => "hi";\n');
      }
      return inner.run(request);
    },
  };
}
