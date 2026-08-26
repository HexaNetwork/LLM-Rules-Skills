import type { Task, VerificationEvidence } from "./types.js";

const VERIFICATION_OUTPUT_CAP = 8_000;

export type SlimTask = {
  id: string;
  title: string;
  description: string;
  commitSha?: string;
};

export type SlimVerification = {
  command: string;
  passed: boolean;
  classification: VerificationEvidence["classification"];
  output: string;
};

export function slimBrief(reflectBrief: unknown): string | Record<string, unknown> {
  if (typeof reflectBrief === "string") return reflectBrief;
  if (!reflectBrief || typeof reflectBrief !== "object") {
    return String(reflectBrief ?? "");
  }
  const record = reflectBrief as Record<string, unknown>;
  if (typeof record.confirmed === "string" && record.confirmed.trim()) {
    return record.confirmed.trim();
  }
  const structured = asRecord(record.structured) ?? asRecord(record.confirmedStructured);
  if (structured) {
    return {
      restatement: structured.restatement,
      goal: structured.goal,
      inScope: structured.inScope,
      outOfScope: structured.outOfScope,
      assumptions: structured.assumptions,
    };
  }
  return record;
}

export function flattenResolutions(resolutions: unknown): Record<string, string> {
  if (!resolutions || typeof resolutions !== "object" || Array.isArray(resolutions)) {
    return {};
  }
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(resolutions as Record<string, unknown>)) {
    if (typeof value === "string") flat[key] = value;
  }
  return flat;
}

export function slimTask(task: Task | Record<string, unknown>): SlimTask {
  const slim: SlimTask = {
    id: String(task.id ?? ""),
    title: String(task.title ?? ""),
    description: String(task.description ?? ""),
  };
  const commitSha = task.commitSha;
  if (typeof commitSha === "string" && commitSha.trim()) {
    slim.commitSha = commitSha.trim();
  }
  return slim;
}

export function slimTasks(tasks: Array<Task | Record<string, unknown>> | undefined): SlimTask[] {
  if (!tasks?.length) return [];
  return tasks.map(slimTask);
}

export function slimVerification(
  evidence: VerificationEvidence | Record<string, unknown> | undefined,
): SlimVerification | undefined {
  if (!evidence || typeof evidence !== "object") return undefined;
  const command = typeof evidence.command === "string" ? evidence.command : "";
  const passed = Boolean(evidence.passed);
  const classification =
    evidence.classification === "passed" ||
    evidence.classification === "project_failure" ||
    evidence.classification === "environment_failure"
      ? evidence.classification
      : passed
        ? "passed"
        : "project_failure";
  const rawOutput = typeof evidence.output === "string" ? evidence.output : String(evidence.output ?? "");
  const output =
    rawOutput.length > VERIFICATION_OUTPUT_CAP
      ? `${rawOutput.slice(0, VERIFICATION_OUTPUT_CAP)}\n…[truncated]`
      : rawOutput;
  return { command, passed, classification, output };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
