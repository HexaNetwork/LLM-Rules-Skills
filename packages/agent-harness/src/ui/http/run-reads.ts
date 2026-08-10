import {
  buildAgentActivity,
  parseInvocationRecord,
  type AgentActivity,
  type InvocationRecord,
} from "../../application/agent-activity.js";
import type { RunState, WorkPacket } from "../../domain.js";
import { renderPrompt, renderPromptBuilderPrompt } from "../../prompts.js";
import type { RunStore } from "../../store.js";
import type { UiJob } from "../run-job-service.js";
import { isRecord, isString } from "./request.js";

export function summarizeRun(state: RunState, job?: UiJob): Record<string, unknown> {
  const activeQuestion = state.questions.find((question) => question.id === state.activeQuestionId);
  const completedTasks = state.tasks.filter((task) => task.status === "done").length;
  const title =
    state.reflectBrief?.confirmedStructured?.proposedTitle ??
    state.reflectBrief?.structured?.proposedTitle;
  return {
    runId: state.runId,
    idea: state.idea,
    title,
    destination: state.reflectBrief?.confirmed?.slice(0, 120) ?? state.reflectBrief?.draft?.slice(0, 120),
    phase: state.phase,
    updatedAt: state.updatedAt,
    createdAt: state.createdAt,
    taskProgress: { completed: completedTasks, total: state.tasks.length },
    decisions: {
      resolved: state.grillResolutions.length,
      total: state.grillResolutions.length + (activeQuestion?.purpose === "grill" ? 1 : 0),
    },
    activeQuestion,
    failure: state.failure,
    branchName: state.branchName,
    pullRequestUrl: state.pullRequestUrl,
    job,
  };
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
  const activityPart = activity
    ? `${activity.lastStepAt ?? ""}:${activity.stepCount ?? 0}`
    : "none";
  const jobPart = job
    ? `${job.status}:${job.detail ?? ""}:${job.error ?? ""}`
    : "none";
  return `${state.revision}:${state.lastEventSequence}:${jobPart}:${activityPart}`;
}

