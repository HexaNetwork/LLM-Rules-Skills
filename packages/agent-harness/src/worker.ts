#!/usr/bin/env node
import { Agent } from "@cursor/sdk";
import type { AgentTurnRequest, AgentTurnResult } from "./types.js";

const WORKER_PROTOCOL_VERSION = 1;

type WorkerRequest = { protocolVersion: number; request: AgentTurnRequest; model?: string };

function fail(message: string): never {
  process.stdout.write(JSON.stringify({ protocolVersion: WORKER_PROTOCOL_VERSION, error: { message } }));
  process.exitCode = 1;
  throw new Error(message);
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  let input: WorkerRequest;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WorkerRequest;
  } catch {
    fail("Agent worker received invalid JSON input");
  }
  if (input.protocolVersion !== WORKER_PROTOCOL_VERSION) fail(`Unsupported worker protocol ${String(input.protocolVersion)}`);
  const modelId = input.model?.trim() || process.env.AGENT_HARNESS_MODEL?.trim();
  if (!modelId) fail("Local SDK agents require an explicit model. Pass model in the worker payload or set AGENT_HARNESS_MODEL in the container.");
  const options = { apiKey: process.env.CURSOR_API_KEY, model: { id: modelId }, local: { cwd: "/workspace" } };
  let agent;
  if (input.request.sessionId) {
    try { agent = await Agent.resume(input.request.sessionId, options); }
    catch { agent = await Agent.create(options); }
  } else agent = await Agent.create(options);
  try {
    const run = await agent.send(`${input.request.prompt}\n\nReturn exactly one JSON object matching this JSON Schema. No Markdown fences.\n${JSON.stringify(input.request.outputSchema)}`);
    const providerResult = await run.wait();
    if (providerResult.status === "error") fail(providerResult.error?.message ?? "Cursor agent failed");
    const raw = providerResult.result ?? "";
    const providerUsage = providerResult.usage ?? run.usage;
    const billed = await agent.getUsage({ runId: run.id }).catch(() => undefined);
    const cost = billed?.cost;
    const usage = providerUsage || cost ? {
      inputTokens: providerUsage?.inputTokens,
      outputTokens: providerUsage?.outputTokens,
      cacheReadTokens: providerUsage?.cacheReadTokens,
      cacheWriteTokens: providerUsage?.cacheWriteTokens,
      totalTokens: providerUsage?.totalTokens,
      reasoningTokens: providerUsage?.reasoningTokens,
      costUsd: cost ? cost.chargedCents / 100 : undefined,
      rawCostUsd: cost ? cost.rawCostCents / 100 : undefined,
      provider: "cursor",
      model: providerResult.model?.id ?? run.model?.id ?? modelId,
      providerRunId: run.id,
      requestId: run.requestId,
      durationMs: providerResult.durationMs ?? run.durationMs,
    } : undefined;
    const output = JSON.parse(raw) as unknown;
    const envelope: AgentTurnResult = { turnId: input.request.turnId, sessionId: agent.agentId, output, usage };
    process.stdout.write(JSON.stringify({ protocolVersion: WORKER_PROTOCOL_VERSION, result: envelope }));
  } finally {
    await agent[Symbol.asyncDispose]();
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(JSON.stringify({ protocolVersion: WORKER_PROTOCOL_VERSION, error: { message } }));
  process.exitCode = 1;
});
