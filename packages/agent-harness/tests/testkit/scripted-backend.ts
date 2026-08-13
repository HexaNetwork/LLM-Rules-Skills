import { randomUUID } from "node:crypto";
import type { AgentBackend, AgentRequest, AgentStepEvent } from "../../src/infrastructure/agents/types.js";
import type { AgentRole } from "../../src/domain.js";

export type ScriptedStep =
  | { role: AgentRole; output: unknown; steps?: AgentStepEvent[] }
  | { role: AgentRole; error: Error; steps?: AgentStepEvent[] }
  | { role: AgentRole; waitFor?: Promise<void>; output: unknown; steps?: AgentStepEvent[] };

export type ScriptedCall = {
  role: AgentRole;
  input: unknown;
  objective: string;
  retrieval: {
    cwd: string;
    mode?: AgentRequest["mode"];
    providerSessionId?: string;
    taskId?: string;
  };
};

export function createScriptedBackend(steps: ScriptedStep[]): {
  backend: AgentBackend;
  calls: ScriptedCall[];
  assertExhausted(): void;
} {
  const queue = [...steps];
  const calls: ScriptedCall[] = [];

  const backend: AgentBackend = {
    async run(request) {
      if (queue.length === 0) {
        throw new Error(
          `ScriptedBackend: unexpected call for role "${request.role}" with no remaining steps`,
        );
      }
      const step = queue.shift()!;
      if (step.role !== request.role) {
        // Verification gate is inserted before planning; allow scripted suites to
        // omit an explicit project-profiler step and keep-current by default.
        if (request.role === "project-profiler") {
          queue.unshift(step);
          calls.push({
            role: request.role,
            input: sanitizeRequest(request),
            objective: deriveObjective(request),
            retrieval: {
              cwd: request.cwd,
              mode: request.mode,
              providerSessionId: request.providerSessionId,
              taskId: request.taskId}});
          const providerSessionId = request.providerSessionId ?? randomUUID();
          return {
            output: {
              summary: "Keep current verification settings",
              configPatch: {}},
            providerSessionId,
            providerRunId: randomUUID(),
            providerSessionReused: request.providerSessionId != null,
            submittedPrompt: request.continuationPrompt ?? request.prompt};
        }
        throw new Error(
          `ScriptedBackend: expected role "${step.role}" but received "${request.role}"`,
        );
      }

      calls.push({
        role: request.role,
        input: sanitizeRequest(request),
        objective: deriveObjective(request),
        retrieval: {
          cwd: request.cwd,
          mode: request.mode,
          providerSessionId: request.providerSessionId,
          taskId: request.taskId}});

      if ("waitFor" in step && step.waitFor) {
        await step.waitFor;
      }
      emitScriptedSteps(request, step.steps);
      if ("error" in step) {
        throw step.error;
      }

      const providerSessionId = request.providerSessionId ?? randomUUID();
      const providerSessionReused = request.providerSessionId != null;
      return {
        output: step.output,
        providerSessionId,
        providerRunId: randomUUID(),
        providerSessionReused,
        submittedPrompt: providerSessionReused
          ? request.continuationPrompt ?? request.prompt
          : request.prompt};
    },
    async release() {
      // Scripted sessions have no external resources.
    }};

  return {
    backend,
    calls,
    assertExhausted() {
      if (queue.length > 0) {
        const remaining = queue.map((step) => step.role).join(", ");
        throw new Error(
          `ScriptedBackend: ${queue.length} unconsumed step(s) remaining: ${remaining}`,
        );
      }
    }};
}

function emitScriptedSteps(
  request: AgentRequest,
  steps: AgentStepEvent[] | undefined,
): void {
  if (!steps?.length) return;
  for (const step of steps) {
    request.onStep?.(step);
  }
}

function sanitizeRequest(request: AgentRequest): Record<string, unknown> {
  return {
    role: request.role,
    model: request.model,
    prompt: request.prompt,
    continuationPrompt: request.continuationPrompt,
    providerSessionId: request.providerSessionId,
    retainProviderSession: request.retainProviderSession,
    mode: request.mode,
    cwd: request.cwd,
    taskId: request.taskId};
}

function deriveObjective(request: AgentRequest): string {
  const source = request.continuationPrompt ?? request.prompt;
  const firstLine = source.split(/\r?\n/).find((line) => line.trim().length > 0);
  return (firstLine ?? source).slice(0, 500);
}
