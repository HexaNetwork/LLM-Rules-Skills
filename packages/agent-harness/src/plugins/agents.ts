import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import { formatCursorAgentFailure } from "../domain/cursor-agent-error.js";
import { invokeModeFor } from "../domain/agent-roles.js";
import { readRoleAgents } from "../domain/role-agents.js";
import type { AgentInvocation, WorkPacket } from "../domain/types.js";
import { workingOn } from "../domain/working.js";
import {
  parseWorkerStdout,
  type WorkerControlEvent,
  type WorkerInvokeResult,
  type WorkerResultLine,
} from "../worker/invoke.js";

export type AgentInvokeMeta = {
  sessionId: string;
};

export type AgentsService = {
  invoke(role: string, packet: WorkPacket, meta?: AgentInvokeMeta): Promise<unknown>;
};

export type ScriptedReply = unknown | ((role: string, packet: WorkPacket) => unknown);

export type AgentsConfig = {
  mode?: "fake" | "cursor";
  scripted?: Record<string, ScriptedReply>;
};

export function defaultFakeReply(role: string, packet: WorkPacket): unknown {
  const idea = extractIdea(packet.input);
  switch (role) {
    case "reflector":
      return {
        proposedTitle: "Clarify request",
        summary: "Restate the request without adding requirements.",
        restatement: idea,
        goal: "Establish a shared understanding of the request before grilling.",
        users: ["end users of the product"],
        inScope: ["the requested outcome"],
        outOfScope: ["unrelated refactors"],
        assumptions: ["A thin vertical slice is preferred."],
        unknowns: ["Who are the users?", "What is explicitly out of scope?"],
      };
    case "griller": {
      const input = packet.input as {
        fog?: Array<{ id: string; status: string }>;
        resolutions?: unknown[];
      } | undefined;
      const fog = input?.fog ?? [];
      const open = fog.filter((entry) => entry.status === "fog" || entry.status === "asked");
      if (open.length === 0) return { questions: [], newUnknowns: [], resolvedUnknowns: [] };
      return {
        questions: [
          {
            id: "users",
            fogIds: [open[0]?.id].filter(Boolean),
            prompt: "Who are the primary users?",
            context: "This shapes who the slice must serve and how we phrase the brief.",
            options: [
              {
                id: "end-users",
                label: "End users of the product",
                description: "People who use the shipped feature.",
              },
              {
                id: "maintainers",
                label: "Maintainers of this repository",
                description: "People who develop or operate the codebase itself.",
              },
            ],
            recommendedOptionId: "end-users",
            recommendation: "Default to product end users unless the idea clearly targets maintainers.",
          },
          {
            id: "scope",
            fogIds: [open[1]?.id].filter(Boolean),
            prompt: "What is out of scope for this slice?",
            context: "Keep the first cut thin enough to verify and publish.",
            options: [
              {
                id: "refactors",
                label: "Unrelated refactors",
                description: "Skip drive-by cleanups that are not required for the slice.",
              },
              {
                id: "adjacent",
                label: "Adjacent features",
                description: "Defer nearby work that can ship in a follow-up run.",
              },
            ],
            recommendedOptionId: "refactors",
            recommendation: "Park unrelated refactors so the slice stays reviewable.",
          },
        ].filter((question) => question.fogIds.length > 0),
        newUnknowns: [],
        resolvedUnknowns: [],
      };
    }
    case "docs-writer":
      return {
        glossary: [{ term: "Run", definition: "A durable idea-to-feature execution." }],
        title: idea.slice(0, 72) || "Feature",
        body: `# PRD\n\n${idea}\n`,
      };
    case "project-profiler": {
      const slug = idea
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 32);
      return {
        command: "npm test",
        testGlobs: ["**/*.test.ts"],
        rationale: "package.json exposes a standard test script.",
        specificCommands: slug
          ? [
              {
                id: "feature-focused",
                label: "Feature-focused",
                command: `npm test -- ${slug}`,
                rationale: "Narrow the suite toward this slice when the runner supports a filter.",
              },
            ]
          : [],
      };
    }
    case "planner":
      return { plan: `1. Restate the goal.\n2. Implement the smallest change.\n3. Verify.\n\nGoal: ${idea}` };
    case "scenario-planner":
      return {
        scenarios: [
          {
            id: "happy-path",
            title: "Happy path",
            steps: ["A user starts from the idea", "The verification command exits zero"],
          },
        ],
      };
    case "issue-slicer":
      return {
        tasks: [{ id: "task-1", title: "Implement the slice", description: idea }],
      };
    case "implementer":
      return { summary: `Implemented ${idea}`, files: ["README.md"], note: "fake-agent" };
    case "task-reviewer":
    case "reviewer":
      return { verdict: "approve", summary: "Looks consistent with the packet." };
    case "scenario-writer":
    case "fixer":
      return { summary: "No repair required.", passed: true };
    case "image-fixer": {
      const input = packet.input as { dockerfile?: unknown } | undefined;
      return {
        summary: "No image repair required.",
        dockerfile: typeof input?.dockerfile === "string" ? input.dockerfile : "",
      };
    }
    case "message-writer":
      return { title: idea.slice(0, 72) || "Feature", body: idea };
    default:
      return { summary: `fake:${role}`, idea };
  }
}

