import type { AgentTurnResult, CommandResult, StepTransition, UserAnswers, WorkflowStep } from "../types.js";
import { agentRequest, arraySchema, blocked, booleanSchema, commandFailure, objectSchema, stringSchema, type StepInput } from "./common.js";

type State = { stage: "commands" | "review" | "repair"; commands: string[]; commandIndex: number; evidence: CommandResult[]; repairAttempt: number; repairLimit: number; ordinal: number; repairSessionId?: string };
type Output = { commandEvidence: CommandResult[]; finalReview: unknown };
const reviewSchema = objectSchema(["approved", "findings"], { approved: booleanSchema, findings: arraySchema });
const repairSchema = objectSchema(["summary"], { summary: stringSchema });

export class ValidateStep implements WorkflowStep<StepInput, State, Output> {
  readonly id = "validate";
  start(input: StepInput) {
    const specification = ((input.outputs.specify as { approvedSpecification?: Record<string, unknown> } | undefined)?.approvedSpecification ?? {});
    const configured = input.effectiveConfig.verificationCommands;
    const scenarioCommands = Array.isArray(specification.scenarioCommands) ? specification.scenarioCommands.map(String) : [];
    const projectCommands = Array.isArray(configured) ? configured.map(String) : Array.isArray(specification.verificationCommands) ? specification.verificationCommands.map(String) : [];
    const coverage = specification.coverageRequired === true && Array.isArray(input.effectiveConfig.coverageCommands) ? input.effectiveConfig.coverageCommands.map(String) : [];
    const commands = [...scenarioCommands, ...projectCommands, ...coverage];
    const state: State = { stage: "commands", commands, commandIndex: 0, evidence: [], repairAttempt: 0, repairLimit: Number(input.effectiveConfig.finalRepairAttemptLimit ?? 2), ordinal: 0 };
    return this.nextCommandOrReview(state);
  }
  onCommand(state: State, result: CommandResult) {
    if (state.stage !== "commands") return blocked<State>("unexpected_command", `Command result received in ${state.stage}`);
    const evidence = [...state.evidence, result];
    const failure = commandFailure(result);
    if (failure) return this.invokeRepair({ ...state, evidence }, `Validation failed:\n${failure}`);
    return this.nextCommandOrReview({ ...state, evidence, commandIndex: state.commandIndex + 1 });
  }
  onAgent(state: State, result: AgentTurnResult) {
    if (state.stage === "review") {
      const output = result.output as { approved?: unknown; findings?: unknown[] };
      if (typeof output.approved !== "boolean" || !Array.isArray(output.findings)) return blocked<State>("invalid_final_review", "Final reviewer returned an invalid review");
      if (output.approved) return { type: "complete" as const, output: { commandEvidence: state.evidence, finalReview: output } };
      return this.invokeRepair(state, `Final review findings:\n${JSON.stringify(output.findings)}`);
    }
    if (state.stage === "repair") return this.nextCommandOrReview({ ...state, stage: "commands", commandIndex: 0, repairSessionId: result.sessionId, ordinal: state.ordinal + 1 });
    return blocked<State>("unexpected_agent_result", `Agent result received in ${state.stage}`);
  }
  onUser(_state: State, _answers: UserAnswers) { return blocked<State>("unexpected_answers", "Validate is not awaiting user input"); }
  private nextCommandOrReview(state: State): StepTransition<State, Output> {
    if (state.commandIndex < state.commands.length) return { type: "run-command" as const, state, request: { actionId: `validation/command/${state.commandIndex}/repair-${state.repairAttempt}`, command: state.commands[state.commandIndex]! } };
    return { type: "invoke-agent", state: { ...state, stage: "review" }, request: agentRequest("final-reviewer", state.ordinal, `Independently review the complete change against the approved specification and validation evidence. Return approved and actionable findings.\n${JSON.stringify(state.evidence)}`, reviewSchema) };
  }
  private invokeRepair(state: State, findings: string): StepTransition<State, Output> {
    const repairAttempt = state.repairAttempt + 1;
    if (repairAttempt > state.repairLimit) return blocked<State>("final_repair_attempts_exhausted", findings);
    const ordinal = state.ordinal + 1;
    return { type: "invoke-agent", state: { ...state, stage: "repair", repairAttempt, ordinal }, request: agentRequest("final-repairer", ordinal, `Repair only these validated findings in /workspace. Do not commit or publish.\n${findings}`, repairSchema, state.repairSessionId) };
  }
}
