import type { ReflectOutput } from "../domain/reflect.js";
import { applyReflectEdits, coerceReflectOutput, formatReflectRestatement } from "../domain/reflect.js";
import type { AgentTurnResult, CommandResult, UserAnswers, WorkflowStep } from "../types.js";
import { agentRequest, arraySchema, blocked, booleanSchema, objectSchema, stringSchema, type StepInput } from "./common.js";

type State = { stage: "reflect" | "brief-gate" | "grill" | "questions"; idea: string; brief?: string; reflect?: ReflectOutput; sessionId?: string; transcript: Array<{ questions: unknown[]; answers: Record<string, string> }>; ordinal: number };
type Output = { clarifiedBrief: unknown; transcript: State["transcript"] };
const stringArraySchema = { type: "array", items: { type: "string" } } as const;
const reflectSchema = objectSchema(
  ["summary", "restatement", "goal", "users", "inScope", "outOfScope", "assumptions", "unknowns"],
  {
    proposedTitle: stringSchema,
    summary: stringSchema,
    restatement: stringSchema,
    goal: stringSchema,
    users: stringArraySchema,
    inScope: stringArraySchema,
    outOfScope: stringArraySchema,
    assumptions: stringArraySchema,
    unknowns: stringArraySchema,
  },
);
const grillSchema = objectSchema(["resolved", "questions", "clarifiedBrief"], { resolved: booleanSchema, questions: arraySchema, clarifiedBrief: { type: "object" } });

export class ClarifyStep implements WorkflowStep<StepInput, State, Output> {
  readonly id = "clarify";
  start(input: StepInput) {
    const idea = String(input.runInput.idea ?? "").trim();
    if (!idea) return blocked<State>("invalid_input", "An idea or ticket is required");
    const state: State = { stage: "reflect", idea, transcript: [], ordinal: 0 };
    return { type: "invoke-agent" as const, state, request: agentRequest("reflector", 0, `Restate this request as an editable brief. Identify scope, users, assumptions, and unknowns.\n\n${idea}`, reflectSchema) };
  }
  onAgent(state: State, result: AgentTurnResult) {
    const output = result.output as { brief?: unknown; resolved?: unknown; questions?: unknown[]; clarifiedBrief?: unknown };
    if (state.stage === "reflect") {
      let reflect: ReflectOutput;
      try {
        reflect = coerceReflectOutput(output);
      } catch (error) {
        return blocked<State>("invalid_reflection", error instanceof Error ? error.message : String(error));
      }
      const next = { ...state, stage: "brief-gate" as const, reflect, ordinal: 1 };
      return {
        type: "await-user" as const,
        state: next,
        gate: {
          id: "clarify-brief",
          title: "Edit and confirm the brief",
          questions: [{ id: "brief", prompt: formatReflectRestatement(reflect), required: true }],
          reflect,
        },
      };
    }
    if (state.stage !== "grill") return blocked<State>("unexpected_agent_result", `Agent result received in ${state.stage}`);
    if (typeof output.resolved !== "boolean" || !Array.isArray(output.questions)) return blocked<State>("invalid_grill", "Griller returned an invalid question batch");
    if (output.resolved) return { type: "complete" as const, output: { clarifiedBrief: output.clarifiedBrief, transcript: state.transcript } };
    const questions = [];
    for (const [index, question] of output.questions.entries()) {
      if (!question || typeof question !== "object") return blocked<State>("invalid_grill", `Invalid griller question at ${index}`);
      const value = question as { id?: unknown; prompt?: unknown };
      if (typeof value.id !== "string" || typeof value.prompt !== "string") return blocked<State>("invalid_grill", `Invalid griller question at ${index}`);
      questions.push({ id: value.id, prompt: value.prompt, required: true });
    }
    return { type: "await-user" as const, state: { ...state, stage: "questions" as const, sessionId: result.sessionId }, gate: { id: `clarify-questions-${state.ordinal}`, title: "Resolve material unknowns", questions } };
  }
  onUser(state: State, answers: UserAnswers) {
    if (state.stage === "brief-gate") {
      const flatBrief = answers.answers.brief?.trim();
      const structuredKeys = ["proposedTitle", "restatement", "goal", "users", "inScope", "outOfScope", "assumptions", "unknowns", "summary"];
      const hasStructuredEdits = structuredKeys.some((key) => answers.answers[key] !== undefined);
      const reflect = state.reflect && hasStructuredEdits
        ? applyReflectEdits(state.reflect, answers.answers)
        : undefined;
      const brief = flatBrief && (!state.reflect || !hasStructuredEdits) ? flatBrief : reflect ? formatReflectRestatement(reflect) : flatBrief;
      if (!brief) return blocked<State>("invalid_answers", "The confirmed brief cannot be empty");
      const next = { ...state, stage: "grill" as const, brief, ...(reflect ? { reflect } : {}) };
      return { type: "invoke-agent" as const, state: next, request: agentRequest("griller", state.ordinal, `Find material unresolved unknowns in this confirmed brief. Ask one structured batch, or mark resolved and return the clarified brief.\n\n${brief}`, grillSchema) };
    }
    if (state.stage !== "questions") return blocked<State>("unexpected_answers", `Answers received in ${state.stage}`);
    const transcript = [...state.transcript, { questions: [], answers: answers.answers }];
    const ordinal = state.ordinal + 1;
    const next = { ...state, stage: "grill" as const, transcript, ordinal };
    return { type: "invoke-agent" as const, state: next, request: agentRequest("griller", ordinal, `Continue clarification using these exact answers. Ask another batch only for material unknowns; otherwise mark resolved.\n\n${JSON.stringify(answers.answers)}`, grillSchema, state.sessionId) };
  }
  onCommand(_state: State, _result: CommandResult) { return blocked<State>("unexpected_command", "Clarify does not run project commands"); }
}
