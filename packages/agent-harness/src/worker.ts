#!/usr/bin/env node
import { Agent } from "@cursor/sdk";
import type { AgentTurnRequest, AgentTurnResult } from "./types.js";

type WorkerRequest = { protocolVersion: 1; request: AgentTurnRequest; model?: string };

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WorkerRequest;
  if (input.protocolVersion !== 1) throw new Error("Unsupported worker protocol");
  const options = { apiKey: process.env.CURSOR_API_KEY, ...(input.model ? { model: { id: input.model } } : {}), local: { cwd: "/workspace" } };
  let agent;
  if (input.request.sessionId) {
    try { agent = await Agent.resume(input.request.sessionId, options); }
    catch { agent = await Agent.create(options); }
  } else agent = await Agent.create(options);
  let raw = "";
  let usage: AgentTurnResult["usage"];
  try {
    const run = await agent.send(`${input.request.prompt}\n\nReturn exactly one JSON object matching this JSON Schema. No Markdown fences.\n${JSON.stringify(input.request.outputSchema)}`);
    const providerResult = await run.wait();
    if (providerResult.status === "error") throw new Error(providerResult.error?.message ?? "Cursor agent failed");
    raw = providerResult.result ?? "";
    const providerUsage = providerResult.usage ?? run.usage;
    usage = providerUsage ? { inputTokens: providerUsage.inputTokens, outputTokens: providerUsage.outputTokens } : undefined;
    const output = JSON.parse(raw) as unknown;
    const envelope: AgentTurnResult = { turnId: input.request.turnId, sessionId: agent.agentId, output, usage };
    process.stdout.write(JSON.stringify({ protocolVersion: 1, result: envelope }));
  } finally {
    // Result output is intentionally written before cleanup. Once the envelope
    // is durable at the coordinator, disposal status is non-critical.
    await agent[Symbol.asyncDispose]();
  }
}

void main().catch((error) => { process.stderr.write(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; });
