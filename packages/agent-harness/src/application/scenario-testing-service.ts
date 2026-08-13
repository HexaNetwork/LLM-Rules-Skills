import {
  SCENARIO_WRITER_EXPECTED_OUTPUT,
  ScenarioWriterOutputSchema,
  WorkerOutputSchema,
  isTestPath,
  type BuildTask,
  type RunState,
  type ScenarioWriterOutput,
  type TestScenario,
} from "../domain.js";
import { HarnessFailure, RunCancelledError } from "../errors.js";
import { commandEvidence } from "../commands.js";
import { compactDomainSeed } from "../knowledge.js";
import type { ApplicationContext } from "./application-context.js";
import {
  classifyRunnableRed,
  evaluateRepairProgress,
  evidenceFingerprint,
  failingTestIdsFromEvidence,
  failureCategoryFromEvidence,
  frozenCommandsHash,
  repairEdgeKey,
} from "./evidence-fingerprint.js";
import { unique } from "./helpers.js";

/**
 * Convert a recorded test file path into the filter a targeted-test template
 * expects: Gradle-style `--tests` templates get a wildcard class-name pattern;
 * path-based runners (vitest, pytest, …) keep the path.
 */
export function filterForTemplate(testPath: string, template: string): string {
  if (!template.includes("--tests")) return testPath;
  const basename = testPath.replaceAll("\\", "/").split("/").pop() ?? testPath;
  const className = basename.replace(/\.[^.]+$/, "");
  return className ? `*${className}` : testPath;
}

export class ScenarioTestingService {
  constructor(private readonly ctx: ApplicationContext) {}

  async advance(state: RunState): Promise<RunState> {
    if (state.scenarios.length === 0) {
      return this.ctx.store.record(
        { ...state, phase: "crystallizing" },
        "scenarios.skipped",
        { reason: "no scenarios" },
      );
    }
    if (state.scenarios.every((scenario) => scenario.status === "passing")) {
      return this.ctx.store.record(
        { ...state, phase: "crystallizing" },
        "scenarios.completed",
      );
    }

    const active =
      state.scenarios.find((scenario) => scenario.status === "active") ??
      state.scenarios.find((scenario) => scenario.status === "pending");
    if (!active) {
      const failed = state.scenarios.find((scenario) => scenario.status === "failed");
      throw new HarnessFailure(
        failed
          ? `Scenario ${failed.id} failed`
          : "Scenario testing has no pending scenarios",
        "contract",
        false,
      );
    }

    if (active.status === "pending" || active.testPaths.length === 0) {
      const batch = active.status === "pending"
        ? pendingScenarioBatch(state.scenarios, active)
        : [active];
      return this.writeScenarioTests(state, batch);
    }
    return this.runScenario(state, active);
  }

