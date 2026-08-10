import type { HarnessConfig } from "../src/config.js";
import type { CommandResult } from "../src/commands.js";
import type { HarnessEngine } from "../src/engine.js";
import type { RunState } from "../src/domain.js";
import type { CommandRunner } from "../src/application/dependencies.js";
import {
  buildFixtureConfig,
  createProjectFixture,
} from "./testkit/project-fixture.js";

export { createProjectFixture } from "./testkit/project-fixture.js";
export type { ProjectFixture } from "./testkit/project-fixture.js";
export { createScriptedBackend } from "./testkit/scripted-backend.js";
export type { ScriptedStep } from "./testkit/scripted-backend.js";
export { git } from "./testkit/git.js";

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
        ...partial,
      };
    },
  };
}

/** Clear the grillReady gate and advance into planning / the next grilling turn. */
export async function confirmGrillAndAdvance(
  engine: HarnessEngine,
  runId: string,
  feedback?: string,
  options: {
    /** When true, auto-retry a baseline failure with an exit-0 command. */
    clearBaselineFailure?: boolean;
    testCommand?: string;
  } = {},
): Promise<RunState> {
  await engine.confirmGrill(runId, feedback ? { feedback } : {});
  let state = await engine.advance(runId);
  if (state.verificationReady) {
    state = await engine.confirmVerification(runId, {
      patch: state.verificationReady.proposedPatch,
    });
    state = await engine.advance(runId);
  }
  if (options.clearBaselineFailure && state.verificationBaselineReady) {
    state = await engine.retryVerificationBaseline(runId, {
      testCommand: options.testCommand ?? 'node -e "process.exit(0)"',
    });
    if (!state.verificationBaselineReady) {
      state = await engine.advance(runId);
    }
  }
  return state;
}

/** Accept the verification gate and continue advancing. */
export async function confirmVerificationAndAdvance(
  engine: HarnessEngine,
  runId: string,
  options: Parameters<HarnessEngine["confirmVerification"]>[1] & {
    /** When true, auto-retry a baseline failure with an exit-0 command. */
    clearBaselineFailure?: boolean;
    testCommand?: string;
  } = {},
): Promise<RunState> {
  const { clearBaselineFailure, testCommand, ...confirmOptions } = options;
  let state = await engine.confirmVerification(runId, confirmOptions);
  state = await engine.advance(runId);
  if (clearBaselineFailure && state.verificationBaselineReady) {
    state = await engine.retryVerificationBaseline(runId, {
      testCommand: testCommand ?? 'node -e "process.exit(0)"',
    });
    if (!state.verificationBaselineReady) {
      state = await engine.advance(runId);
    }
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
