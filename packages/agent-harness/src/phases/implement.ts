import { appendFile } from "node:fs/promises";
import path from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { buildImplementerInput, buildTaskReviewerInput } from "../domain/role-packets.js";
import { shouldResumeImplementer, shouldResumeTaskReviewer } from "../domain/role-agents.js";
import type { Phase, PhaseResult, Run, Task } from "../domain/types.js";
import { asRecord, invokeRole } from "./helpers.js";
import { normalizeTasks } from "./slice.js";
import {
  environmentBlock,
  repairImageForEnvironmentFailure,
  verificationCommandsForRun,
  verifyWithHarness,
} from "./verification.js";

export function createImplementPhase(ctx: Context): Phase {
  return {
    id: "implement",
    async enter(run: Run) {
      if (run.state.tasks.length === 0) {
        run.state.tasks = normalizeTasks(undefined, run.state.idea);
      }
    },
    async advance(run: Run): Promise<PhaseResult> {
      const maxAttempts = run.settings.workflow.maxImplementationAttempts;
      const task = selectTask(run, maxAttempts);
      if (!task) {
        const blocked = run.state.tasks.find((item) => item.status === "blocked");
        if (blocked) {
          return {
            kind: "block",
            reason: `Task ${blocked.id} is blocked after ${blocked.attempts?.implementation ?? 0} implementation attempts; raise workflow.maxImplementationAttempts and retry to resume it.`,
            retriable: true,
          };
        }
        return { kind: "continue" };
      }
      task.status = "in_progress";
      task.attempts ??= { implementation: 0, review: 0 };

      // After an environment block the implementer already ran; re-verify before
      // spending another implementation turn.
      let implemented: Record<string, unknown> | undefined;
      const envRecheck =
        task.verification?.classification === "environment_failure" && !task.reviewSummary;
      if (!envRecheck) {
        implemented = asRecord(
          await invokeRole(
            ctx,
            run,
            "implementer",
            buildImplementerInput({
              task,
              brief: run.state.artifacts.reflectBrief,
              plan: run.state.artifacts.plan,
              reviewFeedback: task.reviewSummary,
              verification: task.verification,
              verificationCommands: verificationCommandsForRun(run, task.verification),
            }),
            { resumeAgent: shouldResumeImplementer(task) },
          ),
        );
        await writeImplementationNote(run, task, implemented);
      }

      let evidence = await verifyWithHarness(ctx, run, task.verification);
      if (evidence) {
        if (evidence.classification === "environment_failure") {
          evidence = await repairImageForEnvironmentFailure(ctx, run, evidence);
        }
        task.verification = evidence;
        if (evidence.classification === "environment_failure") {
          return { kind: "block", reason: environmentBlock(evidence), retriable: true };
        }
        if (!evidence.passed) {
          return requestRepair(
            task,
            maxAttempts,
            `failed verification \`${evidence.command}\``,
            evidence.output,
          );
        }
      }

      const review = asRecord(
        await invokeRole(
          ctx,
          run,
          "task-reviewer",
          buildTaskReviewerInput({
            task,
            implemented,
            verification: task.verification,
          }),
          { resumeAgent: shouldResumeTaskReviewer(task) },
        ),
      );
      task.attempts.review += 1;
      if (String(review.verdict ?? "approve") !== "approve") {
        const summary = String(review.summary ?? "Reviewer requested changes without a summary.");
        task.reviewSummary = summary;
        return requestRepair(task, maxAttempts, "was rejected in review", summary);
      }

      const sha = await ctx.git.commit(run.identity, `${task.title}\n\n${task.description}`);
      task.status = "committed";
      task.commitSha = sha;
      task.reviewSummary = undefined;
      run.state.artifacts.lastCommit = sha;
      return this.advance(run, { reason: "continue" });
    },
  };
}

function selectTask(run: Run, maxAttempts: number): Task | undefined {
  return (
    run.state.tasks.find((item) => item.status === "pending" || item.status === "in_progress") ??
    run.state.tasks.find(
      (item) => item.status === "blocked" && (item.attempts?.implementation ?? 0) < maxAttempts,
    )
  );
}

function requestRepair(
  task: Task,
  maxAttempts: number,
  cause: string,
  feedback: string,
): PhaseResult {
  const attempts = (task.attempts ??= { implementation: 0, review: 0 });
  attempts.implementation += 1;
  if (attempts.implementation < maxAttempts) {
    task.status = "in_progress";
    return {
      kind: "block",
      reason: `Task ${task.id} ${cause} (attempt ${attempts.implementation}/${maxAttempts}); retry resumes the implementer with this feedback: ${feedback}`,
      retriable: true,
    };
  }
  task.status = "blocked";
  return {
    kind: "block",
    reason: `Task ${task.id} ${cause} after ${maxAttempts} implementation attempts: ${feedback}`,
    retriable: true,
  };
}

async function writeImplementationNote(
  run: Run,
  task: Task,
  implemented: Record<string, unknown>,
): Promise<void> {
  const file = path.join(run.identity.worktreePath, "HARNESS_SLICE.md");
  await appendFile(
    file,
    `\n## ${task.title}\n\n${task.description}\n\n${String(implemented.summary ?? "")}\n`,
    "utf8",
  );
}
