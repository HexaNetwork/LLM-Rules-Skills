import type { AgentTurnResult, CommandResult, EnvironmentSpec, StepTransition, UserAnswers, WorkflowStep } from "../types.js";
import { parseEnvironmentSpec } from "../schemas.js";
import { agentRequest, arraySchema, blocked, commandFailure, objectSchema, stringSchema, type StepInput } from "./common.js";

type State = { stage: "plan" | "build" | "setup" | "health" | "environment-gate"; spec?: EnvironmentSpec; image?: string; digest?: string; containerName?: string; commandIndex: number; ordinal: number; input: StepInput; plannerSessionId?: string; evidence: CommandResult[]; diagnostic?: string; retryStage?: "build" | "setup" | "health" };
type Output = { environmentSpec: EnvironmentSpec; image: string; digest: string; containerName: string; healthEvidence: CommandResult[] };
const schema = objectSchema(["containerfile", "setupCommands", "healthcheckCommands", "caches"], { containerfile: stringSchema, setupCommands: arraySchema, healthcheckCommands: arraySchema, caches: arraySchema });

export class ProvisionEnvironmentStep implements WorkflowStep<StepInput, State, Output> {
  readonly id = "provision-environment";
  start(input: StepInput) {
    const explicit = input.effectiveConfig.environmentSpec;
    if (explicit) return this.build({ stage: "plan", spec: parseEnvironmentSpec(explicit), commandIndex: 0, ordinal: 0, input, evidence: [] });
    const state: State = { stage: "plan", commandIndex: 0, ordinal: 0, input, evidence: [] };
    return { type: "invoke-agent" as const, state, request: agentRequest("environment-planner", 0, `Using repository evidence and this approved specification, produce a strict language-neutral EnvironmentSpec. The Containerfile must extend the configured runner image exactly and justify toolchains only through the resulting commands.\nRunner image: ${String(input.effectiveConfig.runnerImage)}\nSpecification: ${JSON.stringify(input.previous)}`, schema) };
  }
  onAgent(state: State, result: AgentTurnResult) { try { return this.build({ ...state, spec: parseEnvironmentSpec(result.output), plannerSessionId: result.sessionId }); } catch (error) { return blocked<State>("invalid_environment_spec", error); } }
  onCommand(state: State, result: CommandResult) {
    const failure = commandFailure(result);
    if (failure) {
      const retryStage: "build" | "setup" | "health" = state.stage === "setup" || state.stage === "health" ? state.stage : "build";
      return { type: "await-user" as const, state: { ...state, stage: "environment-gate" as const, diagnostic: failure, retryStage }, gate: { id: `environment-failure-${state.ordinal}`, title: "Environment provisioning failed", questions: [{ id: "action", prompt: `${failure}\n\nEnter retry to rerun this EnvironmentSpec, or describe a required EnvironmentSpec change.`, required: true }] } };
    }
    if (!state.spec) return blocked<State>("missing_environment_spec", "EnvironmentSpec was not persisted");
    if (state.stage === "build") {
      const built = JSON.parse(result.stdout) as { image: string; digest: string; containerName: string };
      const next = { ...state, stage: "setup" as const, image: built.image, digest: built.digest, containerName: built.containerName, commandIndex: 0, evidence: [...state.evidence, result] };
      return this.nextEnvironmentCommand(next);
    }
    return this.nextEnvironmentCommand({ ...state, commandIndex: state.commandIndex + 1, evidence: [...state.evidence, result] });
  }
  onUser(state: State, answers: UserAnswers) {
    if (state.stage !== "environment-gate") return blocked<State>("unexpected_answers", "Provisioning is not awaiting user input");
    const action = answers.answers.action?.trim(); if (!action) return blocked<State>("invalid_answers", "An environment action is required");
    if (action.toLowerCase() === "retry") {
      if (!state.spec) return blocked<State>("missing_environment_spec", "EnvironmentSpec was not persisted");
      if (state.image && state.retryStage && state.retryStage !== "build") return this.nextEnvironmentCommand({ ...state, stage: state.retryStage });
      return this.build({ ...state, stage: "plan" });
    }
    const ordinal = state.ordinal + 1;
    return { type: "invoke-agent" as const, state: { ...state, stage: "plan" as const, ordinal }, request: agentRequest("environment-planner", ordinal, `Revise the EnvironmentSpec for this exact provisioning diagnostic and operator request. Do not change the shared runner.\nDiagnostic: ${state.diagnostic}\nRequest: ${action}\nCurrent spec: ${JSON.stringify(state.spec)}`, schema, state.plannerSessionId) };
  }
  private build(state: State): StepTransition<State, Output> { return { type: "run-command", state: { ...state, stage: "build" }, request: { actionId: `environment/build/0`, command: JSON.stringify(state.spec) } }; }
  private nextEnvironmentCommand(state: State): StepTransition<State, Output> {
    const setup = state.spec!.setupCommands;
    const health = state.spec!.healthcheckCommands;
    if (state.stage === "setup" && state.commandIndex < setup.length) return { type: "run-command" as const, state, request: { actionId: `environment/setup/${state.commandIndex}`, command: setup[state.commandIndex]! } };
    if (state.stage === "setup") return this.nextEnvironmentCommand({ ...state, stage: "health", commandIndex: 0 });
    if (state.commandIndex < health.length) return { type: "run-command" as const, state, request: { actionId: `environment/health/${state.commandIndex}`, command: health[state.commandIndex]! } };
    return { type: "complete" as const, output: { environmentSpec: state.spec!, image: state.image!, digest: state.digest!, containerName: state.containerName!, healthEvidence: state.evidence } };
  }
}
