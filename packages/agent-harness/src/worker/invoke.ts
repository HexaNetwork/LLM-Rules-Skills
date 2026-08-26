import {
  Agent,
  type AgentUsage,
  type InteractionUpdate,
  type Run,
  type RunResult,
  type SDKMessage,
  type TokenUsage,
  type UsageCost,
} from "@cursor/sdk";
import { invokeModeFor, roleRulesFor } from "../domain/agent-roles.js";
import { formatInvokeError } from "../domain/cursor-agent-error.js";
import { REFLECT_EXPECTED_OUTPUT } from "../domain/reflect.js";

type InvokeRequest = {
  role: string;
  packet: {
    role: string;
    model?: string;
    input: unknown;
    guidance?: string;
    retrieval?: string;
  };
  maxAgentTokens?: number;
  agentTimeoutMs?: number;
};

export type WorkerControlEvent = {
  stream: "control";
  at: string;
  kind: string;
  [key: string]: unknown;
};

export type WorkerResultLine = WorkerInvokeResult & { stream: "result" };

export type WorkerStreamLine = WorkerControlEvent | WorkerResultLine;

export function buildCursorInvokePrompt(request: InvokeRequest): string {
  const roleRules = roleRulesFor(request.role).map((rule) => `- ${rule}`);
  return [
    `Role: ${request.role}`,
    ...roleRules,
    request.packet.guidance ? `Guidance:\n${request.packet.guidance}` : "",
    request.packet.retrieval ? `Retrieval:\n${request.packet.retrieval}` : "",
    `Input:\n${JSON.stringify(request.packet.input, null, 2)}`,
    request.role === "reflector" ? `Expected output: ${REFLECT_EXPECTED_OUTPUT}` : "",
    "Return a single JSON object. No markdown.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export type WorkerInvokeResult = {
  protocolVersion: 1;
  output: unknown;
  submittedPrompt: string;
  telemetry: {
    provider: "cursor";
    model: string;
    agentId: string;
    providerRunId: string;
    requestId?: string;
    usage?: TokenUsage;
    reportedUsage?: TokenUsage;
    billedUsage?: TokenUsage;
    usageSource?: "reported" | "billed";
    cost?: UsageCost;
    tokenCapExceeded?: boolean;
  };
};

type ControlEmitter = (event: WorkerControlEvent) => void;

const USAGE_LOOKUP_TIMEOUT_MS = 5_000;
const USAGE_RETRY_INTERVAL_MS = 500;
const USAGE_RECONCILE_WINDOW_MS = 4_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_SHELL_OUTPUT_CHARS = 8_000;

export async function invokeCursorAgent(
  request: InvokeRequest,
  emitControl?: ControlEmitter,
): Promise<WorkerInvokeResult> {
  const prompt = buildCursorInvokePrompt(request);
  const requestedModel = resolveModel(request.packet.model);
  const mode = invokeModeFor(request.role);
  const emit = emitControl ?? (() => undefined);

  if (mode === "completion") {
    return invokeCompletion(prompt, request, requestedModel, emit);
  }
  return invokeAgentSession(prompt, request, requestedModel, emit);
}

async function invokeAgentSession(
  prompt: string,
  request: InvokeRequest,
  requestedModel: string,
  emit: ControlEmitter,
): Promise<WorkerInvokeResult> {
  emitControl(emit, "provider_status", { status: "creating_agent" });
  await using agent = await Agent.create({
    apiKey: process.env.CURSOR_API_KEY,
    model: { id: requestedModel },
    local: { cwd: "/workspace" },
  });
  emitControl(emit, "provider_status", { status: "agent_created", agentId: agent.agentId });

  const run = await agent.send(prompt, {
    onStep: ({ step }) => emitControl(emit, "step", { step }),
    onDelta: ({ update }) => {
      emitControl(emit, "delta", { update });
      emitDeltaToolEvents(emit, update);
    },
  });
  emitControl(emit, "run_status", { status: "sent", runId: run.id, requestId: run.requestId });

  const statusUnsub = run.onDidChangeStatus((status) => emitControl(emit, "run_status", { status }));
  const heartbeat = setInterval(() => emitControl(emit, "heartbeat"), HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  const streamTask = consumeRunStream(run, emit);
  const result = await withAgentTimeout(
    run.wait(),
    request.agentTimeoutMs,
    () => run.cancel(),
    request.role,
  );
  clearInterval(heartbeat);
  statusUnsub();
  await streamTask.catch(() => undefined);

  if (result.status === "error") {
    emitControl(emit, "run_status", {
      status: "error",
      message: result.error?.message,
      code: result.error?.code,
    });
  } else {
    emitControl(emit, "run_status", { status: result.status });
  }

  const text = extractText(result);
  let output: unknown;
  try {
    output = JSON.parse(text);
  } catch {
    output = { text };
  }

  const reportedUsage = result.usage ?? run.usage;
  const billed = await withAgentTimeout(
    readReconciledUsage(agent, reportedUsage),
    USAGE_LOOKUP_TIMEOUT_MS,
    undefined,
    "usage",
  ).catch(() => undefined);
  const selected = selectUsageTelemetry(reportedUsage, billed?.usage);
  const usage = selected.usage;
  const tokenCapExceeded = checkTokenCap(request.role, usage, request.maxAgentTokens);
  emitControl(emit, "provider_status", { status: "finalized" });

  return {
    protocolVersion: 1,
    output,
    submittedPrompt: prompt,
    telemetry: {
      provider: "cursor",
      model: result.model?.id ?? run.model?.id ?? requestedModel,
      agentId: agent.agentId,
      providerRunId: run.id,
      ...(run.requestId ? { requestId: run.requestId } : {}),
      ...(usage ? { usage } : {}),
      ...(reportedUsage ? { reportedUsage } : {}),
      ...(billed?.usage ? { billedUsage: billed.usage } : {}),
      ...(selected.source ? { usageSource: selected.source } : {}),
      ...(billed?.cost ? { cost: billed.cost } : {}),
      ...(tokenCapExceeded ? { tokenCapExceeded: true } : {}),
    },
  };
}

async function invokeCompletion(
  prompt: string,
  request: InvokeRequest,
  requestedModel: string,
  emit: ControlEmitter,
): Promise<WorkerInvokeResult> {
  emitControl(emit, "provider_status", { status: "completion_start" });
  const run = await withAgentTimeout(
    Agent.prompt(prompt, {
      apiKey: process.env.CURSOR_API_KEY,
      model: { id: requestedModel },
    }),
    request.agentTimeoutMs,
    undefined,
    request.role,
  );
  emitControl(emit, "run_status", { status: run.status, runId: run.id, requestId: run.requestId });
  const text = extractText(run);
  let output: unknown;
  try {
    output = JSON.parse(text);
  } catch {
    output = { text };
  }
  const usage = run.usage;
  const tokenCapExceeded = checkTokenCap(request.role, usage, request.maxAgentTokens);
  emitControl(emit, "provider_status", { status: "finalized" });
  return {
    protocolVersion: 1,
    output,
    submittedPrompt: prompt,
    telemetry: {
      provider: "cursor",
      model: run.model?.id ?? requestedModel,
      agentId: "completion",
      providerRunId: run.id ?? "completion",
      ...(run.requestId ? { requestId: run.requestId } : {}),
      ...(usage ? { usage } : {}),
      ...(tokenCapExceeded ? { tokenCapExceeded: true } : {}),
    },
  };
}

function emitControl(emit: ControlEmitter, kind: string, payload: Record<string, unknown> = {}): void {
  emit({ stream: "control", at: new Date().toISOString(), kind, ...payload });
}

function emitDeltaToolEvents(emit: ControlEmitter, update: InteractionUpdate): void {
  switch (update.type) {
    case "tool-call-started":
      emitControl(emit, "tool_start", {
        callId: update.callId,
        toolCall: update.toolCall,
      });
      if (update.toolCall.type === "shell") {
        emitControl(emit, "shell_start", {
          callId: update.callId,
          command: update.toolCall.args.command,
          workingDirectory: update.toolCall.args.workingDirectory,
        });
      }
      return;
    case "tool-call-completed":
      emitControl(emit, "tool_finish", {
        callId: update.callId,
        toolCall: update.toolCall,
      });
      if (update.toolCall.type === "shell") {
        const shellResult = update.toolCall.result;
        if (!shellResult) break;
        if (shellResult.status === "success") {
          emitControl(emit, "shell_finish", {
            callId: update.callId,
            status: shellResult.status,
            exitCode: shellResult.value.exitCode,
            stdout: truncateShellText(shellResult.value.stdout),
            stderr: truncateShellText(shellResult.value.stderr),
            executionTime: shellResult.value.executionTime,
          });
        } else {
          emitControl(emit, "shell_finish", {
            callId: update.callId,
            status: shellResult.status,
            error: shellResult.error,
          });
        }
      }
      return;
    case "shell-output-delta":
      emitControl(emit, "shell_output", {
        event: update.event,
      });
      return;
    default:
      return;
  }
}

async function consumeRunStream(run: Run, emit: ControlEmitter): Promise<void> {
  if (!run.supports("stream")) return;
  for await (const message of run.stream()) {
    emitSdkMessage(emit, message);
  }
}

function emitSdkMessage(emit: ControlEmitter, message: SDKMessage): void {
  if (message.type === "tool_call") {
    emitControl(emit, "sdk_tool_call", {
      callId: message.call_id,
      name: message.name,
      status: message.status,
      args: message.args,
      result: message.result,
    });
    return;
  }
  if (message.type === "status") {
    emitControl(emit, "sdk_status", { status: message.status, message: message.message });
    return;
  }
  emitControl(emit, "sdk_message", { messageType: message.type });
}

function truncateShellText(text: string): string {
  if (text.length <= MAX_SHELL_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_SHELL_OUTPUT_CHARS)}\n…[truncated]`;
}

export function checkTokenCap(
  role: string,
  usage: TokenUsage | undefined,
  maxAgentTokens: number | undefined,
): boolean {
  if (!maxAgentTokens || !usage) return false;
  const total =
    usage.totalTokens ??
    usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  if (total <= maxAgentTokens) return false;
  process.stderr.write(
    `WARN: ${role} exceeded agent token cap: ${total} > ${maxAgentTokens}\n`,
  );
  return true;
}

export async function withAgentTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number | undefined,
  cancel: (() => Promise<void>) | undefined,
  role: string,
): Promise<T> {
  if (!timeoutMs) return operation;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      void cancel?.().catch(() => undefined);
      reject(new Error(`Agent timed out (${role}) after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function resolveModel(configured: string | undefined): string {
  if (configured && configured !== "default" && configured !== "small") return configured;
  if (configured === "small" && process.env.AGENT_HARNESS_SMALL_MODEL) {
    return process.env.AGENT_HARNESS_SMALL_MODEL;
  }
  return process.env.AGENT_HARNESS_MODEL ?? "auto";
}

async function readUsage(agent: { getUsage(): Promise<AgentUsage> }): Promise<AgentUsage | undefined> {
  try {
    return await agent.getUsage();
  } catch {
    return undefined;
  }
}

async function readReconciledUsage(
  agent: { getUsage(): Promise<AgentUsage> },
  reportedUsage: TokenUsage | undefined,
): Promise<AgentUsage | undefined> {
  const deadline = Date.now() + USAGE_RECONCILE_WINDOW_MS;
  let latest = await readUsage(agent);
  while (
    reportedUsage &&
    Date.now() < deadline &&
    (!latest || latest.usage.totalTokens < reportedUsage.totalTokens)
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, USAGE_RETRY_INTERVAL_MS));
    latest = (await readUsage(agent)) ?? latest;
  }
  return latest;
}

