import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { HarnessConfigSchema, type HarnessConfig } from "../src/config.js";

export async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-harness-v2-"));
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, "README.md"), "# Fixture\n", "utf8");
  return root;
}

export function fixtureConfig(
  root: string,
  overrides: Partial<HarnessConfig> = {},
): HarnessConfig {
  const base = HarnessConfigSchema.parse({
    version: 2,
    repositoryRoot: root,
    stateDirectory: ".agent-harness",
    models: { small: "small-model", capable: "capable-model", roles: {} },
    agent: {
      provider: "cursor",
      timeoutMs: 1_000,
      promptBuilder: true,
      schemaRepairAttempts: 0,
    },
    workflow: {
      tdd: true,
      maxStepsPerRun: 25,
      maxTestAttempts: 2,
      maxImplementationAttempts: 3,
      maxReviewAttempts: 2,
      maxFogPasses: 3,
      contextResults: 6,
      contextCharacters: 12_000,
    },
    commands: { test: "node -e \"process.exit(0)\"", gates: [] },
    git: {
      enabled: false,
      baseBranch: "main",
      branchPrefix: "harness",
      remote: "origin",
      push: false,
      openPullRequest: false,
    },
    tracker: { kind: "local" },
    knowledge: { sources: ["README.md", "docs"], chunkCharacters: 400 },
  });
  return HarnessConfigSchema.parse({
    ...base,
    ...overrides,
    models: { ...base.models, ...overrides.models },
    agent: { ...base.agent, ...overrides.agent },
    workflow: { ...base.workflow, ...overrides.workflow },
    commands: { ...base.commands, ...overrides.commands },
    git: { ...base.git, ...overrides.git },
    tracker: { ...base.tracker, ...overrides.tracker },
    knowledge: { ...base.knowledge, ...overrides.knowledge },
  });
}
