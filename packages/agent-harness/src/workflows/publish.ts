import type { AgentTurnResult, CommandResult, UserAnswers, WorkflowStep } from "../types.js";
import { agentRequest, blocked, objectSchema, stringSchema, type StepInput } from "./common.js";

type State = { stage: "draft" | "gate" | "publish"; title?: string; body?: string; runTitle: string; ordinal: number };
type Output = { branch: string; commit: string; pullRequestUrl: string };
const schema = objectSchema(["title", "body"], { title: stringSchema, body: stringSchema });

export class PublishStep implements WorkflowStep<StepInput, State, Output> {
  readonly id = "publish";
  start(input: StepInput) {
    const runTitle = String(input.runInput.title ?? input.runInput.idea ?? "change");
    const state: State = { stage: "draft", runTitle, ordinal: 0 };
    return { type: "invoke-agent" as const, state, request: agentRequest("publication-writer", 0, `Draft a concise pull-request title and body from these durable workflow artifacts. Do not run Git or publication commands.\n${JSON.stringify(input.outputs)}`, schema) };
  }
  onAgent(state: State, result: AgentTurnResult) {
    const output = result.output as { title?: unknown; body?: unknown };
    if (typeof output.title !== "string" || typeof output.body !== "string") return blocked<State>("invalid_publication_draft", "Publication writer returned invalid text");
    return { type: "await-user" as const, state: { ...state, stage: "gate" as const, title: output.title, body: output.body }, gate: { id: "publish-approval", title: "Edit and approve pull request", questions: [{ id: "title", prompt: output.title, required: true }, { id: "body", prompt: output.body, required: true }] } };
  }
  onUser(state: State, answers: UserAnswers) {
    if (state.stage !== "gate") return blocked<State>("unexpected_answers", "Publish is not awaiting approval");
    const title = answers.answers.title?.trim(); const body = answers.answers.body?.trim();
    if (!title || !body) return blocked<State>("invalid_answers", "Pull-request title and body are required");
    return { type: "run-command" as const, state: { ...state, stage: "publish" as const, title, body }, request: { actionId: "publication/git/0", command: `git:publish:${JSON.stringify({ title, body, runTitle: state.runTitle })}` } };
  }
  onCommand(state: State, result: CommandResult) {
    if (state.stage !== "publish" || result.exitCode !== 0) return blocked<State>("publication_failed", result.stderr || result.stdout);
    return { type: "complete" as const, output: JSON.parse(result.stdout) as Output };
  }
}
