import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const lines = readFileSync(path.join(root, "src/ui/server.ts.phase4-backup"), "utf8").split(/\r?\n/);
function slice(a, b) {
  return lines.slice(a - 1, b).join("\n");
}
/** Body of a top-level function: strip signature through opening brace and trailing closing brace. */
function body(a, b) {
  let text = slice(a, b);
  text = text.replace(/^[\s\S]*?\{\n/, "");
  text = text.replace(/\n\}\s*$/, "");
  return text;
}

writeFileSync(
  path.join(root, "src/ui/http/run-reads.ts"),
  `import type { RunState, WorkPacket } from "../../domain.js";
import { renderPrompt, renderPromptBuilderPrompt } from "../../prompts.js";
import type { RunStore } from "../../store.js";
import type { UiJob } from "../run-job-service.js";
import { isRecord, isString } from "./request.js";

export function summarizeRun(state: RunState, job?: UiJob): Record<string, unknown> {
${body(726, 748)}
}

export type UiActivity = {
  sessionId?: string;
  role?: string;
  model?: string;
  startedAt?: string;
  lastStepAt?: string;
  lastStepSummary?: string;
  stepCount?: number;
  truncated?: boolean;
};

/**
 * Cheap change signature for polling clients: state.revision plus job status
 * plus lastEventSequence plus live activity — no events.jsonl read needed to
 * detect "nothing changed". activity.lastStepAt and stepCount must be included
 * or unchanged-poll short-circuiting hides in-flight agent steps.
 */
export function runSignature(state: RunState, job?: UiJob, activity?: UiActivity | null): string {
${body(766, 775)}
}

export async function readActivity(store: RunStore, runId: string): Promise<UiActivity | null> {
${body(776, 785)}
}

export async function readEvents(store: RunStore, runId: string): Promise<unknown[]> {
${body(804, 817)}
}

export async function readSessionSummaries(store: RunStore, runId: string): Promise<unknown[]> {
${body(818, 844)}
}

export async function readSessionDetail(
  store: RunStore,
  runId: string,
  sessionPath: string,
): Promise<Record<string, unknown>> {
${body(845, 897)}
}

async function readSessionSteps(
  store: RunStore,
  runId: string,
  stepsPath: string,
): Promise<unknown[] | undefined> {
${body(898, 922)}
}

async function submittedPrompt(
  store: RunStore,
  runId: string,
  session: Record<string, unknown>,
  packet: WorkPacket | undefined,
): Promise<{ prompt?: string; source: string }> {
${body(923, 985)}
}

export async function listArtifacts(store: RunStore, runId: string): Promise<string[]> {
${body(994, 1021)}
}

export function allowedArtifact(value: string): boolean {
${body(1022, 1038)}
}

export async function readInstallLog(
  store: RunStore,
  runId: string,
): Promise<Array<Record<string, unknown>>> {
${body(1039, 1061)}
}
`,
  "utf8",
);

console.log("rewrote run-reads.ts");