  private async writeScenarioTests(state: RunState, scenarios: TestScenario[]): Promise<RunState> {
    const scenarioIds = new Set(scenarios.map((scenario) => scenario.id));
    const linkedTaskIds = new Set(scenarios.flatMap((scenario) => scenario.taskIds));
    const linkedTasks = state.tasks.filter((task) => linkedTaskIds.has(task.id));
    const scenarioLabel = scenarios.map((scenario) => scenario.id).join(", ");
    const output = await this.ctx.agents.invoke({
      runId: state.runId,
      role: "scenario-writer",
      objective: `Implement scenarios ${scenarioLabel} as automated tests matching their intent`,
      input: {
        scenarios,
        linkedTasks: linkedTasks.map(taskForScenario),
        testPathPatterns: this.ctx.config.workflow.testPathPatterns,
      },
      expectedOutput: SCENARIO_WRITER_EXPECTED_OUTPUT,
      schema: ScenarioWriterOutputSchema,
      // Anchor retrieval to the neighborhoods implementers actually touched,
      // not just scenario prose, so CodeGraph starts from concrete symbols.
      knowledgeQuery: compactDomainSeed(
        ...knowledgeSeedsFromTasks(linkedTasks),
        ...scenarios.flatMap((scenario) => [
          scenario.title,
          scenario.intent,
          scenario.given,
          scenario.when,
          scenario.then,
        ]),
      ),
      signal: this.ctx.signalFor(state.runId),
      causal: {
        phase: state.phase,
        invocationKind: "initial",
        trigger: {
          event: "scenario.started",
          classification: "scenario",
          summary: `Write tests for scenarios ${scenarioLabel}`,
        },
      },
    });

    const testPathsByScenario = scenarioTestPaths(output, scenarios);
    const changedFiles = unique([
      ...[...testPathsByScenario.values()].flat(),
      ...(output.changedFiles ?? []),
    ]);
    const patterns = this.ctx.config.workflow.testPathPatterns;
    const nonTest = changedFiles.filter((file) => !isTestPath(file, patterns));
    if (nonTest.length > 0) {
      throw new HarnessFailure(
        `Scenario-writer must only edit test paths; got: ${nonTest.join(", ")}`,
        "contract",
        true,
      );
    }

    const nextScenarios = state.scenarios.map((scenario) => {
      if (!scenarioIds.has(scenario.id)) return scenario;
      return {
        ...scenario,
        status: "active" as const,
        writerAttempts: scenario.writerAttempts + 1,
        testPaths: unique([
          ...scenario.testPaths,
          ...(testPathsByScenario.get(scenario.id) ?? []),
        ]),
        reviewFindings: [],
      };
    });
    const firstScenario = nextScenarios.find((scenario) => scenario.id === scenarios[0]?.id);
    if (!firstScenario) throw new Error("Scenario batch became empty");
    const next = await this.ctx.store.record(
      {
        ...state,
        scenarios: nextScenarios,
      },
      "scenario.tests_written",
      {
        scenarioId: scenarios[0]?.id,
        scenarioIds: scenarios.map((scenario) => scenario.id),
        testPaths: changedFiles,
        summary: output.summary,
      },
    );
    return this.runScenario(next, firstScenario);
  }

  private async runScenario(state: RunState, scenario: TestScenario): Promise<RunState> {
    const started =
      scenario.status === "active"
        ? state
        : await this.ctx.store.record(
            {
              ...state,
              scenarios: state.scenarios.map((item) =>
                item.id === scenario.id ? { ...item, status: "active" as const } : item,
              ),
            },
            "scenario.started",
            { scenarioId: scenario.id },
          );
    const current =
      started.scenarios.find((item) => item.id === scenario.id) ?? scenario;

    const evidence = await this.runScenarioCommand(started.runId, current);
    const runnable = classifyRunnableRed(evidence);
    if (
      !runnable.runnable &&
      (runnable.reason === "no_tests" || runnable.reason === "command_missing")
    ) {
      return this.blockConfigError(started, current, evidence, runnable.reason);
    }
    if (evidence.passed) {
      const nextScenarios = started.scenarios.map((item) =>
        item.id === current.id
          ? { ...item, status: "passing" as const, attempts: item.attempts + 1 }
          : item,
      );
      const next = await this.ctx.store.record(
        { ...started, scenarios: nextScenarios },
        "scenario.passed",
        { scenarioId: current.id },
      );
      if (nextScenarios.every((item) => item.status === "passing")) {
        return this.ctx.store.record(
          { ...next, phase: "crystallizing" },
          "scenarios.completed",
        );
      }
      return next;
    }

    const category = failureCategoryFromEvidence(evidence, "verification");
    const fingerprint = await this.fingerprintFor(current, evidence, category);
    if (category === "test-repair") {
      return this.routeToScenarioWriter(started, current, fingerprint, evidence);
    }
    return this.routeToImplementer(started, current, fingerprint, evidence);
  }

