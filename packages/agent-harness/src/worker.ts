#!/usr/bin/env node
import { Agent } from "@cursor/sdk";
import type { AgentTurnRequest, AgentTurnResult } from "./types.js";

type WorkerRequest = { protocolVersion: 1; request: AgentTurnRequest; model?: string };

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WorkerRequest;
  if (input.protocolVersion !== 1) throw new Error("Unsupported worker protocol");
  const modelId = input.model ?? process.env.AGENT_HARNESS_MODEL ?? "composer-2.5";
  const options = { apiKey: process.env.CURSOR_API_KEY, model: { id: modelId }, local: { cwd: "/workspace" } };
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
    const billed = await agent.getUsage({ runId: run.id }).catch(() => undefined);
    const cost = billed?.cost;
    usage = providerUsage || cost ? {
      inputTokens: providerUsage?.inputTokens,
      outputTokens: providerUsage?.outputTokens,
      cacheReadTokens: providerUsage?.cacheReadTokens,
      cacheWriteTokens: providerUsage?.cacheWriteTokens,
      totalTokens: providerUsage?.totalTokens,
      reasoningTokens: providerUsage?.reasoningTokens,
      costUsd: cost ? cost.chargedCents / 100 : undefined,
      rawCostUsd: cost ? cost.rawCostCents / 100 : undefined,
      provider: "cursor",
      model: providerResult.model?.id ?? run.model?.id ?? input.model,
      providerRunId: run.id,
      requestId: run.requestId,
      durationMs: providerResult.durationMs ?? run.durationMs,
    } : undefined;
    const output = JSON.parse(raw) as unknown;
    const envelope: AgentTurnResult = { turnId: input.request.turnId, sessionId: agent.agentId, output, usage };
    process.stdout.write(JSON.stringify({ protocolVersion: 1, result: envelope }));
  } finally {
    // Result output is intentionally written before cleanup. Once the envelope
    // is durable at the coordinator, disposal status is non-critical.
    await agent[Symbol.asyncDispose]();
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(JSON.stringify({ protocolVersion: 1, error: { message } }));
  process.exitCode = 1;
});
