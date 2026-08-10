import path from "node:path";
import { writeFile } from "node:fs/promises";
import yaml from "js-yaml";
import {
  createCli,
  productionCliDependencies,
  type CliDependencies,
} from "../../src/cli/create-cli.js";
import type { HarnessConfig } from "../../src/config.js";
import type { ProjectFixture } from "../testkit/project-fixture.js";

export type CliRunResult = {
  code: number;
  stdout: string[];
  stderr: string[];
  error?: unknown;
};

/** Run the composable CLI with captured console output (no process.exit). */
export async function runCli(
  args: string[],
  dependencies: Partial<CliDependencies> = {},
): Promise<CliRunResult> {
  const deps: CliDependencies = {
    ...productionCliDependencies(),
    runGraphifySetup: async () => {
      throw new Error("Graphify setup must be faked in acceptance tests");
    },
    ...dependencies,
  };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...parts: unknown[]) => {
    stdout.push(parts.map(String).join(" "));
  };
  console.error = (...parts: unknown[]) => {
    stderr.push(parts.map(String).join(" "));
  };
  try {
    await createCli(deps).parseAsync(["node", "agent-harness", ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const code =
      error && typeof error === "object" && typeof (error as { exitCode?: unknown }).exitCode === "number"
        ? Number((error as { exitCode: number }).exitCode)
        : 1;
    const helpOrVersion =
      error &&
      typeof error === "object" &&
      ((error as { code?: string }).code === "commander.helpDisplayed" ||
        (error as { code?: string }).code === "commander.versionDisplayed");
    return {
      code: helpOrVersion ? 0 : code || 1,
      stdout,
      stderr,
      error,
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

export async function writeAcceptanceConfig(
  fixture: ProjectFixture,
  overrides: Partial<HarnessConfig> = {},
): Promise<string> {
  const configPath = path.join(fixture.root, "agent-harness.config.yaml");
  const serializable = {
    version: 2,
    repositoryRoot: ".",
    stateDirectory: ".agent-harness",
    models: fixture.config.models,
    agent: {
      provider: "cursor",
      timeoutMs: fixture.config.agent.timeoutMs,
      promptBuilder: false,
      schemaRepairAttempts: 0,
      ...(overrides.agent ?? {}),
    },
    workflow: {
      tdd: false,
      generateCommitMessages: false,
      testPathPatterns: fixture.config.workflow.testPathPatterns,
      ...(overrides.workflow ?? {}),
    },
    commands: {
      test: 'node -e "process.exit(0)"',
      gates: [],
      ...(overrides.commands ?? {}),
    },
    git: {
      enabled: false,
      ...(overrides.git ?? {}),
    },
    tracker: { kind: "local" },
    knowledge: {
      sources: ["README.md", "docs"],
      graphify: { enabled: false },
      guidance: { enabled: false },
      ...(overrides.knowledge ?? {}),
    },
  };
  await writeFile(configPath, `${yaml.dump(serializable, { noRefs: true, lineWidth: -1 })}\n`, "utf8");
  return configPath;
}

export const ACCEPTANCE_REFLECT = {
  summary: "Restated greeting feature",
  restatement: "Add a greeting feature with a chosen tone.",
  goal: "Ship a greeting users understand",
  users: ["end users"],
  inScope: ["tone choice"],
  outOfScope: [],
  assumptions: [],
  unknowns: ["tone"],
};

export const ACCEPTANCE_GRILL_QUESTION = {
  prompt: "Should the greeting be formal or casual?",
  context: "The choice sets the voice users encounter throughout the feature.",
  options: [
    { id: "formal", label: "Formal", description: "Polished and reserved." },
    { id: "casual", label: "Casual", description: "Warm and direct." },
  ],
  recommendedOptionId: "casual",
  recommendation: "Use casual for a lightweight greeting.",
};
