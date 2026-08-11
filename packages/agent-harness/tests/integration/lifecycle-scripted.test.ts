import path from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentBackend, AgentRequest } from "../../src/agent.js";
import { HarnessEngine } from "../../src/engine.js";
import {
  confirmGrillAndAdvance,
  HIGH_LEVEL_PLAN,
  PRD_OUTPUT
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
          verification: [{ id: "test", command: 'node -e "process.exit(process.env.HARNESS_FORCE_RED ? 1 : 0)"', timeoutMs: 600_000 }],
          passEnv: ["HARNESS_FORCE_RED"],
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
          { role: "planner", output: HIGH_LEVEL_PLAN },
      { role: "planner", output: PRD_OUTPUT },
      {
        role: "issue-slicer",
        output: {

              summary: "One task",
              tasks: [
                {
                  id: "greet",
                  title: "Ship greeting",
                  description: "Render the casual greeting.",
                  acceptanceCriteria: ["Greeting is casual"],
                  affectedPaths: ["src/greet.ts"],
                  blockedBy: [],
                  tdd: true,
                },
              ],
          proposedInstalls: [],
        },
      },
          {
            role: "red-writer",
            output: {
              status: "continue",
              summary: "Test-only RED batch",
              changedFiles: ["tests/greet.test.ts"],
              behaviorsAdded: ["greeting fails until implemented"],
              edgeCasesAdded: [],
            },
          },
          {
            role: "implementer",
            output: { status: "green", summary: "GREEN", changedFiles: ["src/greet.ts"] },
          },
          {
            role: "red-writer",
            output: {
              status: "done",
              summary: "Coverage complete",
              changedFiles: [],
              acceptanceCoverage: [
                {
                  criterionIndex: 0,
                  covered: true,
                  testPaths: ["tests/greet.test.ts"],
                  rationale: "Greeting behavior is covered",
                },
              ],
              edgeCaseRationale: "No further edge cases required for this fixture",
            },
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
        expect(state.tasks[0]?.evidence.some((item) => item.purpose === "tdd:red")).toBe(false);
        expect(state.tasks[0]?.evidence.some((item) => item.purpose === "tdd:green")).toBe(true);
        expect(state.tasks[0]?.evidence.some((item) => item.passed)).toBe(true);
        expect(state.tasks[0]?.redCheckpointSha).toMatch(/^[a-f0-9]{40}$/);
        expect(state.tasks[0]?.redBaseSha).toMatch(/^[a-f0-9]{40}$/);
        expect(state.tasks[0]?.tddLoop?.atVerifiedGreen).toBe(true);
        // Delivery branch is created at publication from the confirmed title + short run id.
        expect(state.branchName).toMatch(/^harness\/add-greeting-tone-[a-z0-9]{1,8}$/);

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
        const sampleSession = JSON.parse(
          await readFile(path.join(runDir, "sessions", sessions[0]!), "utf8"),
        ) as { invocationKind?: string; trigger?: { summary?: string } };
        expect(sampleSession.invocationKind).toBeTruthy();
        expect(sampleSession.trigger?.summary).toBeTruthy();

        const brief = await readFile(path.join(runDir, "brief.md"), "utf8");
        expect(brief).toContain("Confirmed brief");

        const workspace = migrateRunWorkspace(
          await engine.store.readJson(state.runId, "workspace.json"),
          { controlRoot: fixture!.root },
        );
        const worktree = workspace.worktreePath!;
        const log = await runGit(worktree, "log", "-1", "--format=%B");
        expect(log).toContain("Harness-Task: greet");
        expect(log).toContain(`Harness-Red-Checkpoints: ${state.tasks[0]!.redCheckpointSha}`);
        expect(await runGit(worktree, "show", "--pretty=", "--name-only", "HEAD")).toContain(
          "src/greet.ts",
        );
        // Detached history is one atomic task commit ahead of the immutable base.
        const commits = (
          await runGit(worktree, "rev-list", "--count", `${workspace.baseSha}..HEAD`)
        ).trim();
        expect(Number(commits)).toBe(1);
        // Control checkout remains on the original tip.
        expect((await fixture!.git("log", "-1", "--format=%s")).trim()).toBe("initial");

        scripted.assertExhausted();
        expect(scripted.calls.map((call) => call.role)).toEqual([
          "reflector",
          "griller",
          "griller",
          "project-profiler",
          "planner",
          "planner",
          "issue-slicer",
          "red-writer",
          "implementer",
          "red-writer",
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
      if (request.role === "red-writer") {
        const output = await inner.run(request);
        const status =
          output.output &&
          typeof output.output === "object" &&
          "status" in output.output
            ? (output.output as { status?: string }).status
            : undefined;
        if (status === "continue") {
          process.env.HARNESS_FORCE_RED = "1";
          await mkdir(path.join(workspaceRoot, "tests"), { recursive: true });
          await writeFile(
            path.join(workspaceRoot, "tests", "greet.test.ts"),
            'test("greets", () => { throw new Error("not implemented"); });\n',
            "utf8",
          );
        }
        return output;
      }
      if (request.role === "implementer") {
        delete process.env.HARNESS_FORCE_RED;
        await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
        await writeFile(
          path.join(workspaceRoot, "src", "greet.ts"),
          'export const greet = () => "hi";\n',
          "utf8",
        );
      }
      return inner.run(request);
    },
  };
}
