import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessEngine } from "../../src/engine.js";
import {
  confirmGrillAndAdvance,
  confirmPlanAndAdvance,
  HIGH_LEVEL_PLAN,
  passingCommandRunner,
  PRD_OUTPUT, SCENARIO_PLANNER_OUTPUT} from "../helpers.js";
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
  unknowns: []};

describe("verification gate integration", () => {
  let fixture: ProjectFixture | undefined;

  afterEach(async () => {
    await fixture?.cleanup();
    fixture = undefined;
  });

  it("profiler proposal updates frozen config and planner verification commands", async () => {
    fixture = await createProjectFixture({
      config: {
        agent: { promptBuilder: false, schemaRepairAttempts: 0, timeoutMs: 5_000 },
        workflow: {
          testPathPatterns: ["**/*.spec.ts"]},
        commands: {
          verification: [{ id: "test", command: "npm test", timeoutMs: 600_000 }]},
        git: { enabled: false },
        knowledge: {
          graphify: { enabled: false },
          guidance: { enabled: false }}},
      initialFiles: {
        "package.json": JSON.stringify({
          name: "fixture",
          scripts: { test: "vitest run", "test:unit": "vitest run --config vitest.unit.config.ts" }})}});

    const scripted = createScriptedBackend([
      { role: "reflector", output: REFLECT_OUTPUT },
      {
        role: "griller",
        output: {
          status: "ready_to_plan",
          summary: "Ready",
          resolutions: []}},
      {
        role: "project-profiler",
        output: {
          summary: "Prefer the unit vitest script and tighten patterns",
          configPatch: {
            commands: { verification: [{ id: "unit", command: "npm run test:unit", timeoutMs: 600_000 }] },
            workflow: { testPathPatterns: ["**/*.test.ts", "tests/**/*.ts"] }}}},
      { role: "planner", output: HIGH_LEVEL_PLAN },
      { role: "planner", output: PRD_OUTPUT },
      { role: "scenario-planner", output: SCENARIO_PLANNER_OUTPUT },
      {
        role: "issue-slicer",
        output: {

          summary: "One task",
          tasks: [
            {
              id: "greet",
              title: "Ship greeting",
              description: "Render greeting",
              acceptanceCriteria: ["ok"],
              scenarioIds: ["greet-happy"],
              blockedBy: []}],
          proposedInstalls: []}},
      {
        role: "implementer",
        output: { summary: "Built", changedFiles: ["src/greet.ts"] }},
      {
        role: "task-reviewer",
        output: { approved: true, summary: "ok", findings: [] }},
      {
        role: "scenario-writer",
        output: {
          status: "implemented",
          summary: "Scenario tests",
          testPaths: ["tests/greet.test.ts"],
          changedFiles: ["tests/greet.test.ts"],
        }},
      {
        role: "reviewer",
        output: { approved: true, summary: "final ok", findings: [] }}]);

    const engine = new HarnessEngine(fixture.config, {
      backend: scripted.backend,
      commands: passingCommandRunner()});
    let state = await engine.start("Add greeting");
    state = await engine.advance(state.runId);
    state = await engine.answer(state.runId, state.activeQuestionId!, REFLECT_OUTPUT.restatement);
    state = await engine.advance(state.runId);
    expect(state.grillReady).toBeTruthy();

    state = await engine.confirmGrill(state.runId);
    state = await engine.advance(state.runId);
    expect(state.phase).toBe("awaiting_input");
    expect(state.verificationReady?.proposedPatch.commands?.verification?.[0]?.command).toBe("npm run test:unit");

    const profilerCall = scripted.calls.find((call) => call.role === "project-profiler");
    expect(profilerCall).toBeTruthy();
    const profilerPayload = JSON.stringify(profilerCall?.input);
    expect(profilerPayload).toContain("package.json");
    expect(profilerPayload).toContain("confirmedBrief");
    expect(profilerPayload).not.toMatch(/"idea"\s*:/);

    state = await engine.confirmVerification(state.runId, {
      patch: state.verificationReady!.proposedPatch});
    expect(engine.config.commands.verification[0]?.command).toBe("npm run test:unit");
    expect(engine.config.workflow.testPathPatterns).toEqual([
      "**/*.test.ts",
      "tests/**/*.ts"]);

    const frozen = JSON.parse(
      await readFile(
        path.join(fixture.root, ".agent-harness", "runs", state.runId, "config.json"),
        "utf8",
      ),
    ) as { commands: { verification: Array<{ command: string }> }; workflow: { testPathPatterns: string[] } };
    expect(frozen.commands.verification[0]?.command).toBe("npm run test:unit");

    state = await engine.advance(state.runId);
    expect(state.verificationBaselinePassedAt).toBeTruthy();
    expect(state.planReady?.summary).toBeTruthy();
    expect(state.tasks).toHaveLength(0);
    state = await confirmPlanAndAdvance(engine, state.runId);
    const slicerCall = scripted.calls.find((call) => call.role === "issue-slicer");
    expect(slicerCall).toBeTruthy();
    const slicerPayload = JSON.stringify(slicerCall?.input);
    expect(slicerPayload).not.toContain("npm run test:unit");
    expect(slicerPayload).not.toMatch(/"testTargetTemplate"\s*:/);
    expect(slicerPayload).not.toMatch(/"verificationCommands"\s*:/);
    expect(slicerPayload).toContain("confirmedBrief");
    expect(slicerPayload).not.toMatch(/"idea"\s*:/);
    expect(state.tasks[0]?.id).toBe("greet");
  });

  it("confirmGrillAndAdvance auto-clears the verification gate", async () => {
    fixture = await createProjectFixture({
      config: {
        agent: { promptBuilder: false, schemaRepairAttempts: 0, timeoutMs: 5_000 },
        workflow: { },
        commands: { verification: [{ id: "test", command: 'node -e "process.exit(0)"', timeoutMs: 600_000 }] },
        git: { enabled: false },
        knowledge: { graphify: { enabled: false }, guidance: { enabled: false } }}});
    const scripted = createScriptedBackend([
      { role: "reflector", output: REFLECT_OUTPUT },
      {
        role: "griller",
        output: { status: "ready_to_plan", summary: "Ready", resolutions: [] }},
      { role: "planner", output: HIGH_LEVEL_PLAN },
      { role: "planner", output: PRD_OUTPUT },
      { role: "scenario-planner", output: SCENARIO_PLANNER_OUTPUT },
      {
        role: "issue-slicer",
        output: {

          summary: "One task",
          tasks: [
            {
              id: "greet",
              title: "Ship greeting",
              description: "Render greeting",
              acceptanceCriteria: ["ok"],
              scenarioIds: ["greet-happy"],
              blockedBy: []}],
          proposedInstalls: []}},
      {
        role: "implementer",
        output: { summary: "Built", changedFiles: ["src/greet.ts"] }},
      {
        role: "task-reviewer",
        output: { approved: true, summary: "ok", findings: [] }},
      {
        role: "scenario-writer",
        output: {
          status: "implemented",
          summary: "Scenario tests",
          testPaths: ["tests/greet.test.ts"],
          changedFiles: ["tests/greet.test.ts"],
        }},
      {
        role: "reviewer",
        output: { approved: true, summary: "final ok", findings: [] }}]);
    const engine = new HarnessEngine(fixture.config, {
      backend: scripted.backend,
      commands: passingCommandRunner()});
    let state = await engine.start("Add greeting");
    state = await engine.advance(state.runId);
    state = await engine.answer(state.runId, state.activeQuestionId!, REFLECT_OUTPUT.restatement);
    state = await engine.advance(state.runId);
    state = await confirmGrillAndAdvance(engine, state.runId);
    expect(state.verificationConfirmedAt).toBeTruthy();
    expect(state.verificationBaselinePassedAt).toBeTruthy();
    expect(state.tasks.length).toBeGreaterThan(0);
  });

  it("baseline failure opens a gate; retry with a new command reaches the planner", async () => {
    fixture = await createProjectFixture({
      config: {
        agent: { promptBuilder: false, schemaRepairAttempts: 0, timeoutMs: 5_000 },
        workflow: { },
        commands: { verification: [{ id: "test", command: "npm test", timeoutMs: 600_000 }] },
        git: { enabled: false },
        knowledge: { graphify: { enabled: false }, guidance: { enabled: false } }}});
    const scripted = createScriptedBackend([
      { role: "reflector", output: REFLECT_OUTPUT },
      {
        role: "griller",
        output: { status: "ready_to_plan", summary: "Ready", resolutions: [] }},
      {
        role: "project-profiler",
        output: {
          summary: "Use failing suite",
          configPatch: { commands: { verification: [{ id: "test", command: "failing-baseline", timeoutMs: 600_000 }] } }}},
      { role: "planner", output: HIGH_LEVEL_PLAN },
      { role: "planner", output: PRD_OUTPUT },
      { role: "scenario-planner", output: SCENARIO_PLANNER_OUTPUT },
      {
        role: "issue-slicer",
        output: {

          summary: "One task",
          tasks: [
            {
              id: "greet",
              title: "Ship greeting",
              description: "Render greeting",
              acceptanceCriteria: ["ok"],
              scenarioIds: ["greet-happy"],
              blockedBy: []}],
          proposedInstalls: []}}]);
    const engine = new HarnessEngine(fixture.config, {
      backend: scripted.backend,
      commands: {
        async run(command) {
          if (command === "failing-baseline") {
            return {
              command,
              exitCode: 1,
              stdout: "AssertionError",
              stderr: "",
              durationMs: 4,
              timedOut: false};
          }
          return {
            command,
            exitCode: 0,
            stdout: "",
            stderr: "",
            durationMs: 1,
            timedOut: false};
        }}});
    let state = await engine.start("Add greeting");
    state = await engine.advance(state.runId);
    state = await engine.answer(state.runId, state.activeQuestionId!, REFLECT_OUTPUT.restatement);
    state = await engine.advance(state.runId);
    state = await engine.confirmGrill(state.runId);
    state = await engine.advance(state.runId);
    state = await engine.confirmVerification(state.runId, {
      patch: state.verificationReady!.proposedPatch});
    state = await engine.advance(state.runId);
    expect(state.verificationBaselineReady?.evidence.exitCode).toBe(1);

    state = await engine.retryVerificationBaseline(state.runId, {
      verificationCommand: 'node -e "process.exit(0)"'});
    expect(state.verificationBaselinePassedAt).toBeTruthy();
    state = await engine.advance(state.runId);
    expect(state.planReady?.summary).toBeTruthy();
    state = await confirmPlanAndAdvance(engine, state.runId);
    expect(state.tasks[0]?.id).toBe("greet");
  });
});
