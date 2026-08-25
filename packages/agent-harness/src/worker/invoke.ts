import { Agent, type AgentUsage, type TokenUsage, type UsageCost } from "@cursor/sdk";
import { roleRulesFor } from "../domain/agent-roles.js";
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
};

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
    cost?: UsageCost;
  };
};

export async function invokeCursorAgent(request: InvokeRequest): Promise<WorkerInvokeResult> {
  const prompt = buildCursorInvokePrompt(request);
  const requestedModel = resolveModel(request.packet.model);

  await using agent = await Agent.create({
    apiKey: process.env.CURSOR_API_KEY,
    model: { id: requestedModel },
    local: { cwd: "/workspace" },
  });
  const run = await agent.send(prompt);
  const result = await run.wait();
  const text = extractText(run);
  let output: unknown;
  try {
    output = JSON.parse(text);
  } catch {
    output = { text };
  }
  const billed = await readUsage(agent);
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
      ...(result.usage ?? run.usage ?? billed?.usage
        ? { usage: result.usage ?? run.usage ?? billed?.usage }
        : {}),
      ...(billed?.cost ? { cost: billed.cost } : {}),
    },
  };
}

function resolveModel(configured: string | undefined): string {
  if (configured && configured !== "default" && configured !== "small") return configured;
  if (configured === "small" && process.env.AGENT_HARNESS_SMALL_MODEL) {
    return process.env.AGENT_HARNESS_SMALL_MODEL;
  }
  return process.env.AGENT_HARNESS_MODEL ?? "composer-2.5";
}

async function readUsage(agent: { getUsage(): Promise<AgentUsage> }): Promise<AgentUsage | undefined> {
  try {
    return await agent.getUsage();
  } catch {
    // Terminal run telemetry is still useful when the eventually-consistent billing call is unavailable.
    return undefined;
  }
}

function extractText(run: { result?: unknown }): string {
  const result = run.result;
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "text" in result) {
    return String((result as { text: unknown }).text);
  }
  return JSON.stringify(result ?? {});
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as InvokeRequest;
  const output = await invokeCursorAgent(request);
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("invoke.js") || entry.endsWith("invoke.ts")) {
  void main().catch((error) => {
    process.stderr.write(`${formatInvokeError(error)}\n`);
    process.exitCode = 1;
  });
}
