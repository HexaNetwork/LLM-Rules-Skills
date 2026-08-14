import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import yaml from "js-yaml";
import type { AgentBackend } from "../../src/infrastructure/agents/types.js";
import type { HarnessConfig } from "../../src/config/schema.js";
import { startUiServer, type UiServer } from "../../src/ui/server.js";
import { withDiagnosticArtifacts, type DiagnosticContext } from "../testkit/diagnostics.js";
import {
  createProjectFixture,
  type ProjectFixture} from "../testkit/project-fixture.js";
import {
  createScriptedBackend,
  type ScriptedStep} from "../testkit/scripted-backend.js";

export const REFLECT_OUTPUT = {
  proposedTitle: "Add greeting tone",
  summary: "Restated greeting feature",
  restatement: "Add a greeting feature with a chosen tone.",
  goal: "Ship a greeting users understand",
  users: ["end users"],
  inScope: ["tone choice", "greeting copy"],
  outOfScope: ["localization"],
  assumptions: ["English only"],
  unknowns: ["formal vs casual"]};

export const FIRST_GRILL_QUESTION = {
  prompt: "Should the greeting be formal or casual?",
  context: "The choice sets the voice users encounter throughout the feature.",
  options: [
    { id: "formal", label: "Formal", description: "Polished and reserved." },
    { id: "casual", label: "Casual", description: "Warm and direct." }],
  recommendedOptionId: "casual",
  recommendation: "Use casual for a lightweight greeting."};

export const HAPPY_PATH_STEPS: ScriptedStep[] = [
  { role: "reflector", output: REFLECT_OUTPUT },
  {
    role: "griller",
    output: {
      status: "needs_input",
      summary: "Need tone",
      questions: [FIRST_GRILL_QUESTION]}},
  {
    role: "griller",
    output: {
      status: "ready_to_plan",
      summary: "Tone decided",
      resolutions: [
        {
          id: "tone",
          question: FIRST_GRILL_QUESTION.prompt,
          answer: "Casual",
          summary: "Use a casual greeting"}]}},
  {
    role: "project-profiler",
    output: {
      summary: "Keep the deterministic verification command",
      configPatch: {
        commands: {
          verification: [
            { id: "test", command: 'node -e "process.exit(0)"', timeoutMs: 600_000 },
          ],
        },
        workflow: { testPathPatterns: ["tests/**"] },
      },
    },
  },
  {
    role: "planner",
    output: {
      summary: "One high-level plan",
      problemStatement: "Users need a casual greeting.",
      solution: "Ship a greeting feature with a chosen tone.",
      approach: "Add a small greeting module, then wire it into the UI.",
      constraints: ["Keep scope narrow"],
      outOfScope: ["Localization"],
      openQuestions: []}},
  {
    role: "planner",
    output: {
      summary: "Greeting PRD",
      problemStatement: "Users need a casual greeting.",
      solution: "Ship a greeting feature with a chosen tone.",
      userStories: [
        "As a user, I want a casual greeting, so that the product feels friendly"],
      implementationDecisions: ["Add a greeting module"],
      testingDecisions: ["Test public greeting behavior"],
      outOfScope: ["Localization"],
      furtherNotes: ""}},
  {
    role: "scenario-planner",
    output: {
      summary: "Greeting scenarios",
      scenarios: [
        {
          id: "greet-happy",
          title: "Casual greeting happy path",
          kind: "happy-path",
          intent: "Users receive a casual greeting",
          given: "The greeting feature is available",
          when: "A user requests a greeting",
          then: "The response is casual",
        },
      ],
    },
  },
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
          blockedBy: [],
          scenarioIds: ["greet-happy"]}],
      proposedInstalls: []}},
  {
    role: "implementer",
    output: { summary: "Built", changedFiles: ["src/greet.ts"] }},
  {
    role: "task-reviewer",
    output: { approved: true, summary: "Looks good", findings: [] }},
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
    output: { approved: true, summary: "Looks good", findings: [] }}];

