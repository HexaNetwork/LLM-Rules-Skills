import type { HarnessConfig } from "../src/config.js";
import type { HarnessEngine } from "../src/engine.js";
import type { RunState } from "../src/domain.js";
import {
  buildFixtureConfig,
  createProjectFixture,
} from "./testkit/project-fixture.js";

export { createProjectFixture } from "./testkit/project-fixture.js";
export type { ProjectFixture } from "./testkit/project-fixture.js";
export { createScriptedBackend } from "./testkit/scripted-backend.js";
export type { ScriptedStep } from "./testkit/scripted-backend.js";
export { git } from "./testkit/git.js";

/** Clear the grillReady gate and advance into planning / the next grilling turn. */
export async function confirmGrillAndAdvance(
  engine: HarnessEngine,
  runId: string,
  feedback?: string,
): Promise<RunState> {
  await engine.confirmGrill(runId, feedback ? { feedback } : {});
  return engine.advance(runId);
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
