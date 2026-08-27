import path from "node:path";
import type { AgentDriver } from "./agent-runtime.js";
import { AgentDeadlineError } from "./agent-runtime.js";
import type { ContainerRuntime } from "./container-runtime.js";
import type { EnvironmentManager } from "./environment-manager.js";
import type { GitRuntime } from "./git-runtime.js";
import { deliveryBranch } from "./git-runtime.js";
import type { Store } from "./store.js";
import type { AgentTurnRequest, AgentTurnResult, CommandResult, DurableCommand, JsonObject, StepTransition, UserAnswers, WorkflowDefinition, WorkflowStep } from "./types.js";
import type { GuidanceService } from "./guidance.js";
import { resolveModel } from "./config.js";
import { validateJsonSchema } from "./schemas.js";

type Dependencies = { store: Store; workflows: Map<string, WorkflowDefinition>; agent: AgentDriver; containers: ContainerRuntime; environments: EnvironmentManager; git: GitRuntime; worktreeRoot: string; guidance: GuidanceService };

export class WorkflowEngine {
  constructor(private readonly deps: Dependencies) {}

  async process(command: DurableCommand): Promise<void> {
    const run = this.deps.store.getRun(command.runId);
    if (run.status === "cancelled" || run.status === "completed") return;
    const workflow = this.workflow(run.workflowId);
    if (command.kind === "start-run") return this.startRun(command, run.input);
    if (command.kind === "cancel-run") return this.cancelRun(run.id);
    const step = this.step(workflow, run.currentStep);
    const record = this.deps.store.stepRecord(run.id, step.id);
    if (command.kind === "submit-answers") {
      if (!record) throw new Error("Cannot answer before the step starts");
      const answers = command.payload as UserAnswers;
      this.deps.store.answerGate(run.id, answers);
      const transition = step.onUser(record.state, answers);
      this.persist(run.id, step.id, stateOf(transition, record.state), transition);
      return this.queueContinue(run.id, step.id, run.revision + 1);
    }
    if (command.kind === "retry-turn") this.deps.store.setRunStatus(run.id, "queued", "Retry requested");
    if (!record) {
      const input = { previous: this.deps.store.previousOutput(run.id, workflow.steps.map((item) => item.id), step.id), runInput: run.input, effectiveConfig: this.deps.store.effectiveConfig(run.id), outputs: this.deps.store.outputs(run.id) };
      const transition = step.start(input);
      this.persist(run.id, step.id, stateOf(transition, {}), transition);
      return this.afterPureTransition(run.id, workflow, step, transition, run.revision + 1);
    }
    if (!record.transition) throw new Error(`Step ${step.id} has no durable transition`);
    await this.executeTransition(run.id, workflow, step, record.state, record.transition);
  }

  private async startRun(command: DurableCommand, input: JsonObject): Promise<void> {
    const run = this.deps.store.getRun(command.runId);
    const project = this.deps.store.getProject(run.projectId);
    const baseBranch = String(input.baseBranch ?? project.baseBranch).trim();
    if (!baseBranch) throw new Error("baseBranch is required");
    await this.deps.git.createWorktree({ runId: run.id, repositoryPath: project.repositoryPath, baseBranch, fresh: Boolean(input.fresh) });
    this.deps.store.setRunStatus(run.id, "queued", "Run worktree is ready");
    this.queueContinue(run.id, run.currentStep, run.revision + 1);
  }

  private async cancelRun(runId: string): Promise<void> {
    await this.deps.containers.destroy(runId);
    this.deps.store.setRunStatus(runId, "cancelled", "Run cancelled and container removed");
  }