export type E2EHarness = {
  page: Page;
  fixture: ProjectFixture;
  ui: UiServer;
  scripted: ReturnType<typeof createScriptedBackend>;
  diagnostics: DiagnosticContext;
  configPath?: string;
};

export type E2EHarnessOptions = {
  testName: string;
  steps?: ScriptedStep[];
  backend?: AgentBackend;
  config?: Partial<HarnessConfig>;
  initialFiles?: Record<string, string>;
  initGit?: boolean;
  dirtyFile?: { relativePath: string; contents: string };
  /** When true, write agent-harness.config.yaml and pass configPath for editable settings. */
  persistConfig?: boolean;
  token?: string;
};

/**
 * Boots a ProjectFixture + ScriptedBackend + real loopback UI for one Playwright
 * test. On failure, copies .agent-harness into Git-ignored test-results/.
 */
export async function withE2EHarness(
  page: Page,
  options: E2EHarnessOptions,
  body: (harness: E2EHarness) => Promise<void>,
): Promise<void> {
  const fixture = await createProjectFixture({
    config: {
      agent: {
        promptBuilder: false,
        schemaRepairAttempts: 0,
        timeoutMs: 10_000,
        provider: "cursor",
        ...(options.config?.agent ?? {})},
      workflow: {
        generateCommitMessages: false,
        ...(options.config?.workflow ?? {})},
      commands: {
        verification: [{ id: "test", command: 'node -e "process.exit(0)"', timeoutMs: 600_000 }],
        ...(options.config?.commands ?? {})},
      git: {
        enabled: false,
        ...(options.config?.git ?? {})},
      knowledge: {
        repositoryIntelligence: { enabled: false },
        guidance: { enabled: false },
        ...(options.config?.knowledge ?? {})},
      models: options.config?.models,
      tracker: options.config?.tracker},
    initialFiles: options.initialFiles});

  let configPath: string | undefined;
  if (options.persistConfig) {
    configPath = path.join(fixture.root, "agent-harness.config.yaml");
    await writeFixtureConfigYaml(configPath, fixture.config);
  }

  if (options.initGit) {
    await fixture.initGit();
  }
  if (options.dirtyFile) {
    await fixture.write(options.dirtyFile.relativePath, options.dirtyFile.contents);
  }

  const scripted = createScriptedBackend(options.steps ?? HAPPY_PATH_STEPS);
  const backend = options.backend ?? scripted.backend;

  try {
    await withDiagnosticArtifacts({ testName: options.testName, fixture }, async (diagnostics) => {
      const ui = await startUiServer({
        config: fixture.config,
        backend,
        configPath,
        port: 0,
        token: options.token ?? "e2e-token",
        openBrowser: false});
      try {
        await page.goto(ui.url);
        await expect(page.getByRole("button", { name: /new run/i })).toBeVisible();
        await body({ page, fixture, ui, scripted, diagnostics, configPath });
      } finally {
        await ui.close();
      }
    });
  } finally {
    await fixture.cleanup();
  }
}

export async function startNewRun(page: Page, idea: string): Promise<void> {
  const dialog = page.locator("#newRunDialog");
  if (!(await dialog.isVisible())) {
    const newRun = page.locator("#newRunBtn");
    if (await newRun.isVisible()) {
      await newRun.click();
    } else {
      await page.getByRole("button", { name: /start your first run/i }).click();
    }
  }
  await expect(dialog).toBeVisible();
  await expect(dialog).toBeEnabled();
  await page.locator("#idea").fill(idea);
  await page.getByTestId("start-run").click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
}

export async function waitForRunStatus(page: Page, pattern: RegExp | string): Promise<void> {
  await expect(page.getByTestId("run-status")).toContainText(pattern, { timeout: 20_000 });
}

export async function confirmReflectBrief(
  page: Page,
  restatement = "Confirmed: casual greeting feature.",
): Promise<void> {
  const form = page.getByTestId("reflect-form");
  await expect(form).toBeVisible({ timeout: 20_000 });
  const structured = page.locator("#reflectRestatement");
  if (await structured.count()) {
    await structured.fill(restatement);
  } else {
    await form.locator('textarea[name="answer"]').fill(restatement);
  }
  await form.getByRole("button", { name: /confirm & continue to grill/i }).click();
}