  private async routeToScenarioWriter(
    state: RunState,
    scenario: TestScenario,
    fingerprint: string,
    evidence: ReturnType<typeof commandEvidence>,
  ): Promise<RunState> {
    const maxWriter = this.ctx.config.workflow.maxImplementationAttempts;
    const progress = evaluateRepairProgress({
      fingerprint,
      lastFingerprint: scenario.evidenceFingerprint,
      seenFingerprints: scenario.seenEvidenceFingerprints,
      seenEdges: scenario.seenRepairEdges,
      fromRole: "scenario-runner",
      toRole: "scenario-writer",
    });
    if (!progress.allowed) {
      return this.blockNoProgress(state, scenario, fingerprint, progress.summary);
    }
    if (scenario.writerAttempts >= maxWriter) {
      return this.failScenario(
        state,
        scenario,
        fingerprint,
        `Scenario ${scenario.id} writer budget exhausted`,
      );
    }
    const edge = repairEdgeKey(fingerprint, "scenario-runner", "scenario-writer");
    const nextScenario: TestScenario = {
      ...scenario,
      status: "active",
      attempts: scenario.attempts + 1,
      evidenceFingerprint: fingerprint,
      seenEvidenceFingerprints: unique([...scenario.seenEvidenceFingerprints, fingerprint]),
      seenRepairEdges: unique([...scenario.seenRepairEdges, edge]),
      testPaths: [],
    };
    const next = await this.ctx.store.record(
      {
        ...state,
        scenarios: state.scenarios.map((item) =>
          item.id === scenario.id ? nextScenario : item,
        ),
      },
      "scenario.repair_routed",
      {
        scenarioId: scenario.id,
        route: "scenario-writer",
        evidenceFingerprint: fingerprint,
        exitCode: evidence.exitCode,
      },
    );
    return this.writeScenarioTests(next, [nextScenario]);
  }

  private async routeToImplementer(
    state: RunState,
    scenario: TestScenario,
    fingerprint: string,
    evidence: ReturnType<typeof commandEvidence>,
  ): Promise<RunState> {
    const maxRepair = this.ctx.config.workflow.maxImplementationAttempts;
    const progress = evaluateRepairProgress({
      fingerprint,
      lastFingerprint: scenario.evidenceFingerprint,
      seenFingerprints: scenario.seenEvidenceFingerprints,
      seenEdges: scenario.seenRepairEdges,
      fromRole: "scenario-runner",
      toRole: "implementer",
    });
    if (!progress.allowed) {
      return this.blockNoProgress(state, scenario, fingerprint, progress.summary);
    }
    if (scenario.repairAttempts >= maxRepair) {
      return this.failScenario(
        state,
        scenario,
        fingerprint,
        `Scenario ${scenario.id} implementer repair budget exhausted`,
      );
    }

    const linkedTasks = state.tasks.filter((task) => scenario.taskIds.includes(task.id));
    const primary = linkedTasks[0];
    const output = await this.ctx.agents.invoke({
      runId: state.runId,
      role: "implementer",
      objective: `Repair production code so scenario ${scenario.id} passes`,
      input: {
        scenario,
        evidence: {
          command: evidence.command,
          exitCode: evidence.exitCode,
          stdout: evidence.stdout,
          stderr: evidence.stderr,
        },
        protectedTestPaths: scenario.testPaths,
        linkedTasks: linkedTasks.map(taskForScenario),
        task: primary ? taskForScenario(primary) : undefined,
      },
      expectedOutput: "{summary,changedFiles}",
      schema: WorkerOutputSchema,
      knowledgeQuery: compactDomainSeed(scenario.title, scenario.intent, evidence.stderr),
      signal: this.ctx.signalFor(state.runId),
      causal: {
        phase: state.phase,
        taskId: primary?.id,
        invocationKind: "implementation-repair",
        trigger: {
          event: "scenario.repair_routed",
          classification: "verification",
          summary: `Implementer repair for scenario ${scenario.id}`,
          evidenceFingerprint: fingerprint,
        },
      },
    });

    const patterns = this.ctx.config.workflow.testPathPatterns;
    const testEdits = output.changedFiles.filter(
      (file) =>
        isTestPath(file, patterns) ||
        scenario.testPaths.some((path) => path === file || file.endsWith(path)),
    );
    if (testEdits.length > 0) {
      throw new HarnessFailure(
        `Implementer must not edit scenario test paths; got: ${testEdits.join(", ")}`,
        "contract",
        true,
      );
    }

    const edge = repairEdgeKey(fingerprint, "scenario-runner", "implementer");
    const nextScenario: TestScenario = {
      ...scenario,
      status: "active",
      attempts: scenario.attempts + 1,
      repairAttempts: scenario.repairAttempts + 1,
      evidenceFingerprint: fingerprint,
      seenEvidenceFingerprints: unique([...scenario.seenEvidenceFingerprints, fingerprint]),
      seenRepairEdges: unique([...scenario.seenRepairEdges, edge]),
    };
    const nextTasks = primary
      ? state.tasks.map((task) =>
          task.id === primary.id
            ? {
                ...task,
                changedFiles: unique([...task.changedFiles, ...output.changedFiles]),
              }
            : task,
        )
      : state.tasks;
    const next = await this.ctx.store.record(
      {
        ...state,
        tasks: nextTasks,
        scenarios: state.scenarios.map((item) =>
          item.id === scenario.id ? nextScenario : item,
        ),
      },
      "scenario.repair_routed",
      {
        scenarioId: scenario.id,
        route: "implementer",
        evidenceFingerprint: fingerprint,
        summary: output.summary,
      },
    );
    return this.runScenario(next, nextScenario);
  }