  private async executeTransition(runId: string, workflow: WorkflowDefinition, step: WorkflowStep<unknown, unknown, unknown>, state: unknown, transition: StepTransition<unknown, unknown>): Promise<void> {
    if (transition.type === "await-user" || transition.type === "blocked") return;
    if (transition.type === "complete") return this.complete(runId, workflow, step, transition.output);
    try {
      if (transition.type === "invoke-agent") {
        const result = await this.invokeAgent(runId, step.id, state, transition.request);
        const errors = validateJsonSchema(result.output, transition.request.outputSchema);
        if (errors.length) return this.scheduleCorrection(runId, step.id, state, transition.request, result, errors);
        const next = step.onAgent(state, result);
        this.persist(runId, step.id, stateOf(next, state), next);
        return this.afterPureTransition(runId, workflow, step, next, this.deps.store.getRun(runId).revision);
      }
      const result = await this.runCommand(runId, step.id, transition.request.actionId, transition.request.command, transition.request.timeoutMs);
      const next = step.onCommand(state, result);
      this.persist(runId, step.id, stateOf(next, state), next);
      return this.afterPureTransition(runId, workflow, step, next, this.deps.store.getRun(runId).revision);
    } catch (error) {
      const status = error instanceof AgentDeadlineError ? "stalled" : "blocked";
      if (this.deps.store.getRun(runId).status !== "cancelled") this.deps.store.setRunStatus(runId, status, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private async invokeAgent(runId: string, stepId: string, state: unknown, request: AgentTurnRequest): Promise<AgentTurnResult> {
    const ordinal = String(request.turnId).split("-").at(-1) ?? "0";
    const actionKey = `${runId}/${stepId}/agent/${request.role}/${ordinal}`;
    const canonical = { ...request, turnId: actionKey };
    const existing = this.deps.store.turnResult(actionKey);
    if (existing) return existing;
    this.deps.store.createTurn(runId, stepId, actionKey, canonical);
    const config = this.deps.store.effectiveConfig(runId);
    const run = this.deps.store.getRun(runId);
    const workspace = this.workspace(runId);
    const containerName = ["implement", "validate", "publish"].includes(stepId) ? this.deps.containers.containerName(runId) : undefined;
    const model = resolveModel((config.models ?? {}) as Record<string, string>, request.role);
    const contextText = await this.deps.guidance.compileContext(request.role, run.projectId).catch(() => "");
    const enriched: AgentTurnRequest = contextText
      ? { ...canonical, prompt: `${contextText}\n\nTask:\n${canonical.prompt}` }
      : canonical;
    try {
      const result = await this.deps.agent.invoke(enriched, { runId, workspace, containerName, deadlineMs: Number(config.agentDeadlineMs), model, projectId: run.projectId });
      this.deps.store.finishTurn(actionKey, result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.store.failTurn(actionKey, error instanceof AgentDeadlineError ? "stalled" : "blocked", message);
      throw error;
    }
  }

  private scheduleCorrection(runId: string, stepId: string, state: unknown, request: AgentTurnRequest, result: AgentTurnResult, errors: string[]): void {
    if (request.role.endsWith(":correction")) {
      this.deps.store.saveTransition(runId, stepId, state, { type: "blocked", error: { code: "structured_output_exhausted", message: errors.join("; "), detail: result.output, retryable: false } }, "blocked");
      return;
    }
    const correction: AgentTurnRequest = { ...request, turnId: `${request.turnId}-correction-1`, role: `${request.role}:correction`, sessionId: result.sessionId, prompt: `${request.prompt}\n\nYour previous output failed validation: ${errors.join("; ")}. Return one corrected JSON object.` };
    const transition: StepTransition<unknown, unknown> = { type: "invoke-agent", state, request: correction };
    this.persist(runId, stepId, state, transition);
    this.queueContinue(runId, stepId, this.deps.store.getRun(runId).revision);
  }

  private async runCommand(runId: string, stepId: string, localActionId: string, command: string, timeoutMs?: number): Promise<CommandResult> {
    const actionId = `${runId}/${stepId}/${localActionId}`;
    if (localActionId.startsWith("environment/")) return this.deps.environments.execute(runId, this.workspace(runId), actionId, command);
    const cached = this.deps.store.recordAction(runId, actionId, "command", { command });
    if (cached) return cached as CommandResult;
    let result: CommandResult;
    if (command.startsWith("git:commit:")) {
      const committed = await this.deps.git.commit(this.workspace(runId), command.slice("git:commit:".length));
      result = { actionId, exitCode: 0, stdout: JSON.stringify(committed), stderr: "" };
    } else if (command.startsWith("git:publish:")) {
      const payload = JSON.parse(command.slice("git:publish:".length)) as { title: string; body: string; runTitle: string };
      const config = this.deps.store.effectiveConfig(runId);
      const publication = (config.publication ?? {}) as { remote?: string; draft?: boolean };
      const published = await this.deps.git.publish({ workspace: this.workspace(runId), branch: deliveryBranch(runId, payload.runTitle), remote: publication.remote ?? "origin", title: payload.title, body: payload.body, draft: publication.draft ?? false });
      await this.deps.containers.destroy(runId);
      result = { actionId, exitCode: 0, stdout: JSON.stringify(published), stderr: "" };
    } else {
      const name = this.deps.containers.containerName(runId);
      if (!(await this.deps.containers.inspect(name))) throw new Error("Run container is missing. Retry after environment recovery; execution will not fall back to the host.");
      result = await this.deps.containers.exec(name, command, timeoutMs); result.actionId = actionId;
    }
    this.deps.store.finishAction(actionId, result);
    return result;
  }

  private persist(runId: string, stepId: string, state: unknown, transition: StepTransition<unknown, unknown>): void {
    const status = transition.type === "await-user" ? "awaiting_user" : transition.type === "blocked" ? "blocked" : "working";
    this.deps.store.saveTransition(runId, stepId, state, transition, status);
    if (transition.type === "await-user") this.deps.store.saveGate(runId, stepId, transition.gate);
  }

  private async afterPureTransition(runId: string, workflow: WorkflowDefinition, step: WorkflowStep<unknown, unknown, unknown>, transition: StepTransition<unknown, unknown>, revision: number): Promise<void> {
    if (transition.type === "complete") await this.complete(runId, workflow, step, transition.output);
    else if (transition.type === "invoke-agent" || transition.type === "run-command") this.queueContinue(runId, step.id, revision);
  }

  private async complete(runId: string, workflow: WorkflowDefinition, step: WorkflowStep<unknown, unknown, unknown>, output: unknown): Promise<void> {
    await this.deps.store.writeArtifact(runId, step.id, "output.json", JSON.stringify(output, null, 2), "application/json");
    if (step.id === "specify") {
      const documents = (output as { documents?: Record<string, unknown> } | undefined)?.documents ?? {};
      for (const [name, content] of Object.entries(documents)) await this.deps.store.writeArtifact(runId, step.id, `${name}.md`, String(content), "text/markdown");
    }
    const index = workflow.steps.findIndex((item) => item.id === step.id);
    const next = workflow.steps[index + 1];
    this.deps.store.completeStep(runId, step.id, output, next?.id);
    if (next) this.queueContinue(runId, next.id, this.deps.store.getRun(runId).revision);
  }

  private queueContinue(runId: string, stepId: string, revision: number): void { this.deps.store.enqueueCommand(runId, "continue", {}, `${runId}/${stepId}/continue/${revision}`); }
  private workflow(id: string): WorkflowDefinition { const workflow = this.deps.workflows.get(id); if (!workflow) throw new Error(`Unknown workflow: ${id}`); return workflow; }
  private step(workflow: WorkflowDefinition, id: string): WorkflowStep<unknown, unknown, unknown> { const step = workflow.steps.find((item) => item.id === id); if (!step) throw new Error(`Unknown step ${id} in ${workflow.id}`); return step; }
  private workspace(runId: string): string { return path.join(this.deps.worktreeRoot, runId); }
}

function stateOf(transition: StepTransition<unknown, unknown>, priorState: unknown): unknown { return "state" in transition ? transition.state : priorState; }
