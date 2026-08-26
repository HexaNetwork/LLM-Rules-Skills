import { buildDocsWriterInput, type DocsWriterPacketInput } from "./docs-writer.js";
import {
  flattenResolutions,
  slimBrief,
  slimTask,
  slimTasks,
  slimVerification,
} from "./packet-slim.js";
import type { FogResolution, Task, VerificationEvidence } from "./types.js";
import type { VerificationRuntime } from "./verification-runtime.js";

export { buildDocsWriterInput };
export type { DocsWriterPacketInput };

function packet(entries: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function buildReflectorInput(input: { idea: string }): Record<string, unknown> {
  return packet({ idea: input.idea });
}

export function buildGrillerInput(input: {
  brief: unknown;
  fog: unknown;
  notes?: unknown;
  resolutions?: unknown;
}): Record<string, unknown> {
  return packet({
    brief: slimBrief(input.brief),
    fog: input.fog,
    notes: input.notes,
    resolutions: flattenResolutions(input.resolutions),
  });
}

export function buildProjectProfilerInput(input: {
  brief: unknown;
  liveVerification: unknown;
  runtime: VerificationRuntime;
}): Record<string, unknown> {
  return packet({
    brief: slimBrief(input.brief),
    liveVerification: input.liveVerification,
    runtime: input.runtime,
  });
}

export function buildPlannerInput(input: {
  brief: unknown;
  resolutions?: unknown;
  fogResolutions?: FogResolution[] | unknown;
  planningFeedback?: unknown;
  operatorNotes?: unknown;
}): Record<string, unknown> {
  return packet({
    brief: slimBrief(input.brief),
    resolutions: flattenResolutions(input.resolutions),
    fogResolutions: input.fogResolutions ?? [],
    planningFeedback: input.planningFeedback,
    operatorNotes: input.operatorNotes,
  });
}

export function buildScenarioPlannerInput(input: {
  plan: unknown;
  prd: unknown;
  planningFeedback?: unknown;
  operatorNotes?: unknown;
}): Record<string, unknown> {
  return packet({
    plan: input.plan,
    prd: input.prd,
    planningFeedback: input.planningFeedback,
    operatorNotes: input.operatorNotes,
  });
}

export function buildIssueSlicerInput(input: {
  plan: unknown;
  prd: unknown;
  scenarios: unknown;
}): Record<string, unknown> {
  return packet({
    plan: input.plan,
    prd: input.prd,
    scenarios: input.scenarios,
  });
}

export function buildImplementerInput(input: {
  task: Task | Record<string, unknown>;
  brief: unknown;
  plan: unknown;
  reviewFeedback?: unknown;
  verification?: VerificationEvidence | Record<string, unknown>;
  verificationCommands?: { command?: string; fixCommand?: string };
}): Record<string, unknown> {
  return packet({
    task: slimTask(input.task),
    brief: slimBrief(input.brief),
    plan: input.plan,
    reviewFeedback: input.reviewFeedback,
    verification: slimVerification(input.verification),
    verificationCommands: slimVerificationCommands(input.verificationCommands),
  });
}

export function buildImplementerRepairInput(input: {
  repair?: boolean;
  finalReview: unknown;
  plan: unknown;
  tasks: Array<Task | Record<string, unknown>>;
  verificationCommands?: { command?: string; fixCommand?: string };
}): Record<string, unknown> {
  return packet({
    repair: input.repair ?? true,
    finalReview: input.finalReview,
    plan: input.plan,
    tasks: slimTasks(input.tasks),
    verificationCommands: slimVerificationCommands(input.verificationCommands),
  });
}

function slimVerificationCommands(commands: { command?: string; fixCommand?: string } | undefined):
  | { command: string; fixCommand?: string }
  | undefined {
  if (!commands?.command?.trim()) return undefined;
  const slim: { command: string; fixCommand?: string } = { command: commands.command.trim() };
  if (commands.fixCommand?.trim()) slim.fixCommand = commands.fixCommand.trim();
  return slim;
}

export function buildTaskReviewerInput(input: {
  task: Task | Record<string, unknown>;
  implemented: unknown;
  verification?: VerificationEvidence | Record<string, unknown>;
}): Record<string, unknown> {
  return packet({
    task: slimTask(input.task),
    implemented: input.implemented,
    verification: slimVerification(input.verification),
  });
}

export function buildReviewerInput(input: {
  plan: unknown;
  tasks: Array<Task | Record<string, unknown>>;
  scenarioTest?: unknown;
  verification?: VerificationEvidence | Record<string, unknown>;
}): Record<string, unknown> {
  return packet({
    plan: input.plan,
    tasks: slimTasks(input.tasks),
    scenarioTest: input.scenarioTest,
    verification: slimVerification(input.verification),
  });
}

export function buildFixerInput(input: {
  failure: unknown;
  scenarios: unknown;
}): Record<string, unknown> {
  return packet({
    failure: input.failure,
    scenarios: input.scenarios,
  });
}

export function buildMessageWriterInput(input: {
  idea: string;
  plan: unknown;
  tasks?: Array<Task | Record<string, unknown>>;
}): Record<string, unknown> {
  const committed = (input.tasks ?? []).filter(
    (task) => (task as Task).status === "committed" || Boolean(task.commitSha),
  );
  return packet({
    idea: input.idea,
    plan: input.plan,
    tasks: slimTasks(committed),
  });
}

export function buildImageFixerInput(input: {
  command: string;
  output: string;
  dockerfile: string;
  image: string;
}): Record<string, unknown> {
  return packet({
    command: input.command,
    output: input.output,
    dockerfile: input.dockerfile,
    image: input.image,
  });
}