  private async runScenarioCommand(runId: string, scenario: TestScenario) {
    const primary = this.ctx.config.commands.verification[0]!;
    let command = primary.command;
    const filter = scenario.testPaths[0];
    const template = this.ctx.config.commands.testTargetTemplate;
    if (filter && template?.includes("{filter}")) {
      command = template.replaceAll("{filter}", filterForTemplate(filter, template));
    }
    const result = await this.ctx.deps.commands.run(command, {
      cwd: this.ctx.paths.workspaceRoot,
      timeoutMs: primary.timeoutMs,
      signal: this.ctx.signalFor(runId),
      ...this.ctx.commandEnvironmentOptions(),
    });
    if (result.cancelled) {
      throw new RunCancelledError(`Scenario ${scenario.id} test cancelled`);
    }
    return commandEvidence(`scenario:${scenario.id}`, result);
  }

  private async fingerprintFor(
    scenario: TestScenario,
    evidence: ReturnType<typeof commandEvidence>,
    category: string,
  ): Promise<string> {
    const sourceTreeState = this.ctx.config.git.enabled
      ? await this.ctx.git.treeFingerprint()
      : "git-disabled";
    return evidenceFingerprint({
      taskId: `scenario:${scenario.id}`,
      step: "scenario_testing",
      sourceTreeState,
      failingTestIds: failingTestIdsFromEvidence(evidence),
      failureCategory: failureCategoryFromEvidence(evidence, category),
      frozenConfigHash: frozenCommandsHash(this.ctx.config.commands),
    });
  }

  /**
   * A targeted run that found no tests (or could not launch) is a broken
   * filter/template, not a production failure: block as config so recovery
   * routes to the config-fixer instead of burning an implementer invocation.
   * The scenario stays active so a fixed template re-runs it on resume.
   */
  private async blockConfigError(
    state: RunState,
    scenario: TestScenario,
    evidence: ReturnType<typeof commandEvidence>,
    reason: "no_tests" | "command_missing",
  ): Promise<RunState> {
    const summary =
      reason === "no_tests"
        ? `Scenario ${scenario.id} targeted test run found no tests; the test filter/template is broken. Rendered command: ${evidence.command}. Fix commands.testTargetTemplate (for Gradle use a wildcard class-name pattern like --tests "*ClassName") or the recorded test path, then retry.`
        : `Scenario ${scenario.id} test command could not be launched. Rendered command: ${evidence.command}. Fix commands.verification / commands.testTargetTemplate for this host, then retry.`;
    return this.ctx.store.record(
      {
        ...state,
        phase: "blocked",
        blockedFrom: "scenario_testing",
        blockedKind: "config",
        failure: summary,
      },
      "scenario.config_error",
      {
        scenarioId: scenario.id,
        reason,
        command: evidence.command,
        exitCode: evidence.exitCode,
        summary,
      },
    );
  }

