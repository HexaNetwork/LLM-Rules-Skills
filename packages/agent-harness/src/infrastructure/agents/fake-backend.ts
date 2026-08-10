import { randomUUID } from "node:crypto";
import type { AgentRole } from "../../domain.js";
import type { AgentBackend, AgentRequest } from "./types.js";

export function createFakeBackend(
  handlers: Partial<Record<AgentRole, (request: AgentRequest) => unknown | Promise<unknown>>>,
): AgentBackend {
  const withDefaults: Partial<
    Record<AgentRole, (request: AgentRequest) => unknown | Promise<unknown>>
  > = {
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
