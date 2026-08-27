import type { AgentTurnResult, CommandResult, UserAnswers, WorkflowStep } from "../types.js";
import { agentRequest, arraySchema, blocked, booleanSchema, commandFailure, objectSchema, stringSchema, type StepInput } from "./common.js";

type Task = { id: string; title: string; description: string; verificationCommand: string };
type State = { stage: "slice" | "implement" | "verify" | "review" | "commit"; tasks: Task[]; taskIndex: number; attempt: number; attemptLimit: number; ordinal: number; implementerSessionId?: string; reviewerSessionId?: string; evidence: CommandResult[]; summaries: string[]; fresh: boolean; specification: unknown };
type Output = { tasks: Task[]; summaries: string[]; verificationEvidence: CommandResult[] };
const tasksSchema = objectSchema(["tasks"], { tasks: arraySchema });
const implementationSchema = objectSchema(["summary"], { summary: stringSchema });
const reviewSchema = objectSchema(["approved", "findings"], { approved: booleanSchema, findings: arraySchema });

export class ImplementStep implements WorkflowStep<StepInput, State, Output> {
  readonly id = "implement";
  start(input: StepInput) {
    const limit = Number(input.effectiveConfig.implementationAttemptLimit ?? 3);
    const state: State = { stage: "slice", tasks: [], taskIndex: 0, attempt: 0, attemptLimit: limit, ordinal: 0, evidence: [], summaries: [], fresh: Boolean(input.runInput.fresh), specification: input.outputs.specify };
    return { type: "invoke-agent" as const, state, request: agentRequest("task-slicer", 0, `Create ordered bounded implementation tasks. ${state.fresh ? "The first task must scaffold the fresh project." : "Preserve the existing project structure."} Each task needs id, title, description, and one relevant verificationCommand.\n${JSON.stringify(state.specification)}`, tasksSchema) };
  }
  onAgent(state: State, result: AgentTurnResult) {
    if (state.stage === "slice") {
      const tasks = (result.output as { tasks?: Task[] }).tasks;
      if (!Array.isArray(tasks) || !tasks.length || tasks.some((task) => !task || typeof task !== "object" || !task.id || !task.title || !task.description || !task.verificationCommand)) return blocked<State>("invalid_tasks", "Task slicer returned invalid or empty tasks");
      return this.invokeImplementer({ ...state, stage: "implement", tasks, ordinal: 1 });
    }
    if (state.stage === "implement") {
      const summary = (result.output as { summary?: unknown }).summary;
      if (typeof summary !== "string") return blocked<State>("invalid_implementation", "Implementer did not return a summary");
      const task = state.tasks[state.taskIndex]!;
      const next = { ...state, stage: "verify" as const, implementerSessionId: result.sessionId, summaries: [...state.summaries, summary] };
      return { type: "run-command" as const, state: next, request: { actionId: `task-${task.id}/verify/${state.attempt}`, command: task.verificationCommand } };
    }
    if (state.stage === "review") {
      const review = result.output as { approved?: unknown; findings?: unknown[] };
      if (typeof review.approved !== "boolean" || !Array.isArray(review.findings)) return blocked<State>("invalid_review", "Reviewer returned an invalid review");
      if (!review.approved) return this.repair(state, `Independent review findings:\n${JSON.stringify(review.findings)}`);
      const task = state.tasks[state.taskIndex]!;
      return { type: "run-command" as const, state: { ...state, stage: "commit" as const, reviewerSessionId: result.sessionId }, request: { actionId: `task-${task.id}/commit/0`, command: `git:commit:${task.title}` } };
    }
    return blocked<State>("unexpected_agent_result", `Agent result received in ${state.stage}`);
  }
  onCommand(state: State, result: CommandResult) {
    if (state.stage === "verify") {
      const evidence = [...state.evidence, result];
      const failure = commandFailure(result);
      if (failure) return this.repair({ ...state, evidence }, `Verification failed:\n${failure}`);
      const task = state.tasks[state.taskIndex]!;
      const ordinal = state.ordinal + 1;
      return { type: "invoke-agent" as const, state: { ...state, stage: "review" as const, ordinal, evidence }, request: agentRequest("task-reviewer", ordinal, `Independently review task ${task.title} against its bounded requirement and repository diff. Return approved and actionable findings.\n${task.description}`, reviewSchema) };
    }
    if (state.stage === "commit") {
      const nextIndex = state.taskIndex + 1;
      if (nextIndex >= state.tasks.length) return { type: "complete" as const, output: { tasks: state.tasks, summaries: state.summaries, verificationEvidence: state.evidence } };
      return this.invokeImplementer({ ...state, stage: "implement", taskIndex: nextIndex, attempt: 0, implementerSessionId: undefined, reviewerSessionId: undefined, ordinal: state.ordinal + 1 });
    }
    return blocked<State>("unexpected_command", `Command result received in ${state.stage}`);
  }
  onUser(_state: State, _answers: UserAnswers) { return blocked<State>("unexpected_answers", "Implement is not awaiting user input"); }
  private invokeImplementer(state: State, findings?: string) {
    const task = state.tasks[state.taskIndex]!;
    return { type: "invoke-agent" as const, state, request: agentRequest("implementer", state.ordinal, `${findings ? `Repair these findings:\n${findings}\n\n` : ""}Implement only this task in /workspace. Do not commit or publish.\nTitle: ${task.title}\nRequirement: ${task.description}`, implementationSchema, state.implementerSessionId) };
  }
  private repair(state: State, findings: string) {
    const attempt = state.attempt + 1;
    if (attempt >= state.attemptLimit) return blocked<State>("implementation_attempts_exhausted", findings);
    return this.invokeImplementer({ ...state, stage: "implement", attempt, ordinal: state.ordinal + 1 }, findings);
  }
}
