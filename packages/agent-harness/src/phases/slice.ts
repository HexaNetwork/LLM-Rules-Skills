import type { Context } from "@deepseek-ai/cordis";
import { buildIssueSlicerInput } from "../domain/role-packets.js";
import type { Phase, PhaseResult, Run, Task } from "../domain/types.js";
import { asRecord, invokeRole } from "./helpers.js";

export function createSlicePhase(ctx: Context): Phase {
  return {
    id: "slice",
    async advance(run: Run): Promise<PhaseResult> {
      const output = asRecord(
        await invokeRole(
          ctx,
          run,
          "issue-slicer",
          buildIssueSlicerInput({
            plan: run.state.artifacts.plan,
            prd: run.state.artifacts.prd,
            scenarios: run.state.artifacts.scenarios,
          }),
        ),
      );
      const tasks = normalizeTasks(output.tasks, run.state.idea);
      run.state.tasks = tasks;
      run.state.artifacts.tasks = tasks;
      return { kind: "continue" };
    },
  };
}

export function normalizeTasks(raw: unknown, idea: string): Task[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [{ id: "task-1", title: "Implement the slice", description: idea, status: "pending" }];
  }
  return raw.map((item, index) => {
    const row = (item && typeof item === "object" ? item : { title: String(item) }) as Record<string, unknown>;
    return {
      id: String(row.id ?? `task-${index + 1}`),
      title: String(row.title ?? `Task ${index + 1}`),
      description: String(row.description ?? idea),
      status: "pending",
    };
  });
}
