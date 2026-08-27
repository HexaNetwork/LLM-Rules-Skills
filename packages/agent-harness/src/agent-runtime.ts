import type { AgentTurnRequest, AgentTurnResult } from "./types.js";
import type { ContainerRuntime } from "./container-runtime.js";

export function formatWorkerFailure(raw: string): string {
  const configIndex = raw.indexOf("ConfigurationError:");
  const focused = configIndex >= 0 ? raw.slice(configIndex) : raw.replace(/\([^)]*\)\s*ExperimentalWarning:[^\n]*/g, "").trim();
  const configMatch = focused.match(/ConfigurationError:\s*(.+?)(?:\s+at\s|$)/s);
  if (configMatch?.[1]) return configMatch[1].trim();
  const messageLine = focused.split("\n").find((line) => line.trim() && !line.trimStart().startsWith("at "));
  return messageLine?.trim() || "Agent worker failed";
}

export interface AgentDriver { invoke(request: AgentTurnRequest, context: { runId: string; workspace: string; containerName?: string; deadlineMs: number; model?: string }): Promise<AgentTurnResult>; }

export class AgentRuntime implements AgentDriver {
  constructor(private readonly containers: ContainerRuntime) {}
  async invoke(request: AgentTurnRequest, context: { runId: string; workspace: string; containerName?: string; deadlineMs: number; model?: string }): Promise<AgentTurnResult> {
    if (!process.env.CURSOR_API_KEY) throw new Error("CURSOR_API_KEY is required; live execution has no alternate provider");
    const payload = JSON.stringify({ protocolVersion: 1, request, model: context.model });
    const result = context.containerName
      ? await this.containers.exec(context.containerName, "node /opt/harness/worker.js", context.deadlineMs, payload)
      : await this.containers.invokeInRunner(context.runId, context.workspace, payload, context.deadlineMs);
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout.trim()); }
    catch {
      if (result.timedOut) throw new AgentDeadlineError(`Agent turn ${request.turnId} exceeded its coordinator deadline`);
      throw new Error(formatWorkerFailure(result.stderr || result.stdout));
    }
    if (!parsed || typeof parsed !== "object" || (parsed as { protocolVersion?: unknown }).protocolVersion !== 1) throw new Error("Agent worker protocol version mismatch");
    const workerError = (parsed as { error?: { message?: string } }).error;
    if (workerError) throw new Error(workerError.message ?? "Agent worker failed");
    const envelope = (parsed as { result: AgentTurnResult }).result;
    if (!envelope || envelope.turnId !== request.turnId || typeof envelope.sessionId !== "string") throw new Error("Agent worker returned an invalid result envelope");
    // A canonical result wins over exit/disposal status. The worker writes this
    // envelope before cleanup, so cleanup failure cannot discard provider work.
    return envelope;
  }
}

export class AgentDeadlineError extends Error {}
