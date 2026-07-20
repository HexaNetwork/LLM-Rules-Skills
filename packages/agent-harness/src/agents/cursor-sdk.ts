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
import type { ProjectConfig } from "../schemas/config.js";
import { CONTRACT_VERSION } from "../schemas/common.js";

type SdkAgent = {
  agentId: string;
  send: (prompt: string) => Promise<{
    id: string;
    wait: () => Promise<{
      status: string;
      result?: string;
      usage?: { inputTokens?: number; outputTokens?: number };
    }>;
  }>;
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
          : /network|timeout|429|5\d\d/i.test(error.message));
      if (!retryable || i === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** i));
    }
  }
  throw lastError;
}

async function launchPrompt(input: {
  model: string;
  cwd: string;
  prompt: string;
  resumeAgentId?: string;
  apiKey?: string;
}): Promise<AgentLaunchResult> {
  const sdk = await loadSdk();
  const apiKey = input.apiKey ?? process.env.CURSOR_API_KEY;
  if (!apiKey) {
    throw new Error("CURSOR_API_KEY is required for Cursor SDK agents");
  }

  return withSdkRetry(3, async () => {
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

    try {
      const run = await agent.send(input.prompt);
      const result = await run.wait();
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

export function createCursorAgentPort(): AgentPort {
  return {
    async runWorker(input) {
      const launch = await launchPrompt({
        model: input.model,
        cwd: input.cwd,
        resumeAgentId: input.resumeAgentId,
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
