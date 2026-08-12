import {
  REVIEW_EXPECTED_OUTPUT,
  ReviewOutputSchema,
  reviewRepairRoute,
  type BuildTask,
  type RunState,
} from "../domain.js";
import { HarnessFailure } from "../errors.js";
import { compactDomainSeed } from "../knowledge.js";
import type { ApplicationContext } from "./application-context.js";

export class FinalReviewService {
  constructor(private readonly ctx: ApplicationContext) {}

  async advance(state: RunState): Promise<RunState> {
    const attempts = state.finalReviewAttempts + 1;
    const maxAttempts = this.ctx.config.workflow.maxFinalReviewAttempts;
    if (attempts > maxAttempts) {
      throw new HarnessFailure(
        `Final review budget exhausted after ${maxAttempts} attempts`,
        "contract",
        false,
      );
    }

    const reviewBaseSha = this.ctx.config.git.enabled
      ? this.ctx.workspace.baseSha
      : undefined;
    const changedPaths =
      this.ctx.config.git.enabled && reviewBaseSha
        ? await this.ctx.git.changedFilesVersusRef(reviewBaseSha)
        : state.tasks.flatMap((task) => task.changedFiles);
    const diff =
      this.ctx.config.git.enabled && reviewBaseSha && changedPaths.length > 0
        ? await this.ctx.git.diffForPaths(
            changedPaths,
            this.ctx.config.workflow.reviewDiffCharacters,
            { baseRef: reviewBaseSha },
          )
        : { diff: "", omittedFiles: [] as string[], truncated: false };

    const output = await this.ctx.agents.invoke({
      runId: state.runId,
      role: "reviewer",
      objective:
        "Holistic final review of the full base..HEAD change with scenario and coverage evidence",
      input: {
        kind: "final_review",
        scenarios: state.scenarios,
        coverage: state.coverage,
        tasks: state.tasks.map((task) => ({
          id: task.id,
          title: task.title,
          reviewSummary: task.reviewSummary,
          changedFiles: task.changedFiles,
          acceptanceCriteria: task.acceptanceCriteria,
        })),
        diff: diff.diff,
        omittedFiles: diff.omittedFiles,
        baseSha: reviewBaseSha,
      },
      expectedOutput: REVIEW_EXPECTED_OUTPUT,
      schema: ReviewOutputSchema,
      knowledgeQuery:
        compactDomainSeed(
          state.idea,
          state.prd?.summary,
          ...state.scenarios.map((scenario) => scenario.intent),
        ) || state.idea,
      signal: this.ctx.signalFor(state.runId),
      causal: {
        phase: state.phase,
        invocationKind: "initial",
        trigger: {
          event: "final_review.started",
          classification: "final_review",
          summary: "Holistic final review",
        },
      },
    });

    let next: RunState = {
      ...state,
      finalReviewAttempts: attempts,
    };

    if (output.approved) {
      return this.ctx.store.record(
        { ...next, phase: "publishing" },
        "final_review.approved",
        { summary: output.summary, attempts },
      );
    }

    const route = reviewRepairRoute(output.findings);
    const blocking = output.findings.filter((finding) => finding.severity === "blocking");
    next = await this.ctx.store.record(
      next,
      "final_review.blocked",
      { summary: output.summary, route, findings: blocking.length, attempts },
    );

    if (route === "production") {
      return this.reopenForProduction(next, output.findings);
    }
    if (route === "scenario-intent") {
      return this.reopenScenarios(next, output.findings);
    }
    if (route === "test-design" || route === "test-coverage") {
      return this.ctx.store.record(
        {
          ...next,
          phase: "crystallizing",
          coverage: next.coverage
            ? { ...next.coverage, attempts: Math.max(0, next.coverage.attempts - 1) }
            : undefined,
        },
        "final_review.routed",
        { route, phase: "crystallizing" },
      );
    }

    // Advisory-only or empty blocking set after approved=false — treat as production reopen of all tasks.
    return this.reopenForProduction(next, output.findings);
  }

  private async reopenForProduction(
    state: RunState,
    findings: Array<{ severity: string; kind: string; message: string; taskIds?: string[] }>,
  ): Promise<RunState> {
    const mentioned = new Set(
      findings.flatMap((finding) => finding.taskIds ?? []),
    );
    const targetIds =
      mentioned.size > 0
        ? mentioned
        : new Set(state.tasks.filter((task) => task.status === "done").map((task) => task.id));
    const summary = findings
      .filter((finding) => finding.severity === "blocking")
      .map((finding) => finding.message)
      .join("\n");

    const tasks = state.tasks.map((task): BuildTask => {
      if (!targetIds.has(task.id)) return task;
      return {
        ...task,
        status: "active",
        step: "implementing",
        reviewSummary: summary || "Final review requested production repair",
        failure: undefined,
      };
    });

    return this.ctx.store.record(
      { ...state, tasks, phase: "executing" },
      "final_review.routed",
      { route: "production", taskIds: [...targetIds] },
    );
  }

  private async reopenScenarios(
    state: RunState,
    findings: Array<{ severity: string; kind: string; message: string; taskIds?: string[] }>,
  ): Promise<RunState> {
    const messages = findings
      .filter((finding) => finding.kind === "scenario-intent" && finding.severity === "blocking")
      .map((finding) => finding.message);
    const scenarios = state.scenarios.map((scenario) => ({
      ...scenario,
      status: "pending" as const,
      testPaths: [] as string[],
      writerAttempts: 0,
      repairAttempts: 0,
      evidenceFingerprint: undefined,
      seenEvidenceFingerprints: [] as string[],
      seenRepairEdges: [] as string[],
      reviewFindings: messages,
    }));
    return this.ctx.store.record(
      { ...state, scenarios, phase: "scenario_testing" },
      "final_review.routed",
      { route: "scenario-intent", scenarios: scenarios.length },
    );
  }
}
