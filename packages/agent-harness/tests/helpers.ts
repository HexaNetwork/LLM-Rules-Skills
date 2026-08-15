import type { HarnessConfig } from "../src/config/schema.js";
import type { CommandResult } from "../src/commands.js";
import type { WorkerHarnessRuntime } from "../src/application/harness-engine.js";
import type { HighLevelPlan, RunState } from "../src/domain.js";
import type { CommandRunner } from "../src/application/dependencies.js";
import {
  buildFixtureConfig,
  createProjectFixture} from "./testkit/project-fixture.js";

export { createProjectFixture } from "./testkit/project-fixture.js";
export type { ProjectFixture } from "./testkit/project-fixture.js";
export { createScriptedBackend } from "./testkit/scripted-backend.js";
export type { ScriptedStep } from "./testkit/scripted-backend.js";
export { git } from "./testkit/git.js";
import {
  createPlannerPrdSequence,
  SCENARIO_PLANNER_OUTPUT,
  SLICER_ONE_TASK,
} from "./fixtures/plan-pipeline.js";

export {
  HIGH_LEVEL_PLAN,
  PRD_OUTPUT,
  SCENARIO_PLANNER_OUTPUT,
  SLICER_ONE_TASK,
  createPlannerPrdSequence,
} from "./fixtures/plan-pipeline.js";

/** Planner + scenario-planner + issue-slicer handlers for createFakeBackend tests. */
export function planningRoleHandlers(options: {
  slicer?: typeof SLICER_ONE_TASK;
  scenarios?: typeof SCENARIO_PLANNER_OUTPUT;
} = {}) {
  const seq = createPlannerPrdSequence();
  return {
    planner: seq.planner,
    "scenario-planner": () => options.scenarios ?? SCENARIO_PLANNER_OUTPUT,
    "issue-slicer": () => options.slicer ?? SLICER_ONE_TASK,
  };
}

/** Post-slice roles that take a run through implement → scenario tests → final review. */
export const INTENT_FIRST_EXECUTION_HANDLERS = {
  implementer: () => ({ summary: "Implemented", changedFiles: ["src/greet.ts"] }),
  "task-reviewer": () => ({ approved: true, summary: "Looks good", findings: [] as const }),
  reviewer: () => ({ approved: true, summary: "Looks good", findings: [] as const }),
  "scenario-writer": () => ({
    status: "implemented" as const,
    summary: "Scenario tests written",
    testPaths: ["tests/greet.test.ts"],
    changedFiles: ["tests/greet.test.ts"],
  }),
};

/** Deterministic command runner that always exits 0 (keeps baseline flowing in suites). */
export function passingCommandRunner(
  override?: (command: string) => Partial<CommandResult> | undefined,
): CommandRunner {
  return {
    async run(command) {
      const partial = override?.(command) ?? {};
      return {
        command,
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 1,
        timedOut: false,
        ...partial};
    }};
}

/**
 * Clear the grillReady gate and advance through verification into the planReady gate
 * (or through plan confirmation when autoConfirmPlan is true — default).
 */
export async function confirmGrillAndAdvance(
  engine: WorkerHarnessRuntime,
  runId: string,
  feedback?: string,
  options: {
    /** When true, auto-retry a baseline failure with an exit-0 command. */
    clearBaselineFailure?: boolean;
    verificationCommand?: string;
    /** When false, stop at planReady instead of auto-approving the plan. Default true. */
    autoConfirmPlan?: boolean;
  } = {},
): Promise<RunState> {
  await engine.confirmGrill(runId, feedback ? { feedback } : {});
  let state = await engine.advance(runId);
  if (state.verificationReady) {
    state = await engine.confirmVerification(runId, {
      patch: state.verificationReady.proposedPatch});
    state = await engine.advance(runId);
  }
  if (options.clearBaselineFailure && state.verificationBaselineReady) {
    state = await engine.retryVerificationBaseline(runId, {
      verificationCommand: options.verificationCommand ?? 'node -e "process.exit(0)"'});
    if (!state.verificationBaselineReady) {
      state = await engine.advance(runId);
    }
  }
  if (options.autoConfirmPlan !== false && state.planReady && !feedback) {
    state = await confirmPlanAndAdvance(engine, runId);
  }
  return state;
}

/** Approve the high-level plan and advance through to-prd + issue-slicer. */
export async function confirmPlanAndAdvance(
  engine: WorkerHarnessRuntime,
  runId: string,
  options: { feedback?: string; plan?: HighLevelPlan } = {},
): Promise<RunState> {
  await engine.confirmPlan(runId, options);
  return engine.advance(runId);
}

/** Accept the verification gate and continue advancing. */
export async function confirmVerificationAndAdvance(
  engine: WorkerHarnessRuntime,
  runId: string,
  options: Parameters<WorkerHarnessRuntime["confirmVerification"]>[1] & {
    /** When true, auto-retry a baseline failure with an exit-0 command. */
    clearBaselineFailure?: boolean;
    verificationCommand?: string;
    /** When false, stop at planReady instead of auto-approving the plan. Default true. */
    autoConfirmPlan?: boolean;
  } = {},
): Promise<RunState> {
  const { clearBaselineFailure, verificationCommand, autoConfirmPlan, ...confirmOptions } = options;
  let state = await engine.confirmVerification(runId, confirmOptions);
  state = await engine.advance(runId);
  if (clearBaselineFailure && state.verificationBaselineReady) {
    state = await engine.retryVerificationBaseline(runId, {
      verificationCommand: verificationCommand ?? 'node -e "process.exit(0)"'});
    if (!state.verificationBaselineReady) {
      state = await engine.advance(runId);
    }
  }
  if (autoConfirmPlan !== false && state.planReady) {
    state = await confirmPlanAndAdvance(engine, runId);
  }
  return state;
}

/**
 * Legacy temp-root helper. Prefer `createProjectFixture()` for new tests so
 * cleanup boundaries and git helpers stay consistent.
 */
export async function fixtureRoot(): Promise<string> {
  const fixture = await createProjectFixture();
  return fixture.root;
}

export function fixtureConfig(
  root: string,
  overrides: Partial<HarnessConfig> = {},
): HarnessConfig {
  return buildFixtureConfig(root, overrides);
}
