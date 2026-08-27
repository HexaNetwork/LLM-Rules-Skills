import type { AgentTurnRequest, AgentTurnResult } from "./types.js";
import type { ContainerRuntime } from "./container-runtime.js";

export const WORKER_PROTOCOL_VERSION = 1;

export function formatWorkerFailure(raw: string): string {
  const configIndex = raw.indexOf("ConfigurationError:");
  const focused = configIndex >= 0 ? raw.slice(configIndex) : raw.replace(/\([^)]*\)\s*ExperimentalWarning:[^\n]*/g, "").trim();
  const configMatch = focused.match(/ConfigurationError:\s*(.+?)(?:\s+at\s|$)/s);
  const message = configMatch?.[1]?.trim()
    ?? focused.split("\n").find((line) => line.trim() && !line.trimStart().startsWith("at "))?.trim()
    ?? "Agent worker failed";
  if (/require an explicit [`']model[`']/i.test(message)) {
    return `${message} Rebuild the runner image from Runtime setup in the WebUI so the container worker matches the installed harness.`;
  }
  return message;
}

export function parseWorkerEnvelope(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Agent worker returned empty output");
  try {
    return JSON.parse(trimmed);
  } catch {
    const marker = '{"protocolVersion"';
    const start = trimmed.lastIndexOf(marker);
    if (start >= 0) return JSON.parse(trimmed.slice(start));
    throw new Error(formatWorkerFailure(raw));
  }
}

export interface AgentDriver { invoke(request: AgentTurnRequest, context: { runId: string; workspace: string; containerName?: string; deadlineMs: number; model?: string; projectId?: string }): Promise<AgentTurnResult>; }

export class AgentRuntime implements AgentDriver {
  constructor(private readonly containers: ContainerRuntime) {}
  async invoke(request: AgentTurnRequest, context: { runId: string; workspace: string; containerName?: string; deadlineMs: number; model?: string; projectId?: string }): Promise<AgentTurnResult> {
    if (!process.env.CURSOR_API_KEY) throw new Error("CURSOR_API_KEY is required; live execution has no alternate provider");
    const model = context.model?.trim();
    if (!model) throw new Error("Agent model is required. Set models.default in Harness settings or AGENT_HARNESS_MODEL.");
    const payload = JSON.stringify({ protocolVersion: WORKER_PROTOCOL_VERSION, request, model });
    const result = context.containerName
      ? await this.containers.exec(context.containerName, "node /opt/harness/worker.js", context.deadlineMs, payload, model)
      : await this.containers.invokeInRunner(context.runId, context.workspace, payload, context.deadlineMs, model);
    let parsed: unknown;
    try {
      parsed = parseWorkerEnvelope(result.stdout);
    } catch (error) {
      if (result.timedOut) throw new AgentDeadlineError(`Agent turn ${request.turnId} exceeded its coordinator deadline`);
      throw error instanceof Error ? error : new Error(formatWorkerFailure(result.stderr || result.stdout));
    }
    if (!parsed || typeof parsed !== "object" || (parsed as { protocolVersion?: unknown }).protocolVersion !== WORKER_PROTOCOL_VERSION) {
      throw new Error("Agent worker protocol version mismatch. Rebuild the runner image from Runtime setup in the WebUI.");
    }
    const workerError = (parsed as { error?: { message?: string } }).error;
    if (workerError) throw new Error(formatWorkerFailure(workerError.message ?? "Agent worker failed"));
    const envelope = (parsed as { result: AgentTurnResult }).result;
    if (!envelope || envelope.turnId !== request.turnId || typeof envelope.sessionId !== "string") throw new Error("Agent worker returned an invalid result envelope");
    return envelope;
  }
}

export class AgentDeadlineError extends Error {}
