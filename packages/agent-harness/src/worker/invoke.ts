import { Agent } from "@cursor/sdk";
import { roleRulesFor } from "../domain/agent-roles.js";
import { formatInvokeError } from "../domain/cursor-agent-error.js";
import { REFLECT_EXPECTED_OUTPUT } from "../domain/reflect.js";

type InvokeRequest = {
  role: string;
  packet: {
    role: string;
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

export async function invokeCursorAgent(request: InvokeRequest): Promise<unknown> {
  const prompt = buildCursorInvokePrompt(request);

  await using agent = await Agent.create({
    apiKey: process.env.CURSOR_API_KEY,
    model: { id: process.env.AGENT_HARNESS_MODEL ?? "composer-2.5" },
    local: { cwd: "/workspace" },
  });
  const run = await agent.send(prompt);
  await run.wait();
  const text = extractText(run);
  try {
    return JSON.parse(text);
  } catch {
    return { text };
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