export function createFakeAgents(scripted: Record<string, ScriptedReply> = {}): AgentsService {
  return {
    async invoke(role, packet) {
      const reply = scripted[role];
      if (typeof reply === "function") return reply(role, packet);
      if (reply !== undefined) return reply;
      return defaultFakeReply(role, packet);
    },
  };
}

export function createCursorAgents(ctx: Context): AgentsService {
  return {
    async invoke(role, packet, meta) {
      const run = await ctx.store.readIdentity(packet.runId);
      if (!run) throw new Error(`Cannot invoke agent for unknown run ${packet.runId}`);

      let workerResult: WorkerInvokeResult | undefined;
      const handleStdoutLine = async (line: string): Promise<void> => {
        let parsed: WorkerControlEvent | WorkerResultLine;
        try {
          parsed = JSON.parse(line) as WorkerControlEvent | WorkerResultLine;
        } catch {
          return;
        }
        if (parsed.stream === "result") {
          workerResult = parsed;
          return;
        }
        if (parsed.stream !== "control" || !meta?.sessionId) return;
        await persistAgentStreamEvent(ctx, packet, meta.sessionId, parsed);
      };

      const execution = ctx.sandbox.exec(run.runId, {
        command: ["node", "/opt/agent-harness/dist/worker/invoke.js"],
        stdin: JSON.stringify({
          role,
          packet,
          resumeAgentId: packet.resumeAgentId,
          maxAgentTokens: packet.maxAgentTokens,
          agentTimeoutMs: packet.agentTimeoutMs,
        }),
        // Give the worker a short grace period to cancel the provider run and exit.
        timeoutMs: packet.agentTimeoutMs + 10_000,
        onStdoutLine: (line) => handleStdoutLine(line),
      });
      const reconciled = meta?.sessionId
        ? await awaitWorkerOrFinalizedSession(ctx, packet, meta.sessionId, execution)
        : { result: await execution };
      if (reconciled.worker) return reconciled.worker;
      const result = reconciled.result!;

      if (result.timedOut) {
        await ctx.sandbox.destroy(run.runId);
        throw new Error(`Agent timed out (${role}) after ${packet.agentTimeoutMs}ms`);
      }
      if (result.exitCode !== 0) {
        throw new Error(formatCursorAgentFailure(role, result));
      }

      workerResult ??= parseWorkerStdout(result.stdout);
      if (!workerResult) {
        throw new Error(`Agent worker (${role}) returned no result line`);
      }
      return workerResult;
    },
  };
}

const FINALIZED_WORKER_GRACE_MS = 10_000;
const RECONCILE_POLL_MS = 1_000;

async function awaitWorkerOrFinalizedSession(
  ctx: Context,
  packet: WorkPacket,
  sessionId: string,
  execution: ReturnType<Context["sandbox"]["exec"]>,
): Promise<{ result?: Awaited<typeof execution>; worker?: WorkerInvokeResult }> {
  let executionSettled = false;
  const trackedExecution = execution.finally(() => {
    executionSettled = true;
  });
  const watchdog = (async (): Promise<WorkerInvokeResult> => {
    let finalizedAt = 0;
    while (!executionSettled) {
      await delay(RECONCILE_POLL_MS);
      const events = await ctx.store.readSessionEvents<Record<string, unknown>>(
        packet.runId,
        sessionId,
      );
      if (!finalizedAt && hasFinalizedProvider(events)) finalizedAt = Date.now();
      if (!finalizedAt || Date.now() - finalizedAt < FINALIZED_WORKER_GRACE_MS) continue;

      const recovered = recoverFinalizedWorker(events);
      if (!recovered) {
        throw new Error(
          `Finalized agent session ${sessionId} did not contain a recoverable JSON result`,
        );
      }
      await ctx.store.writeProgress(
        packet.runId,
        workingOn(`Recovering finalized ${packet.role}`, {
          phase: packet.phase,
          role: packet.role,
          status: "reconciling",
        }),
      );
      // The provider is finalized but the worker has not returned. Tear down
      // the dedicated run container to release a hung SDK disposer/stream.
      await ctx.sandbox.destroy(packet.runId).catch(() => undefined);
      return recovered;
    }
    return new Promise<WorkerInvokeResult>(() => undefined);
  })();

  const outcome = await Promise.race([
    trackedExecution.then((result) => ({ kind: "process" as const, result })),
    watchdog.then((worker) => ({ kind: "recovered" as const, worker })),
  ]);
  return outcome.kind === "recovered" ? { worker: outcome.worker } : { result: outcome.result };
}

