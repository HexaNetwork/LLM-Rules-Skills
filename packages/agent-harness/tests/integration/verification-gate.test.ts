import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessEngine } from "../../src/engine.js";
import { confirmGrillAndAdvance } from "../helpers.js";
import { createProjectFixture, type ProjectFixture } from "../testkit/project-fixture.js";
import { createScriptedBackend } from "../testkit/scripted-backend.js";

const REFLECT_OUTPUT = {
  proposedTitle: "Add greeting tone",
  summary: "Restated greeting feature",
  restatement: "Add a greeting feature.",
  goal: "Ship a greeting",
  users: ["end users"],
  inScope: ["greeting"],
  outOfScope: [],
  assumptions: [],
  unknowns: [],
};

describe("verification gate integration", () => {
  let fixture: ProjectFixture | undefined;

  afterEach(async () => {
    await fixture?.cleanup();
    fixture = undefined;
  });

  it("profiler proposal updates frozen config and planner defaultTestCommand", async () => {
    fixture = await createProjectFixture({
      config: {
        agent: { promptBuilder: false, schemaRepairAttempts: 0, timeoutMs: 5_000 },
        workflow: {
          tdd: false,
          testPathPatterns: ["**/*.spec.ts"],
        },
        commands: {
          test: "npm test",
          gates: [],
        },
        git: { enabled: false },
        knowledge: {
          graphify: { enabled: false },
          guidance: { enabled: false },
        },
      },
      initialFiles: {
        "package.json": JSON.stringify({
          name: "fixture",
          scripts: { test: "vitest run", "test:unit": "vitest run --config vitest.unit.config.ts" },
        }),
      },
    });

    const scripted = createScriptedBackend([
      { role: "reflector", output: REFLECT_OUTPUT },
      {
        role: "griller",
        output: {
          status: "ready_to_plan",
          summary: "Ready",
          resolutions: [],
        },
      },
      {
        role: "project-profiler",
        output: {
          summary: "Prefer the unit vitest script and tighten patterns",
          configPatch: {
            commands: { test: "npm run test:unit" },
            workflow: { testPathPatterns: ["**/*.test.ts", "tests/**/*.ts"] },
          },
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
              description: "Render greeting",
              acceptanceCriteria: ["ok"],
              blockedBy: [],
              tdd: false,
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

    const engine = new HarnessEngine(fixture.config, { backend: scripted.backend });
    let state = await engine.start("Add greeting");
    state = await engine.advance(state.runId);
    state = await engine.answer(state.runId, state.activeQuestionId!, REFLECT_OUTPUT.restatement);
    state = await engine.advance(state.runId);
    expect(state.grillReady).toBeTruthy();

    state = await engine.confirmGrill(state.runId);
    state = await engine.advance(state.runId);
    expect(state.phase).toBe("awaiting_input");
    expect(state.verificationReady?.proposedPatch.commands?.test).toBe("npm run test:unit");

    const profilerCall = scripted.calls.find((call) => call.role === "project-profiler");
    expect(profilerCall).toBeTruthy();
    const profilerPayload = JSON.stringify(profilerCall?.input);
    expect(profilerPayload).toContain("package.json");
    expect(profilerPayload).toContain("confirmedBrief");
    expect(profilerPayload).not.toMatch(/"idea"\s*:/);

    state = await engine.confirmVerification(state.runId, {
      patch: state.verificationReady!.proposedPatch,
    });
    expect(engine.config.commands.test).toBe("npm run test:unit");
    expect(engine.config.workflow.testPathPatterns).toEqual([
      "**/*.test.ts",
      "tests/**/*.ts",
    ]);

    const frozen = JSON.parse(
      await readFile(
        path.join(fixture.root, ".agent-harness", "runs", state.runId, "config.json"),
        "utf8",
      ),
    ) as { commands: { test: string }; workflow: { testPathPatterns: string[] } };
    expect(frozen.commands.test).toBe("npm run test:unit");

    state = await engine.advance(state.runId);
    const plannerCall = scripted.calls.find((call) => call.role === "planner");
    expect(plannerCall).toBeTruthy();
    const plannerPayload = JSON.stringify(plannerCall?.input);
    expect(plannerPayload).toContain("npm run test:unit");
    expect(plannerPayload).toContain("confirmedBrief");
    expect(plannerPayload).not.toMatch(/"idea"\s*:/);
    // After confirmGrillAndAdvance-style flow the helper would finish planning;
    // here we stop once the planner saw the updated default.
    expect(state.tasks[0]?.id).toBe("greet");
  });

  it("confirmGrillAndAdvance auto-clears the verification gate", async () => {
    fixture = await createProjectFixture({
      config: {
        agent: { promptBuilder: false, schemaRepairAttempts: 0, timeoutMs: 5_000 },
        workflow: { tdd: false },
        commands: { test: 'node -e "process.exit(0)"', gates: [] },
        git: { enabled: false },
        knowledge: { graphify: { enabled: false }, guidance: { enabled: false } },
      },
    });
    const scripted = createScriptedBackend([
      { role: "reflector", output: REFLECT_OUTPUT },
      {
        role: "griller",
        output: { status: "ready_to_plan", summary: "Ready", resolutions: [] },
      },
      {
        role: "planner",
        output: {
          summary: "One task",
          tasks: [
            {
              id: "greet",
              title: "Ship greeting",
              description: "Render greeting",
              acceptanceCriteria: ["ok"],
              blockedBy: [],
              tdd: false,
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
    const engine = new HarnessEngine(fixture.config, { backend: scripted.backend });
    let state = await engine.start("Add greeting");
    state = await engine.advance(state.runId);
    state = await engine.answer(state.runId, state.activeQuestionId!, REFLECT_OUTPUT.restatement);
    state = await engine.advance(state.runId);
    state = await confirmGrillAndAdvance(engine, state.runId);
    expect(state.verificationConfirmedAt).toBeTruthy();
    expect(state.tasks.length).toBeGreaterThan(0);
  });
});
