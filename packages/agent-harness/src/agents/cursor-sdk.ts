import { z } from "zod";
import {
  VerifierReportSchema,
  WorkerReportSchema,
  type Finding,
  type VerifierReport,
  type WorkerReport,
} from "../schemas/reports.js";
import type { AgentLaunchResult, AgentPort } from "./ports.js";
import type { ManifestTask, RunManifest } from "../schemas/manifest.js";
import { CONTRACT_VERSION } from "../schemas/common.js";
import { formatDurationMs, harnessLog } from "../util/log.js";
import { worktreeFingerprint } from "../util/git.js";

const AGENT_WAIT_HEARTBEAT_MS = 30_000;
export const DEFAULT_WORKER_NO_CODE_MS = 5 * 60 * 1000;
export const DEFAULT_WORKER_MAX_RUN_MS = 30 * 60 * 1000;

export class WorkerStuckNoCodeError extends Error {
  readonly code = "WORKER_STUCK_NO_CODE";
  readonly isRetryable = true;

  constructor(noCodeMs: number) {
    super(
      `Worker stuck: no worktree progress for ${formatDurationMs(noCodeMs)} (watchdog stays armed until testing gates)`,
    );
    this.name = "WorkerStuckNoCodeError";
  }
}

export class WorkerRunTimeoutError extends Error {
  readonly code = "WORKER_RUN_TIMEOUT";
  readonly isRetryable = true;

  constructor(maxRunMs: number) {
    super(`Worker timed out after ${formatDurationMs(maxRunMs)}`);
    this.name = "WorkerRunTimeoutError";
  }
}

export type CursorAgentPortOptions = {
  /** Cancel worker if no code after this many ms. 0 disables. Default 5 minutes. */
  workerNoCodeMs?: number;
  /** Cancel worker after this wall-clock duration. 0 disables. Default 30 minutes. */
  workerMaxRunMs?: number;
};

type SdkRun = {
  id: string;
  wait: () => Promise<{
    status: string;
    result?: string;
    usage?: { inputTokens?: number; outputTokens?: number };
  }>;
  cancel?: () => Promise<void>;
  supports?: (operation: string) => boolean;
};

type SdkAgent = {
  agentId: string;
  send: (prompt: string) => Promise<SdkRun>;
  [Symbol.asyncDispose]?: () => Promise<void>;
};

type SdkModule = {
  Agent: {
    create: (options: Record<string, unknown>) => Promise<SdkAgent>;
    resume: (
      agentId: string,
      options: Record<string, unknown>,
    ) => Promise<SdkAgent>;
  };
  CursorAgentError: new (...args: unknown[]) => Error & { isRetryable?: boolean };
};

async function loadSdk(): Promise<SdkModule> {
  return (await import("@cursor/sdk")) as unknown as SdkModule;
}

function extractJsonBlock(text: string): Record<string, unknown> {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("Agent response did not contain JSON object");
  }
  const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Agent JSON must be an object");
  }
  return parsed as Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withSdkRetry<T>(
  attempts: number,
  fn: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const retryable =
        error instanceof Error &&
        ("isRetryable" in error
          ? Boolean((error as { isRetryable?: boolean }).isRetryable)
          : /network|timeout|429|5\d\d|stuck/i.test(error.message));
      if (!retryable || i === attempts - 1) throw error;
      harnessLog("agent.retry", `retrying after ${error.message}`, {
        attempt: i + 2,
        of: attempts,
      });
      await sleep(500 * 2 ** i);
    }
  }
  throw lastError;
}