export async function answerCasualGrill(page: Page): Promise<void> {
  const batch = page.getByTestId("question-batch");
  await expect(batch).toBeVisible({ timeout: 20_000 });
  await batch.getByRole("button", { name: /^Casual/i }).click();
  await page.getByTestId("submit-answers").click();
}

export async function continueToPlanning(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: /continue to planning/i })).toBeVisible({
    timeout: 20_000});
  await page.getByRole("button", { name: /continue to planning/i }).click();
}

export async function confirmVerificationSettings(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: /confirm verification/i })).toBeVisible({
    timeout: 20_000});
  await page.getByRole("button", { name: /confirm verification/i }).click();
}

export async function approveHighLevelPlan(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: /approve plan/i })).toBeVisible({
    timeout: 20_000});
  await page.getByRole("button", { name: /approve plan/i }).click();
}

export async function apiJson<T>(
  ui: UiServer,
  pathname: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${ui.origin}${pathname}`, {
    method: init.method ?? "GET",
    headers: {
      "X-Harness-Token": ui.token,
      ...(init.body ? { "content-type": "application/json" } : {})},
    body: init.body ? JSON.stringify(init.body) : undefined});
  if (!response.ok) {
    throw new Error(`API ${pathname} failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

export async function selectedRunId(page: Page): Promise<string> {
  const selected = page.locator('#runList button.run-item.active[data-run]');
  await expect(selected).toBeVisible({ timeout: 20_000 });
  const runId = await selected.getAttribute("data-run");
  if (!runId) throw new Error("Selected run is missing data-run");
  return runId;
}

export async function resolveRunId(ui: UiServer, prefixOrId: string): Promise<string> {
  const body = await apiJson<{ runs: Array<{ runId: string }> }>(ui, "/api/bootstrap");
  const match = body.runs.find(
    (run) => run.runId === prefixOrId || run.runId.startsWith(prefixOrId),
  );
  if (!match) throw new Error(`No run matching ${prefixOrId}`);
  return match.runId;
}

export async function readFrozenConfig(
  fixture: ProjectFixture,
  runId: string,
): Promise<{ workflow: { testPathPatterns: string[] } }> {
  const raw = await readFile(
    path.join(fixture.root, ".agent-harness", "runs", runId, "config.json"),
    "utf8",
  );
  return JSON.parse(raw) as { workflow: { testPathPatterns: string[] } };
}

async function writeFixtureConfigYaml(configPath: string, config: HarnessConfig): Promise<void> {
  const serializable = {
    version: 2,
    repositoryRoot: ".",
    stateDirectory: config.stateDirectory,
    models: config.models,
    agent: {
      provider: config.agent.provider,
      timeoutMs: config.agent.timeoutMs,
      promptBuilder: config.agent.promptBuilder,
      schemaRepairAttempts: config.agent.schemaRepairAttempts},
    workflow: {
      testPathPatterns: config.workflow.testPathPatterns,
      maxGrillQuestionsPerEpisode: config.workflow.maxGrillQuestionsPerEpisode,
      staleAnswerMinutes: config.workflow.staleAnswerMinutes,
      grillQuestionsPerBatch: config.workflow.grillQuestionsPerBatch},
    commands: {
      verification: config.commands.verification,
      ...(config.commands.testTargetTemplate
        ? { testTargetTemplate: config.commands.testTargetTemplate }
        : {})},
    git: {
      enabled: config.git.enabled,
      baseBranch: config.git.baseBranch,
      autoCommitPreflight: config.git.autoCommitPreflight,
      preflightCommitOrder: config.git.preflightCommitOrder,
      ignoredArtifactPatterns: config.git.ignoredArtifactPatterns},
    tracker: config.tracker,
    knowledge: {
      sources: config.knowledge.sources,
      repositoryIntelligence: { enabled: false },
      guidance: { enabled: false }}};
  await writeFile(configPath, `${yaml.dump(serializable, { noRefs: true, lineWidth: -1 })}\n`, "utf8");
}
