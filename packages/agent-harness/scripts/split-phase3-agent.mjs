import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const agentPath = path.join(root, "src", "agent.ts");
const backupPath = path.join(root, "src", "agent.ts.phase3-backup");
if (!existsSync(backupPath)) {
  copyFileSync(agentPath, backupPath);
}
const sourcePath = existsSync(backupPath) ? backupPath : agentPath;
const lines = readFileSync(sourcePath, "utf8").split(/\r?\n/);
const outDir = "src/infrastructure/agents";

function slice(start1, end1) {
  return lines.slice(start1 - 1, end1).join("\n");
}

function write(rel, contents) {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  if (!contents.endsWith("\n")) contents += "\n";
  writeFileSync(file, contents, "utf8");
  console.log(`wrote ${rel} (${contents.split("\n").length - 1} lines)`);
}

write(
  `${outDir}/types.ts`,
  `import { z } from "zod";
import type { AgentRole } from "../../domain.js";
import { HarnessFailure } from "../../errors.js";

${slice(21, 51)}

${slice(59, 125)}
`,
);

{
  let body = slice(841, 925);
  body = body.replace(
    /^function tryResolveAgentOutput\(/m,
    "export function tryResolveAgentOutput(",
  );
  write(`${outDir}/output-parser.ts`, body);
}

write(
  `${outDir}/activity-tracker.ts`,
  `import type { AgentRole } from "../../domain.js";
import type { RunStore } from "../../store.js";
import type { AgentStepEvent } from "./types.js";

/** Mutable so tests can exercise the cap without writing thousands of lines. */
export const stepPersistenceLimits = {
  maxLines: 2_000,
  maxBytes: 256 * 1024,
};
const ACTIVITY_WRITE_MIN_MS = 1_000;

${slice(927, 1047).replace(
    /^function createSessionActivityTracker\(/m,
    "export function createSessionActivityTracker(",
  )}
`,
);

{
  let body = slice(1049, 1118);
  body = body.replaceAll('import("./domain.js")', 'import("../../domain.js")');
  write(
    `${outDir}/step-utils.ts`,
    `import { detectInstallFromCommand } from "../../commands.js";
import type { AgentStepEvent } from "./types.js";

${body}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
`,
  );
}

write(
  `${outDir}/usage.ts`,
  `import type { AgentBackendResult } from "./types.js";

${slice(791, 819).replace(/^function usageRecord\(/m, "export function usageRecord(")}
`,
);

write(
  `${outDir}/cursor-backend.ts`,
  `import { HarnessFailure } from "../../errors.js";
import {
  AgentBackendRunError,
  type AgentBackend,
  type AgentBackendResult,
} from "./types.js";
import { detectInstallFromToolStep, summarizeAgentStep } from "./step-utils.js";
import { reportedTotal } from "./usage.js";

${slice(553, 764)}

${slice(829, 839)}

${slice(1120, 1144)}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
`,
);

write(
  `${outDir}/fake-backend.ts`,
  `import { randomUUID } from "node:crypto";
import type { AgentRole } from "../../domain.js";
import type { AgentBackend, AgentRequest } from "./types.js";

${slice(766, 789)}
`,
);

// coordinator: class + helpers (knownPaths, fingerprint, repair, withTimeout, taskId)
write(
  `${outDir}/agent-coordinator.ts`,
  `import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { HarnessConfig } from "../../config.js";
import { modelForRole } from "../../config.js";
import {
  PromptBuilderOutputSchema,
  type AgentRole,
  type WorkPacket,
} from "../../domain.js";
import { HarnessFailure, RunCancelledError } from "../../errors.js";
import { LocalKnowledgeBase } from "../../knowledge.js";
import { buildWorkPacket } from "../../packet.js";
import {
  renderContinuationPrompt,
  renderPrompt,
  renderPromptBuilderPrompt,
} from "../../prompts.js";
import { RunStore } from "../../store.js";
import { createSessionActivityTracker } from "./activity-tracker.js";
import { resolveAgentOutput, tryResolveAgentOutput } from "./output-parser.js";
import {
  AgentBackendRunError,
  type AgentBackend,
  type AgentBackendResult,
  type AgentInvocation,
  type InvokeInput,
} from "./types.js";
import { usageRecord } from "./usage.js";

export class AgentCoordinator {
${slice(128, 523).replace(/^export class AgentCoordinator \{\n/, "")}

${slice(526, 551)}

${slice(821, 827)}

${slice(1103, 1109)}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

${slice(1150, 1195)}
`,
);

write(
  "src/agent.ts",
  `/** Compatibility barrel for agent infrastructure modules (Phase 3). */
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
`,
);

console.log("agent split complete");