export async function readActivity(store: RunStore, runId: string): Promise<UiActivity | null> {
  try {
    const value = await store.readJson(runId, "activity.json");
    return isRecord(value) ? (value as UiActivity) : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readEvents(store: RunStore, runId: string): Promise<unknown[]> {
  try {
    const raw = await store.readText(runId, "events.jsonl");
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-200)
      .map((line) => JSON.parse(line) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function readInvocationRecords(
  store: RunStore,
  runId: string,
): Promise<InvocationRecord[]> {
  // sessions/ also holds <id>.steps.jsonl (NDJSON); only *.json are session records.
  const files = (await store.listFiles(runId, "sessions")).filter((file) => file.endsWith(".json"));
  const records = await Promise.all(
    files.map(async (file) => {
      const value = (await store.readJson(runId, file)) as Record<string, unknown>;
      return parseInvocationRecord(file, value);
    }),
  );
  return records.filter((record): record is InvocationRecord => record != null);
}

export async function readSessionSummaries(store: RunStore, runId: string): Promise<unknown[]> {
  const records = await readInvocationRecords(store, runId);
  const sessions = records.map((record) => ({
    path: record.path,
    sessionId: record.sessionId,
    role: record.role,
    model: record.model,
    status: record.status,
    attempt: record.attempt,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    providerSessionId: record.providerSessionId,
    providerSessionReused: record.providerSessionReused,
    usage: record.usage,
    handoff: record.handoff,
    error: record.error,
    taskId: record.taskId,
    phase: record.phase,
    taskStep: record.taskStep,
    invocationKind: record.invocationKind,
    trigger: record.trigger,
  }));
  return sessions.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

export async function readAgentActivity(store: RunStore, runId: string): Promise<AgentActivity> {
  return buildAgentActivity(await readInvocationRecords(store, runId));
}

export async function readSessionDetail(
  store: RunStore,
  runId: string,
  sessionPath: string,
): Promise<Record<string, unknown>> {
  const session = (await store.readJson(runId, sessionPath)) as Record<string, unknown>;
  const packetPath =
    typeof session.packet === "string" &&
    /^packets\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(session.packet)
      ? session.packet
      : undefined;
  const packet = packetPath
    ? ((await store.readJson(runId, packetPath)) as WorkPacket)
    : undefined;
  const retrievalPath = packetPath?.replace(/\.json$/, ".retrieval.json");
  const retrievalArtifact = retrievalPath
    ? await store.readJson(runId, retrievalPath).catch(() => undefined)
    : undefined;
  // New runs store `{ retrieval, budget }`; older artifacts were a flat audit.
  const retrievalRecord = isRecord(retrievalArtifact) ? retrievalArtifact : undefined;
  const retrieval = retrievalRecord && isRecord(retrievalRecord.retrieval)
    ? {
        ...retrievalRecord.retrieval,
        ...(retrievalRecord.budget != null ? { budget: retrievalRecord.budget } : {}),
      }
    : retrievalArtifact;
  const reconstructed = await submittedPrompt(store, runId, session, packet);
  const handoff = isRecord(session.handoff) ? session.handoff : undefined;
  const artifactRefs = Array.isArray(handoff?.artifactRefs)
    ? handoff.artifactRefs.filter((value): value is string => typeof value === "string")
    : [];

  const stepsPath = sessionPath.replace(/\.json$/, ".steps.jsonl");
  const steps = await readSessionSteps(store, runId, stepsPath);

  return {
    session,
    packet,
    retrieval,
    steps,
    stepsPath: steps ? stepsPath : undefined,
    inputPrompt: reconstructed.prompt,
    inputSource: reconstructed.source,
    relatedArtifacts: [
      ...new Set(
        [sessionPath, packetPath, retrievalPath, steps ? stepsPath : undefined, ...artifactRefs].filter(
          isString,
        ),
      ),
    ],
  };
}

async function readSessionSteps(
  store: RunStore,
  runId: string,
  stepsPath: string,
): Promise<unknown[] | undefined> {
  try {
    const raw = await store.readText(runId, stepsPath);
    const lines = raw
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-500)
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return { type: "invalid", summary: line.slice(0, 200) };
        }
      });
    return lines;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function submittedPrompt(
  store: RunStore,
  runId: string,
  session: Record<string, unknown>,
  packet: WorkPacket | undefined,
): Promise<{ prompt?: string; source: string }> {
  if (typeof session.prompt === "string") {
    return { prompt: session.prompt, source: "stored exact input" };
  }
  if (!packet) return { source: "unavailable: packet missing" };

  const role = String(session.role ?? "");
  const files = (await store.listFiles(runId, "sessions")).filter((file) => file.endsWith(".json"));
  const related = await Promise.all(
    files.map(async (file) => (await store.readJson(runId, file)) as Record<string, unknown>),
  );
  let prompt: string;
  let source: string;
  if (role === "prompt-builder") {
    prompt = renderPromptBuilderPrompt(packet);
    source = "reconstructed deterministic compiler input";
  } else {
    const compiler = related
      .filter(
        (candidate) =>
          candidate.invocationId === session.invocationId &&
          candidate.role === "prompt-builder" &&
          candidate.status === "completed" &&
          isRecord(candidate.output) &&
          typeof candidate.output.prompt === "string",
      )
      .sort((a, b) => Number(b.attempt ?? 0) - Number(a.attempt ?? 0))[0];
    if (compiler && isRecord(compiler.output) && typeof compiler.output.prompt === "string") {
      prompt = compiler.output.prompt;
      source = "reconstructed compiled input";
    } else {
      prompt = renderPrompt(packet);
      source = "reconstructed deterministic input";
    }
  }

  const attempt = Number(session.attempt ?? 0);
  if (attempt > 0) {
    const previous = related.find(
      (candidate) =>
        candidate.invocationId === session.invocationId &&
        candidate.role === session.role &&
        Number(candidate.attempt) === attempt - 1,
    );
    if (previous && typeof previous.error === "string") {
      prompt = [
        prompt,
        "",
        "Your previous response failed the required JSON contract.",
        `Validation error: ${previous.error.slice(0, 4_000)}`,
        "Return one corrected JSON object only.",
      ].join("\n");
      source += " with schema-repair suffix";
    }
  }
  return { prompt, source };
}

export async function listArtifacts(store: RunStore, runId: string): Promise<string[]> {
  const grouped = await Promise.all(
    ["issues", "tasks", "packets", "sessions"].map((directory) =>
      store.listFiles(runId, directory),
    ),
  );
  const fixed = [
    "idea.md",
    "brief.md",
    "grill.md",
    "unknowns.md",
    "events.jsonl",
    "state.json",
    "config.json",
    "installs.jsonl",
  ];
  const available: string[] = [];
  for (const file of fixed) {
    try {
      await store.readText(runId, file);
      available.push(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return [...available, ...grouped.flat()];
}

export function allowedArtifact(value: string): boolean {
  return (
    [
      "idea.md",
      "brief.md",
      "grill.md",
      "unknowns.md",
      "events.jsonl",
      "state.json",
      "config.json",
      "installs.jsonl",
    ].includes(value) ||
    /^(issues|tasks|packets|sessions)\/[A-Za-z0-9._-]+$/.test(value) ||
    /^sessions\/[A-Za-z0-9][A-Za-z0-9._-]*\.steps\.jsonl$/.test(value)
  );
}

export async function readInstallLog(
  store: RunStore,
  runId: string,
): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await store.readText(runId, "installs.jsonl");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return { commandSummary: line };
        }
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