  private async blockNoProgress(
    state: RunState,
    scenario: TestScenario,
    fingerprint: string,
    summary: string,
  ): Promise<RunState> {
    const nextScenario: TestScenario = {
      ...scenario,
      status: "failed",
      evidenceFingerprint: fingerprint,
      seenEvidenceFingerprints: unique([...scenario.seenEvidenceFingerprints, fingerprint]),
    };
    const next = await this.ctx.store.record(
      {
        ...state,
        scenarios: state.scenarios.map((item) =>
          item.id === scenario.id ? nextScenario : item,
        ),
        phase: "blocked",
        blockedFrom: "scenario_testing",
        blockedKind: "no_progress",
        failure: summary,
      },
      "scenario.no_progress",
      { scenarioId: scenario.id, evidenceFingerprint: fingerprint, summary },
    );
    return next;
  }

  private async failScenario(
    state: RunState,
    scenario: TestScenario,
    fingerprint: string,
    summary: string,
  ): Promise<RunState> {
    const nextScenario: TestScenario = {
      ...scenario,
      status: "failed",
      evidenceFingerprint: fingerprint,
    };
    await this.ctx.store.record(
      {
        ...state,
        scenarios: state.scenarios.map((item) =>
          item.id === scenario.id ? nextScenario : item,
        ),
      },
      "scenario.failed",
      { scenarioId: scenario.id, evidenceFingerprint: fingerprint, summary },
    );
    throw new HarnessFailure(summary, "contract", false);
  }
}

/** File paths plus basename-derived symbol names from tasks linked to a scenario. */
function knowledgeSeedsFromTasks(tasks: BuildTask[]): string[] {
  const paths = unique(
    tasks.flatMap((task) => [...(task.changedFiles ?? []), ...(task.affectedPaths ?? [])]),
  );
  const symbols = paths
    .map((filePath) =>
      filePath
        .replaceAll("\\", "/")
        .split("/")
        .pop()
        ?.replace(/\.[^.]+$/, ""),
    )
    .filter((symbol): symbol is string => Boolean(symbol));
  return [...symbols, ...paths];
}

/** Batch initial scenario authoring by the primary task selected by the slicer. */
function pendingScenarioBatch(
  scenarios: TestScenario[],
  first: TestScenario,
): TestScenario[] {
  const primaryTaskId = first.taskIds[0];
  if (!primaryTaskId) return [first];
  return scenarios.filter(
    (scenario) => scenario.status === "pending" && scenario.taskIds[0] === primaryTaskId,
  );
}

/** Resolve the batched mapping while retaining old single-scenario scripted outputs. */
function scenarioTestPaths(
  output: ScenarioWriterOutput,
  requested: TestScenario[],
): Map<string, string[]> {
  if ((output.scenarios ?? []).length === 0) {
    if (requested.length > 1) {
      throw new HarnessFailure(
        "Scenario-writer must return one scenarios mapping per requested scenario",
        "contract",
        true,
      );
    }
    return new Map(
      requested.map((scenario) => [scenario.id, unique(output.testPaths ?? [])]),
    );
  }

  const requestedIds = new Set(requested.map((scenario) => scenario.id));
  const paths = new Map<string, string[]>();
  for (const result of output.scenarios ?? []) {
    if (!requestedIds.has(result.scenarioId)) {
      throw new HarnessFailure(
        `Scenario-writer returned unrequested scenario ${result.scenarioId}`,
        "contract",
        true,
      );
    }
    paths.set(
      result.scenarioId,
      unique([...(paths.get(result.scenarioId) ?? []), ...result.testPaths]),
    );
  }

  const missing = requested.filter((scenario) => !paths.has(scenario.id));
  if (missing.length > 0) {
    throw new HarnessFailure(
      `Scenario-writer omitted scenario mappings: ${missing.map((scenario) => scenario.id).join(", ")}`,
      "contract",
      true,
    );
  }
  return paths;
}

function taskForScenario(task: BuildTask) {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
    changedFiles: task.changedFiles,
    affectedPaths: task.affectedPaths,
  };
}
