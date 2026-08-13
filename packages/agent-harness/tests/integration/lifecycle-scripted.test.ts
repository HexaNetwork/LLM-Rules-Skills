import path from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentBackend, AgentRequest } from "../../src/infrastructure/agents/types.js";
import { HarnessEngine } from "../../src/application/harness-engine.js";
import {
  confirmGrillAndAdvance,
  HIGH_LEVEL_PLAN,
  PRD_OUTPUT,
  SCENARIO_PLANNER_OUTPUT,
} from "../helpers.js";
import { withDiagnosticArtifacts } from "../testkit/diagnostics.js";
import { git as runGit } from "../testkit/git.js";
import { createProjectFixture, type ProjectFixture } from "../testkit/project-fixture.js";
import { createScriptedBackend } from "../testkit/scripted-backend.js";
import { migrateRunWorkspace } from "../../src/domain/workspace.js";

const REFLECT_OUTPUT = {
  proposedTitle: "Add greeting tone",
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
    await fixture?.cleanup();
    fixture = undefined;
  });

  it("reflect → grill → plan → scenarios → implement → scenario tests → final review → publish", async () => {
    fixture = await createProjectFixture({
      config: {
        agent: { promptBuilder: false, schemaRepairAttempts: 0, timeoutMs: 5_000, provider: "cursor" },
        workflow: {
          generateCommitMessages: false,
          maxGrillQuestionsPerEpisode: 5,
        },
        commands: {
          verification: [
            {
              id: "test",
              command: 'node -e "process.exit(0)"',
              timeoutMs: 600_000,
            },
          ],
        },
        git: { enabled: true },
        knowledge: {
          codegraph: { enabled: false },
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
      { testName: "lifecycle-scripted-implement-first", fixture },
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
              openUnknowns: [],
            },
          },
          { role: "planner", output: HIGH_LEVEL_PLAN },
          { role: "planner", output: PRD_OUTPUT },
          { role: "scenario-planner", output: SCENARIO_PLANNER_OUTPUT },
          {
            role: "issue-slicer",
            output: {
              summary: "One tracer bullet",
              tasks: [
                {
                  id: "greet",
                  title: "Add greeting",
                  description: "Return a casual greeting",
                  acceptanceCriteria: ["Greeting is casual"],
                  affectedPaths: ["src/greet.ts"],
                  blockedBy: [],
                  scenarioIds: ["greet-happy"],
                },
              ],
              proposedInstalls: [],
            },
          },
          {
            role: "implementer",
            output: { summary: "Implemented greeting", changedFiles: ["src/greet.ts"] },
          },
          {
            role: "task-reviewer",
            output: { approved: true, summary: "Looks good", findings: [] },
          },
          {
            role: "scenario-writer",
            output: {
              status: "implemented",
              summary: "Scenario tests written",
              testPaths: ["tests/greet.test.ts"],
              changedFiles: ["tests/greet.test.ts"],
            },
          },
          {
            role: "reviewer",
            output: { approved: true, summary: "Final review ok", findings: [] },
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
        expect(state.tasks[0]?.scenarioIds).toEqual(["greet-happy"]);
        expect(state.scenarios[0]?.status).toBe("passing");
        expect(state.tasks[0]?.evidence.some((item) => item.purpose === "test" && item.passed)).toBe(
          true,
        );
        expect(state.branchName).toMatch(/^harness\/add-greeting-tone-[a-z0-9]{1,8}$/);

        const runDir = path.join(fixture!.root, ".agent-harness", "runs", state.runId);
        const events = await readFile(path.join(runDir, "events.jsonl"), "utf8");
        expect(events).toContain("scenarios.planned");
        expect(events).toContain("task.implementation_verified");
        expect(events).toContain("task.committed");
        expect(events).toContain("scenario.passed");
        expect(events).toContain("final_review.approved");

        const packets = (await readdir(path.join(runDir, "packets"))).filter((name) =>
          name.endsWith(".json"),
        );
        expect(packets.length).toBeGreaterThan(0);
        const sessions = (await readdir(path.join(runDir, "sessions"))).filter((name) =>
          name.endsWith(".json"),
        );
        expect(sessions.length).toBeGreaterThanOrEqual(5);

        const brief = await readFile(path.join(runDir, "brief.md"), "utf8");
        expect(brief).toContain("Confirmed brief");
        const scenariosMd = await readFile(path.join(runDir, "scenarios.md"), "utf8");
        expect(scenariosMd).toContain("greet-happy");

        const workspace = migrateRunWorkspace(
          await engine.store.readJson(state.runId, "workspace.json"),
          { controlRoot: fixture!.root },
        );
        const worktree = workspace.worktreePath!;
        const log = await runGit(worktree, "log", "-1", "--format=%B");
        expect(log).toContain("Harness-Task: greet");
        expect(await runGit(worktree, "show", "--pretty=", "--name-only", "HEAD")).toContain(
          "src/greet.ts",
        );
        const commits = (
          await runGit(worktree, "rev-list", "--count", `${workspace.baseSha}..HEAD`)
        ).trim();
        expect(Number(commits)).toBe(1);
        expect((await fixture!.git("log", "-1", "--format=%s")).trim()).toBe("initial");

        scripted.assertExhausted();
        expect(scripted.calls.map((call) => call.role)).toEqual([
          "reflector",
          "griller",
          "griller",
          "docs-writer",
          "project-profiler",
          "planner",
          "planner",
          "scenario-planner",
          "issue-slicer",
          "implementer",
          "task-reviewer",
          "scenario-writer",
          "reviewer",
        ]);
      },
    );
  });
});

function withWorkspaceSideEffects(
  inner: AgentBackend,
  _fixture: ProjectFixture,
): AgentBackend {
  return {
    readiness: inner.readiness?.bind(inner),
    release: inner.release?.bind(inner),
    async run(request: AgentRequest) {
      const workspaceRoot = request.cwd;
      if (request.role === "implementer") {
        await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
        await writeFile(
          path.join(workspaceRoot, "src", "greet.ts"),
          'export const greet = () => "hi";\n',
          "utf8",
        );
      }
      if (request.role === "scenario-writer") {
        await mkdir(path.join(workspaceRoot, "tests"), { recursive: true });
        await writeFile(
          path.join(workspaceRoot, "tests", "greet.test.ts"),
          'import { greet } from "../src/greet.ts";\n',
          "utf8",
        );
      }
      return inner.run(request);
    },
  };
}