function hasFinalizedProvider(events: Array<Record<string, unknown>>): boolean {
  return events.some(
    (event) => event.kind === "provider_status" && event.status === "finalized",
  );
}

export function recoverFinalizedWorker(events: Array<Record<string, unknown>>): WorkerInvokeResult | undefined {
  let output: unknown;
  let agentId = "reconciled";
  let providerRunId = "reconciled";
  let requestId: string | undefined;
  for (const event of events) {
    if (typeof event.agentId === "string") agentId = event.agentId;
    if (event.kind === "run_status") {
      if (typeof event.runId === "string") providerRunId = event.runId;
      if (typeof event.requestId === "string") requestId = event.requestId;
    }
    if (event.kind !== "step" || !event.step || typeof event.step !== "object") continue;
    const step = event.step as { type?: unknown; message?: { text?: unknown } };
    if (step.type !== "assistantMessage" || typeof step.message?.text !== "string") continue;
    try {
      output = JSON.parse(step.message.text);
    } catch {
      output = { text: step.message.text };
    }
  }
  if (output === undefined) return undefined;
  return {
    protocolVersion: 1,
    output,
    submittedPrompt: "[recovered from finalized session event stream]",
    telemetry: {
      provider: "cursor",
      model: "reconciled",
      agentId,
      providerRunId,
      ...(requestId ? { requestId } : {}),
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function agentsPlugin(ctx: Context, config: AgentsConfig = {}): void {
  const mode = config.mode ?? (process.env.AGENT_HARNESS_AGENTS === "cursor" ? "cursor" : "fake");
  const service = mode === "cursor" ? createCursorAgents(ctx) : createFakeAgents(config.scripted ?? {});
  ctx.provide("agents", wrapWithSessions(ctx, service, mode));
}

Object.assign(agentsPlugin, { inject: ["store", "sandbox"] });

function wrapWithSessions(
  ctx: Context,
  inner: AgentsService,
  mode: "fake" | "cursor",
): AgentsService {
  return {
    async invoke(role, packet) {
      const sessionId = randomUUID();
      const startedAt = new Date().toISOString();
      const runningInvocation: AgentInvocation = {
        sessionId,
        role,
        packet,
        startedAt,
        endedAt: startedAt,
        at: startedAt,
        status: "running",
      };
      await persistSession(ctx, packet, runningInvocation);
      const packetSummary = summarizePacket(packet);
      await ctx.store.appendEvent(packet.runId, {
        kind: "agent",
        at: startedAt,
        sessionId,
        role,
        phase: packet.phase,
        status: "running",
        packet: packetSummary,
      });

      let terminalPersisted = false;
      try {
        const result = await inner.invoke(role, packet, { sessionId });
        const worker = isWorkerInvokeResult(result) ? result : undefined;
        const output = worker ? worker.output : result;
        const endedAt = new Date().toISOString();
        const invocation: AgentInvocation = {
          sessionId,
          role,
          packet,
          ...(worker?.submittedPrompt ? { submittedPrompt: worker.submittedPrompt } : {}),
          output,
          startedAt,
          endedAt,
          at: endedAt,
          status: "completed",
          telemetry: worker?.telemetry ?? {
            provider: mode,
            model: mode === "fake" ? "fake" : packet.model,
          },
        };
        await persistSession(ctx, packet, invocation);
        await persistRoleAgentId(ctx, packet.runId, role, worker?.telemetry?.agentId, mode);
        await ctx.store.appendEvent(packet.runId, {
          kind: "agent",
          at: endedAt,
          sessionId,
          role,
          phase: packet.phase,
          status: "completed",
          packet: packetSummary,
        });
        terminalPersisted = true;
        return output;
      } catch (error) {
        const endedAt = new Date().toISOString();
        const message = error instanceof Error ? error.message : String(error);
        const invocation: AgentInvocation = {
          sessionId,
          role,
          packet,
          startedAt,
          endedAt,
          at: endedAt,
          status: "failed",
          error: message,
        };
        await persistSession(ctx, packet, invocation);
        await ctx.store.appendEvent(packet.runId, {
          kind: "agent",
          at: endedAt,
          sessionId,
          role,
          phase: packet.phase,
          status: "failed",
          packet: packetSummary,
        });
        terminalPersisted = true;
        throw error;
      } finally {
        if (!terminalPersisted) {
          const endedAt = new Date().toISOString();
          const invocation: AgentInvocation = {
            sessionId,
            role,
            packet,
            startedAt,
            endedAt,
            at: endedAt,
            status: "failed",
            error: "Agent invocation ended before terminal state could be persisted",
          };
          await persistSession(ctx, packet, invocation).catch(() => undefined);
          await ctx.store.appendEvent(packet.runId, {
            kind: "agent",
            at: endedAt,
            sessionId,
            role,
            phase: packet.phase,
            status: "failed",
            packet: packetSummary,
          }).catch(() => undefined);
        }
      }
    },
  };
}

function isWorkerInvokeResult(value: unknown): value is WorkerInvokeResult {
  if (!value || typeof value !== "object") return false;
  const row = value as { protocolVersion?: unknown; telemetry?: unknown };
  return row.protocolVersion === 1 && Boolean(row.telemetry);
}

async function persistRoleAgentId(
  ctx: Context,
  runId: string,
  role: string,
  agentId: string | undefined,
  mode: "fake" | "cursor",
): Promise<void> {
  const resolved =
    agentId && agentId !== "completion"
      ? agentId
      : mode === "fake" && invokeModeFor(role) === "agent"
        ? `fake-${role}`
        : undefined;
  if (!resolved) return;
  const state = await ctx.store.readState(runId);
  if (!state) return;
  const roleAgents = readRoleAgents(state.artifacts);
  roleAgents[role] = resolved;
  state.artifacts.roleAgents = roleAgents;
  await ctx.store.writeState(state);
}

async function persistSession(
  ctx: Context,
  packet: WorkPacket,
  invocation: AgentInvocation,
): Promise<void> {
  await ctx.store.writeSession(packet.runId, invocation.sessionId, invocation);
}

async function persistAgentStreamEvent(
  ctx: Context,
  packet: WorkPacket,
  sessionId: string,
  event: WorkerControlEvent,
): Promise<void> {
  // Stream ticks stay on the session log only. Run Activity keeps lifecycle + agent
  // start/complete (with packet summary) so the feed stays readable.
  await ctx.store.appendSessionEvent(packet.runId, sessionId, event);
  if (event.kind === "heartbeat") {
    await ctx.store.writeProgress(
      packet.runId,
      workingOn(`Invoking ${packet.role}`, {
        phase: packet.phase,
        role: packet.role,
        status: "working",
      }),
    );
  }
}

export type PacketSummary = {
  model: string;
  inputKind: string;
  inputKeys?: string[];
  inputChars: number;
  guidanceChars: number;
  retrievalChars: number;
  truncated: string[];
  maxAgentTokens?: number;
  agentTimeoutMs: number;
};

/** Compact packet fingerprint for run Activity — full packet lives on the session. */
export function summarizePacket(packet: WorkPacket): PacketSummary {
  const inputJson = JSON.stringify(packet.input ?? null);
  const summary: PacketSummary = {
    model: packet.model,
    inputKind: Array.isArray(packet.input)
      ? "array"
      : packet.input === null
        ? "null"
        : typeof packet.input,
    inputChars: inputJson.length,
    guidanceChars: packet.guidance.length,
    retrievalChars: packet.retrieval.length,
    truncated: [...packet.budget.truncated],
    agentTimeoutMs: packet.agentTimeoutMs,
  };
  if (packet.maxAgentTokens != null) summary.maxAgentTokens = packet.maxAgentTokens;
  if (packet.input && typeof packet.input === "object" && !Array.isArray(packet.input)) {
    summary.inputKeys = Object.keys(packet.input as Record<string, unknown>).slice(0, 24);
  }
  return summary;
}

function extractIdea(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object" && "idea" in input) {
    const idea = (input as { idea?: unknown }).idea;
    if (typeof idea === "string") return idea;
  }
  return JSON.stringify(input ?? "");
}
