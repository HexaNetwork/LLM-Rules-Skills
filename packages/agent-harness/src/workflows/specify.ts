import type { AgentTurnResult, CommandResult, UserAnswers, WorkflowStep } from "../types.js";
import { agentRequest, blocked, objectSchema, stringSchema, type StepInput } from "./common.js";

type Documents = { glossary: string; plan: string; requirements: string; scenarios: string };
type State = { stage: "draft" | "approval" | "revise"; input: unknown; documents?: Documents; approvedSpecification?: unknown; sessionId?: string; ordinal: number };
type Output = { documents: Documents; approvedSpecification: unknown };
const schema = objectSchema(["glossary", "plan", "requirements", "scenarios", "approvedSpecification"], { glossary: stringSchema, plan: stringSchema, requirements: stringSchema, scenarios: stringSchema, approvedSpecification: { type: "object" } });

export class SpecifyStep implements WorkflowStep<StepInput, State, Output> {
  readonly id = "specify";
  start(input: StepInput) {
    const state: State = { stage: "draft", input: input.previous, ordinal: 0 };
    return { type: "invoke-agent" as const, state, request: agentRequest("specifier", 0, `Create a concise glossary, implementation plan, product/technical requirements, acceptance scenarios, and one structured approvedSpecification from this clarified brief:\n${JSON.stringify(input.previous)}`, schema) };
  }
  onAgent(state: State, result: AgentTurnResult) {
    const value = result.output as Partial<Documents> & { approvedSpecification?: unknown };
    if (![value.glossary, value.plan, value.requirements, value.scenarios].every((item) => typeof item === "string") || !value.approvedSpecification) return blocked<State>("invalid_specification", "Specifier output is incomplete");
    const documents = { glossary: value.glossary!, plan: value.plan!, requirements: value.requirements!, scenarios: value.scenarios! };
    return { type: "await-user" as const, state: { ...state, stage: "approval" as const, documents, approvedSpecification: value.approvedSpecification, sessionId: result.sessionId }, gate: { id: `specification-approval-${state.ordinal}`, title: "Edit and approve specification", documents, editableArtifacts: Object.keys(documents), questions: [{ id: "decision", prompt: "Enter approve, or describe requested changes", required: true }] } };
  }
  onUser(state: State, answers: UserAnswers) {
    if (state.stage !== "approval" || !state.documents) return blocked<State>("unexpected_answers", "Specification is not awaiting approval");
    const decision = answers.answers.decision?.trim();
    if (!decision) return blocked<State>("invalid_answers", "Approval or requested changes are required");
    if (decision.toLowerCase() === "approve") return { type: "complete" as const, output: { documents: state.documents, approvedSpecification: state.approvedSpecification } };
    const ordinal = state.ordinal + 1;
    return { type: "invoke-agent" as const, state: { ...state, stage: "revise" as const, ordinal }, request: agentRequest("specifier", ordinal, `Revise the specification using these exact operator changes:\n${decision}\n\nCurrent documents:\n${JSON.stringify(state.documents)}`, schema, state.sessionId) };
  }
  onCommand(_state: State, _result: CommandResult) { return blocked<State>("unexpected_command", "Specify does not run project commands"); }
}
