/** Compatibility barrel for agent infrastructure modules (Phase 3). */
export type {
  AgentBackend,
  AgentBackendResult,
  AgentInvocation,
  AgentRequest,
  AgentStepEvent,
  InvokeInput,
  ObservedInstallEvent,
} from "./infrastructure/agents/types.js";
export { AgentBackendRunError } from "./infrastructure/agents/types.js";
export { AgentCoordinator } from "./infrastructure/agents/agent-coordinator.js";
export { createCursorBackend } from "./infrastructure/agents/cursor-backend.js";
export { createFakeBackend } from "./infrastructure/agents/fake-backend.js";
export {
  parseOutput,
  resolveAgentOutput,
} from "./infrastructure/agents/output-parser.js";
export { stepPersistenceLimits } from "./infrastructure/agents/activity-tracker.js";
export {
  detectInstallFromToolStep,
  summarizeAgentStep,
} from "./infrastructure/agents/step-utils.js";
export { reportedTotal } from "./infrastructure/agents/usage.js";
