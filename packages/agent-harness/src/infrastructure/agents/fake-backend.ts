import { randomUUID } from "node:crypto";
import type { AgentRole } from "../../domain.js";
import type { AgentBackend, AgentRequest, AgentStepEvent } from "./types.js";

export type FakeBackendHandler = (
  request: AgentRequest,
) => unknown | Promise<unknown>;

/** Emit args-free tool-call steps through the request's onStep callback. */
export function emitFakeToolCallSteps(
  request: AgentRequest,
  toolNames: readonly string[],
): void {
  for (const toolName of toolNames) {
    const step: AgentStepEvent = {
      type: "toolCall",
      toolName,
      summary: toolName,
    };
    request.onStep?.(step);
  }
}

export function createFakeBackend(
  handlers: Partial<Record<AgentRole, FakeBackendHandler>>,
): AgentBackend {
  const withDefaults: Partial<Record<AgentRole, FakeBackendHandler>> = {
    // Keep current verification settings unless a test overrides the profiler.
    "project-profiler": () => ({
      summary: "Keep current verification settings",
      configPatch: {},
    }),
    ...handlers,
  };
  return {
    workspaceCapabilities() {
      return { canRestrictWritableWorkspace: true, providerId: "fake" };
    },
    async run(request) {
      const handler = withDefaults[request.role];
      if (!handler) throw new Error(`No fake handler for ${request.role}`);
      const providerSessionId = request.providerSessionId ?? randomUUID();
      const providerSessionReused = request.providerSessionId != null;
      return {
        output: await handler(request),
        providerSessionId,
        providerRunId: randomUUID(),
        providerSessionReused,
        submittedPrompt: providerSessionReused
          ? request.continuationPrompt ?? request.prompt
          : request.prompt,
      };
    },
    async release() {
      // Fake sessions have no external resources.
    },
  };
}
