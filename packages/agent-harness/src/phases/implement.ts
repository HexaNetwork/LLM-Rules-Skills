import { appendFile } from "node:fs/promises";
import path from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Phase, PhaseResult, Run, Task } from "../domain/types.js";
import { asRecord, invokeRole } from "./helpers.js";
import { normalizeTasks } from "./slice.js";

export function createImplementPhase(ctx: Context): Phase {
  return {
    id: "implement",
    async enter(run: Run) {
      if (run.state.tasks.length === 0) {
        run.state.tasks = normalizeTasks(undefined, run.state.idea);
      }
    },
    async advance(run: Run): Promise<PhaseResult> {
      const task = run.state.tasks.find((item) => item.status === "pending" || item.status === "in_progress");
      if (!task) return { kind: "continue" };
      task.status = "in_progress";
      const implemented = asRecord(
        await invokeRole(ctx, run, "implementer", {
          task,
          brief: run.state.artifacts.reflectBrief,
          plan: run.state.artifacts.plan,
        }),
      );
      await writeImplementationNote(run, task, implemented);
      const review = asRecord(await invokeRole(ctx, run, "task-reviewer", { task, implemented }));
      if (String(review.verdict ?? "approve") !== "approve") {
        task.status = "blocked";
        return { kind: "block", reason: `Task ${task.id} failed review`, retriable: true };
      }
      const sha = await ctx.git.commit(run.identity, `${task.title}\n\n${task.description}`);
      task.status = "committed";
      task.commitSha = sha;
      run.state.artifacts.lastCommit = sha;
      return this.advance(run, { reason: "continue" });
    },
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