async function cancelRun(run: SdkRun): Promise<void> {
  try {
    if (typeof run.supports === "function" && !run.supports("cancel")) {
      harnessLog("agent.cancel", "cancel unsupported; disposing agent only", {
        runId: run.id,
      });
      return;
    }
    if (typeof run.cancel === "function") {
      harnessLog("agent.cancel", "cancelling stuck run", { runId: run.id });
      await run.cancel();
    }
  } catch (error) {
    harnessLog("agent.cancel", "cancel failed", {
      runId: run.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Wait for a run with heartbeats. For workers, keep a stagnation watchdog
 * armed until the run finishes (orchestrator then hits command/testing gates):
 * if the worktree fingerprint is unchanged for `requireCodeAfterMs`, cancel.
 */
export async function waitWithHeartbeat(
  run: SdkRun,
  label: string,
  options?: {
    cwd?: string;
    requireCodeAfterMs?: number;
    maxRunMs?: number;
  },
): Promise<{
  status: string;
  result?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}> {
  const started = Date.now();
  const requireCodeAfterMs = options?.requireCodeAfterMs;
  const maxRunMs = options?.maxRunMs;
  const watchCode =
    typeof requireCodeAfterMs === "number" &&
    requireCodeAfterMs > 0 &&
    Boolean(options?.cwd);
  const watchRuntime = typeof maxRunMs === "number" && maxRunMs > 0;

  let lastFingerprint = watchCode
    ? await worktreeFingerprint(options!.cwd!)
    : null;
  let lastProgressAt = started;

  if (watchCode) {
    harnessLog("agent.watchdog", "worktree-progress fail-safe armed until gates", {
      label,
      idleAfter: formatDurationMs(requireCodeAfterMs!),
    });
  }
  if (watchRuntime) {
    harnessLog("agent.watchdog", "absolute worker timeout armed", {
      label,
      maxRun: formatDurationMs(maxRunMs!),
    });
  }

  type Settled =
    | {
        ok: true;
        result: {
          status: string;
          result?: string;
          usage?: { inputTokens?: number; outputTokens?: number };
        };
      }
    | { ok: false; error: unknown };

  let settled: Settled | undefined;
  const waitPromise = run.wait().then(
    (result) => {
      settled = { ok: true, result };
    },
    (error: unknown) => {
      settled = { ok: false, error };
    },
  );

  while (!settled) {
    const idleMs = Date.now() - lastProgressAt;
    let sleepMs = AGENT_WAIT_HEARTBEAT_MS;
    if (watchCode) {
      const untilCheck = requireCodeAfterMs! - idleMs;
      if (untilCheck <= 0) {
        sleepMs = 0;
      } else {
        sleepMs = Math.min(AGENT_WAIT_HEARTBEAT_MS, untilCheck);
      }
    }
    if (watchRuntime) {
      const untilTimeout = maxRunMs! - (Date.now() - started);
      sleepMs = Math.min(sleepMs, Math.max(0, untilTimeout));
    }
    if (sleepMs > 0) {
      await Promise.race([waitPromise, sleep(sleepMs)]);
    } else {
      // Threshold already elapsed — yield once so wait() can win the race.
      await Promise.race([waitPromise, sleep(0)]);
    }
    if (settled) break;

    const elapsed = Date.now() - started;
    const idle = Date.now() - lastProgressAt;
    harnessLog("agent.wait", `${label} still running`, {
      runId: run.id,
      elapsed: formatDurationMs(elapsed),
      idle: formatDurationMs(idle),
    });

    if (watchRuntime && elapsed >= maxRunMs!) {
      harnessLog("agent.stuck", "absolute worker timeout reached", {
        runId: run.id,
        elapsed: formatDurationMs(elapsed),
        threshold: formatDurationMs(maxRunMs!),
      });
      await cancelRun(run);
      throw new WorkerRunTimeoutError(maxRunMs!);
    }

    if (!watchCode) continue;

    const current = await worktreeFingerprint(options!.cwd!);
    if (current !== lastFingerprint) {
      lastFingerprint = current;
      lastProgressAt = Date.now();
      harnessLog("agent.code", "worktree progress; watchdog stays armed until gates", {
        runId: run.id,
        elapsed: formatDurationMs(elapsed),
      });
      continue;
    }

    if (idle >= requireCodeAfterMs!) {
      harnessLog("agent.stuck", "no worktree progress; aborting worker", {
        runId: run.id,
        elapsed: formatDurationMs(elapsed),
        idle: formatDurationMs(idle),
        threshold: formatDurationMs(requireCodeAfterMs!),
      });
      await cancelRun(run);
      throw new WorkerStuckNoCodeError(requireCodeAfterMs!);
    }
  }

  if (!settled!.ok) throw settled!.error;
  return settled!.result;
}

async function launchPrompt(input: {
  role: string;
  model: string;
  cwd: string;
  prompt: string;
  resumeAgentId?: string;
  apiKey?: string;
  workerNoCodeMs?: number;
  workerMaxRunMs?: number;
}): Promise<AgentLaunchResult> {
  const sdk = await loadSdk();
  const apiKey = input.apiKey ?? process.env.CURSOR_API_KEY;
  if (!apiKey) {
    throw new Error("CURSOR_API_KEY is required for Cursor SDK agents");
  }

  const label = `${input.role}/${input.model}`;
  const requireCodeAfterMs =
    input.role === "worker" ? (input.workerNoCodeMs ?? DEFAULT_WORKER_NO_CODE_MS) : 0;
  const maxRunMs =
    input.role === "worker" ? (input.workerMaxRunMs ?? DEFAULT_WORKER_MAX_RUN_MS) : 0;

  return withSdkRetry(3, async () => {
    const createStarted = Date.now();
    harnessLog(
      input.resumeAgentId ? "agent.resume" : "agent.create",
      `starting ${label}`,
      {
        cwd: input.cwd,
        resumeAgentId: input.resumeAgentId,
      },
    );

    const agent = input.resumeAgentId
      ? await sdk.Agent.resume(input.resumeAgentId, {
          apiKey,
          model: { id: input.model },
          local: { cwd: input.cwd },
        })
      : await sdk.Agent.create({
          apiKey,
          model: { id: input.model },
          local: { cwd: input.cwd },
        });

    harnessLog("agent.ready", `${label} ready`, {
      agentId: agent.agentId,
      elapsed: formatDurationMs(Date.now() - createStarted),
    });

    try {
      const run = await agent.send(input.prompt);
      harnessLog("agent.send", `${label} prompt sent; waiting for result`, {
        agentId: agent.agentId,
        runId: run.id,
      });
      const waitStarted = Date.now();
      const result = await waitWithHeartbeat(run, label, {
        cwd: input.cwd,
        requireCodeAfterMs,
        maxRunMs,
      });
      harnessLog("agent.done", `${label} finished`, {
        agentId: agent.agentId,
        runId: run.id,
        status: result.status,
        elapsed: formatDurationMs(Date.now() - waitStarted),
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens,
      });
      if (result.status === "error") {
        throw new Error(`Cursor agent run failed: ${run.id}`);
      }
      return {
        agentId: agent.agentId,
        runId: run.id,
        text: result.result ?? "",
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens,
      };
    } finally {
      const dispose = agent[Symbol.asyncDispose];
      if (dispose) {
        await dispose.call(agent);
      }
    }
  });
}

function workerPrompt(
  task: ManifestTask,
  manifest: RunManifest,
  repairContext?: string,
): string {
  return [
    "You are an Agent Harness Worker.",
    "Implement ONLY the current AFK task. Do not commit.",
    "Prefer test-first vertical slices. Outcomes are gated by the harness.",
    "Run only targeted tests needed while implementing. Do not run the manifest command gates; the harness runs them after you return.",
    "Return a single JSON object matching WorkerReport (no prose outside JSON).",
    "",
    `Task ID: ${task.id}`,
    `Title: ${task.title}`,
    `Body:\n${task.body}`,
    `Acceptance criteria:\n${task.acceptanceCriteria
      .map((c) => `- ${c.id}: ${c.text}`)
      .join("\n")}`,
    `Allowed globs: ${task.allowedGlobs.join(", ")}`,
    `Test seams: ${task.testSeams.join(", ") || "(none declared)"}`,
    `Implementation notes: ${task.implementationNotes ?? "(none)"}`,
    `Manifest hash: ${manifest.manifestHash}`,
    repairContext ? `Repair context:\n${repairContext}` : "",
    "",
    "WorkerReport shape:",
    JSON.stringify(
      {
        contractVersion: CONTRACT_VERSION,
        taskId: task.id,
        summary: "string",
        changedPaths: ["relative/path"],
        testsAddedOrUpdated: ["tests/..."],
        unresolvedRisks: [],
      },
      null,
      2,
    ),
  ]
    .filter(Boolean)
    .join("\n");
}

function verifierPrompt(input: {
  task: ManifestTask;
  changedPaths: string[];
  repairFocus?: Finding[];
}): string {
  return [
    "You are an Agent Harness Verifier.",
    "Independently verify acceptance, correctness, and standards.",
    "Use severity BLOCKING only for demonstrable requirement/rule failures.",
    "Use ADVISORY for improvements that must not block.",
    "Return one JSON VerifierReport only.",
    "",
    `Task ID: ${input.task.id}`,
    `Acceptance criteria:\n${input.task.acceptanceCriteria
      .map((c) => `- ${c.id}: ${c.text}`)
      .join("\n")}`,
    `Changed paths:\n${input.changedPaths.map((p) => `- ${p}`).join("\n")}`,
    input.repairFocus?.length
      ? `Focus on whether these prior findings are resolved:\n${JSON.stringify(input.repairFocus, null, 2)}`
      : "",
    "",
    "VerifierReport must include acceptance[] covering every criterion id.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function createCursorAgentPort(
  options: CursorAgentPortOptions = {},
): AgentPort {
  const workerNoCodeMs = options.workerNoCodeMs ?? DEFAULT_WORKER_NO_CODE_MS;
  const workerMaxRunMs = options.workerMaxRunMs ?? DEFAULT_WORKER_MAX_RUN_MS;
  return {
    async runWorker(input) {
      const launch = await launchPrompt({
        role: "worker",
        model: input.model,
        cwd: input.cwd,
        resumeAgentId: input.resumeAgentId,
        workerNoCodeMs,
        workerMaxRunMs,
        prompt: workerPrompt(input.task, input.manifest, input.repairContext),
      });
      const parsed = WorkerReportSchema.parse({
        ...extractJsonBlock(launch.text),
        agentId: launch.agentId,
        runId: launch.runId,
      });
      return { launch, report: parsed };
    },

    async runVerifier(input) {
      const launch = await launchPrompt({
        role: "verifier",
        model: input.model,
        cwd: input.cwd,
        resumeAgentId: input.resumeAgentId,
        prompt: verifierPrompt(input),
      });
      const parsed = VerifierReportSchema.parse({
        ...extractJsonBlock(launch.text),
        agentId: launch.agentId,
        runId: launch.runId,
      });
      return { launch, report: parsed };
    },

    async runAdversarial(input) {
      const launch = await launchPrompt({
        role: "adversarial",
        model: input.model,
        cwd: input.cwd,
        resumeAgentId: input.resumeAgentId,
        prompt: [
          "You are an Agent Harness branch-level adversarial verifier.",
          "Hunt real bugs in the branch delta only.",
          "Return VerifierReport JSON with taskId='__branch__'.",
          `Base ref: ${input.baseRef}`,
          `Changed paths:\n${input.changedPaths.map((p) => `- ${p}`).join("\n")}`,
          input.repairFocus?.length
            ? `Focus on prior findings:\n${JSON.stringify(input.repairFocus, null, 2)}`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      });
      const parsed = VerifierReportSchema.parse({
        ...extractJsonBlock(launch.text),
        taskId: "__branch__",
        agentId: launch.agentId,
        runId: launch.runId,
      });
      return { launch, report: parsed };
    },

    async runPrepareResearch(input) {
      const launch = await launchPrompt({
        role: "prepare",
        model: input.model,
        cwd: input.cwd,
        prompt: [
          "You are an Agent Harness prepare researcher.",
          "Enrich tasks with allowed paths, test seams, and optional browser probes.",
          "Do NOT add, reinterpret, or weaken product acceptance criteria.",
          "Return JSON: { enrichment: [{ taskId, allowedGlobs?, testSeams?, browserProbes?, implementationNotes? }] }",
          JSON.stringify(
            input.draftTasks.map((task) => ({
              id: task.id,
              title: task.title,
              acceptanceCriteria: task.acceptanceCriteria,
            })),
            null,
            2,
          ),
        ].join("\n"),
      });
      const EnrichmentSchema = z.object({
        enrichment: z.array(
          z.object({
            taskId: z.string(),
            allowedGlobs: z.array(z.string()).optional(),
            testSeams: z.array(z.string()).optional(),
            browserProbes: z
              .array(
                z.object({
                  id: z.string(),
                  description: z.string(),
                  urlPath: z.string().optional(),
                  steps: z.array(z.string()).min(1),
                }),
              )
              .optional(),
            implementationNotes: z.string().optional(),
          }),
        ),
      });
      const parsed = EnrichmentSchema.parse(extractJsonBlock(launch.text));
      return { launch, enrichment: parsed.enrichment };
    },
  };
}

export function createFakeAgentPort(handlers?: Partial<AgentPort>): AgentPort {
  const defaultWorker = async (input: {
    task: ManifestTask;
  }): Promise<{ launch: AgentLaunchResult; report: WorkerReport }> => ({
    launch: {
      agentId: `worker-${input.task.id}`,
      runId: `run-worker-${input.task.id}`,
      text: "{}",
    },
    report: {
      contractVersion: "1",
      taskId: input.task.id,
      summary: `Implemented ${input.task.id}`,
      changedPaths: [`src/${input.task.id}.ts`],
      testsAddedOrUpdated: [`tests/${input.task.id}.test.ts`],
      unresolvedRisks: [],
      agentId: `worker-${input.task.id}`,
      runId: `run-worker-${input.task.id}`,
    },
  });

  const defaultVerifier = async (input: {
    task: ManifestTask;
  }): Promise<{ launch: AgentLaunchResult; report: VerifierReport }> => ({
    launch: {
      agentId: `verifier-${input.task.id}`,
      runId: `run-verifier-${input.task.id}`,
      text: "{}",
    },
    report: {
      contractVersion: "1",
      taskId: input.task.id,
      acceptance: input.task.acceptanceCriteria.map((criterion) => ({
        criterionId: criterion.id,
        satisfied: true,
        evidence: `Satisfied ${criterion.id}`,
      })),
      findings: [],
      browserProbeResults: [],
      agentId: `verifier-${input.task.id}`,
      runId: `run-verifier-${input.task.id}`,
    },
  });

  return {
    runWorker: handlers?.runWorker ?? defaultWorker,
    runVerifier:
      handlers?.runVerifier ??
      (async (input) => defaultVerifier({ task: input.task })),
    runAdversarial:
      handlers?.runAdversarial ??
      (async () => ({
        launch: {
          agentId: "adversarial-1",
          runId: "run-adversarial-1",
          text: "{}",
        },
        report: {
          contractVersion: "1",
          taskId: "__branch__",
          acceptance: [],
          findings: [],
          browserProbeResults: [],
          agentId: "adversarial-1",
          runId: "run-adversarial-1",
        },
      })),
    runPrepareResearch:
      handlers?.runPrepareResearch ??
      (async (input) => ({
        launch: {
          agentId: "prepare-1",
          runId: "run-prepare-1",
          text: "{}",
        },
        enrichment: input.draftTasks.map((task) => ({
          taskId: task.id,
          allowedGlobs: task.allowedGlobs,
          testSeams: task.testSeams,
          browserProbes: task.browserProbes,
          implementationNotes: task.implementationNotes,
        })),
      })),
  };
}