export function selectUsageTelemetry(
  reportedUsage: TokenUsage | undefined,
  billedUsage: TokenUsage | undefined,
): { usage?: TokenUsage; source?: "reported" | "billed" } {
  if (billedUsage && (!reportedUsage || billedUsage.totalTokens >= reportedUsage.totalTokens)) {
    return { usage: billedUsage, source: "billed" };
  }
  if (reportedUsage) return { usage: reportedUsage, source: "reported" };
  if (billedUsage) return { usage: billedUsage, source: "billed" };
  return {};
}

function extractText(run: RunResult | { result?: unknown }): string {
  const result = run.result;
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "text" in result) {
    return String((result as { text: unknown }).text);
  }
  return JSON.stringify(result ?? {});
}

export function parseWorkerStdout(stdout: string): WorkerInvokeResult | undefined {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    try {
      const parsed = JSON.parse(line) as WorkerStreamLine;
      if (parsed.stream === "result" && parsed.protocolVersion === 1) {
        return parsed;
      }
    } catch {
      continue;
    }
  }
  if (lines.length === 1) {
    try {
      const parsed = JSON.parse(lines[0]!) as WorkerInvokeResult;
      if (parsed.protocolVersion === 1) return parsed;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as InvokeRequest;
  const emit = (event: WorkerControlEvent): void => {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  };
  const output = await invokeCursorAgent(request, emit);
  process.stdout.write(`${JSON.stringify({ stream: "result", ...output })}\n`);
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("invoke.js") || entry.endsWith("invoke.ts")) {
  void main().catch((error) => {
    process.stderr.write(`${formatInvokeError(error)}\n`, () => process.exit(1));
  });
}
