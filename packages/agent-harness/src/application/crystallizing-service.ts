import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  UNIT_TEST_WRITER_EXPECTED_OUTPUT,
  UnitTestWriterOutputSchema,
  isTestPath,
  type RunState,
} from "../domain.js";
import { HarnessFailure, RunCancelledError } from "../errors.js";
import { compactDomainSeed } from "../knowledge.js";
import type { ApplicationContext } from "./application-context.js";
import { measureCoverage, parseCoverageReport } from "./coverage.js";
import { unique } from "./helpers.js";

export class CrystallizingService {
  constructor(private readonly ctx: ApplicationContext) {}

  async advance(state: RunState): Promise<RunState> {
    const coverageConfig = this.ctx.config.workflow.coverage;
    if (!coverageConfig.enabled) {
      return this.ctx.store.record(
        { ...state, phase: "final_review" },
        "coverage.skipped",
        { reason: "coverage disabled" },
      );
    }

    const commandConfig = this.ctx.config.commands.coverage;
    if (!commandConfig) {
      throw new HarnessFailure(
        "commands.coverage is required when workflow.coverage.enabled is true",
        "config",
        false,
      );
    }

    const result = await this.ctx.deps.commands.run(commandConfig.command, {
      cwd: this.ctx.paths.workspaceRoot,
      timeoutMs: commandConfig.timeoutMs,
      signal: this.ctx.signalFor(state.runId),
      ...this.ctx.commandEnvironmentOptions(),
    });
    if (result.cancelled) {
      throw new RunCancelledError("Coverage command cancelled");
    }
    if (result.exitCode !== 0) {
      throw new HarnessFailure(
        `Coverage command failed with exit ${result.exitCode}`,
        "verification",
        true,
      );
    }

    const reportPath = path.resolve(this.ctx.paths.workspaceRoot, commandConfig.reportPath);
    const content = await readFile(reportPath, "utf8");
    const report = parseCoverageReport(content, commandConfig.format);
    const baseSha = this.ctx.workspace.baseSha;
    const changedFiles =
      this.ctx.config.git.enabled && baseSha
        ? await this.ctx.git.changedFilesVersusRef(baseSha)
        : [];
    const measured = measureCoverage({
      report,
      scope: coverageConfig.scope,
      changedFiles,
      testPathPatterns: this.ctx.config.workflow.testPathPatterns,
    });

    const attempts = (state.coverage?.attempts ?? 0) + 1;
    const coverage = {
      percentage: measured.percentage,
      scope: measured.scope,
      fallback: measured.fallback,
      measuredAt: new Date().toISOString(),
      attempts,
    };

    let next = await this.ctx.store.record(
      { ...state, coverage },
      "coverage.measured",
      {
        percentage: measured.percentage,
        scope: measured.scope,
        fallback: measured.fallback,
        covered: measured.covered,
        total: measured.total,
      },
    );

    if (measured.percentage >= coverageConfig.threshold) {
      return this.ctx.store.record(
        { ...next, phase: "final_review" },
        "coverage.passed",
        { percentage: measured.percentage, threshold: coverageConfig.threshold },
      );
    }

    if (
      state.coverage &&
      Math.abs(state.coverage.percentage - measured.percentage) < 1e-9
    ) {
      return this.ctx.store.record(
        {
          ...next,
          phase: "blocked",
          blockedFrom: "crystallizing",
          blockedKind: "no_progress",
          failure: `Coverage unchanged at ${(measured.percentage * 100).toFixed(1)}%`,
        },
        "coverage.no_progress",
        { percentage: measured.percentage },
      );
    }

    if (attempts >= coverageConfig.maxAttempts) {
      throw new HarnessFailure(
        `Coverage ${(measured.percentage * 100).toFixed(1)}% below threshold ${(coverageConfig.threshold * 100).toFixed(1)}% after ${attempts} attempts`,
        "verification",
        false,
      );
    }

    next = await this.ctx.store.record(
      next,
      "coverage.below_threshold",
      {
        percentage: measured.percentage,
        threshold: coverageConfig.threshold,
        attempts,
      },
    );
    return this.invokeUnitTestWriter(next, measured);
  }

  private async invokeUnitTestWriter(
    state: RunState,
    measured: {
      percentage: number;
      files: Map<string, { covered: number; total: number }>;
      fallback: boolean;
    },
  ): Promise<RunState> {
    const uncovered = [...measured.files.entries()]
      .filter(([, stat]) => stat.total > 0 && stat.covered < stat.total)
      .map(([filePath, stat]) => ({
        path: filePath,
        covered: stat.covered,
        total: stat.total,
      }))
      .slice(0, 40);

    const existingTestPaths = unique(
      state.scenarios.flatMap((scenario) => scenario.testPaths),
    );

    const output = await this.ctx.agents.invoke({
      runId: state.runId,
      role: "unit-test-writer",
      objective: "Write unit tests to raise coverage on uncovered production paths",
      input: {
        coverage: {
          percentage: measured.percentage,
          threshold: this.ctx.config.workflow.coverage.threshold,
          fallback: measured.fallback,
        },
        uncovered,
        existingTestPaths,
        scenarios: state.scenarios,
        tasks: state.tasks.map((task) => ({
          id: task.id,
          title: task.title,
          changedFiles: task.changedFiles,
        })),
        testPathPatterns: this.ctx.config.workflow.testPathPatterns,
        finalReviewFindings: state.coverage ? undefined : undefined,
      },
      expectedOutput: UNIT_TEST_WRITER_EXPECTED_OUTPUT,
      schema: UnitTestWriterOutputSchema,
      knowledgeQuery: compactDomainSeed(
        ...uncovered.map((item) => item.path),
        ...existingTestPaths,
      ),
      signal: this.ctx.signalFor(state.runId),
      causal: {
        phase: state.phase,
        invocationKind: "initial",
        trigger: {
          event: "coverage.below_threshold",
          classification: "coverage",
          summary: "Write unit tests to raise coverage",
        },
      },
    });

    const changedFiles = unique([
      ...output.testPaths,
      ...(output.changedFiles ?? []),
    ]);
    const patterns = this.ctx.config.workflow.testPathPatterns;
    const nonTest = changedFiles.filter((file) => !isTestPath(file, patterns));
    if (nonTest.length > 0) {
      throw new HarnessFailure(
        `Unit-test-writer must only edit test paths; got: ${nonTest.join(", ")}`,
        "contract",
        true,
      );
    }

    return this.ctx.store.record(
      state,
      "coverage.tests_written",
      { testPaths: output.testPaths, summary: output.summary },
    );
  }
}
