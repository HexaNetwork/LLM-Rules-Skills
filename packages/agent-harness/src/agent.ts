import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { HarnessConfig } from "./config.js";
import { modelForRole } from "./config.js";
import {
  PromptBuilderOutputSchema,
  type AgentRole,
  type WorkPacket,
} from "./domain.js";
import { HarnessFailure, RunCancelledError } from "./errors.js";
import { LocalKnowledgeBase } from "./knowledge.js";
import { buildWorkPacket } from "./packet.js";
import {
  renderContinuationPrompt,
  renderPrompt,
  renderPromptBuilderPrompt,
} from "./prompts.js";
import { RunStore } from "./store.js";

export type AgentRequest = {
  role: AgentRole;
  model: string;
  prompt: string;
  continuationPrompt?: string;
  providerSessionId?: string;
  retainProviderSession?: boolean;
  mode?: "agent" | "plan";
  cwd: string;
  signal: AbortSignal;
};

export type AgentBackendResult = {
  output: unknown;
  /** Plan-mode CreatePlan bodies captured during the run, oldest first. */
  createPlanBodies?: string[];
  providerSessionId?: string;
  providerRunId?: string;
  providerSessionReused?: boolean;
  submittedPrompt?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
};

export interface AgentBackend {
  run(request: AgentRequest): Promise<AgentBackendResult>;
  release?(providerSessionId: string): Promise<void>;
  readiness?(): { ready: boolean; message?: string };
}

export class AgentBackendRunError extends HarnessFailure {
  readonly result: Partial<AgentBackendResult>;

  constructor(
    message: string,
    result: Partial<AgentBackendResult> = {},
  ) {
    super(message, "provider", true);
    this.name = "AgentBackendRunError";
    this.result = result;
  }
}

type InvokeBase<T> = {
  runId: string;
  role: AgentRole;
  objective: string;
  input: unknown;
  expectedOutput: string;
  // Input is intentionally loosened: schemas with `.default()` fields have an
  // Input type narrower than parsed Output T, which a plain z.ZodType<T> would reject here.
  schema: z.ZodType<T, z.ZodTypeDef, any>;
  constraints?: string[];
  priorArtifacts?: string[];
  /** Domain seed for Graphify when the primary query shapes to generic tokens. */
  knowledgeFallbackQuery?: string;
  buildPrompt?: boolean;
  previousGuidanceFingerprint?: string;
  /** Out-of-band cancellation from the harness engine. */
  signal?: AbortSignal;
};

/** Retrieval-disabled calls must not invent a JSON-blob knowledge query. */
export type InvokeInput<T> =
  | (InvokeBase<T> & { retrieval: false; knowledgeQuery?: string })
  | (InvokeBase<T> & { retrieval?: true; knowledgeQuery: string });

export type AgentInvocation<T> = {
  value: T;
  providerSessionId?: string;
  providerRunId?: string;
  providerSessionReused: boolean;
  providerTurns: number;
  guidanceFingerprint?: string;
};

export class AgentCoordinator {
  constructor(
    private readonly config: HarnessConfig,
    private readonly backend: AgentBackend,
    private readonly store: RunStore,
    private readonly knowledge: LocalKnowledgeBase,
  ) {}

  async invoke<T>(input: InvokeInput<T>): Promise<T> {
    return (await this.invokeInternal(input)).value;
  }

  async invokeInEpisode<T>(
    input: InvokeInput<T> & { providerSessionId?: string },
  ): Promise<AgentInvocation<T>> {
    return this.invokeInternal(input, {
      providerSessionId: input.providerSessionId,
      retainProviderSession: true,
      mode: "plan",
    });
  }

  async releaseProviderSession(providerSessionId: string | undefined): Promise<void> {
    if (providerSessionId) await this.backend.release?.(providerSessionId);
  }

  private async invokeInternal<T>(
    input: InvokeInput<T>,
    episode: {
      providerSessionId?: string;
      retainProviderSession?: boolean;
      mode?: "agent" | "plan";
    } = {},
  ): Promise<AgentInvocation<T>> {
    const invocationId = randomUUID();
    const retrievalEnabled = input.retrieval !== false;
    const guidanceEnabled = retrievalEnabled && this.config.knowledge.guidance.enabled;
    let guidanceAudit: Awaited<ReturnType<LocalKnowledgeBase["selectGuidanceWithAudit"]>> = {
      selected: [],
      omittedAlwaysApply: [],
    };
    let retrieval: Awaited<ReturnType<LocalKnowledgeBase["searchWithAudit"]>> = {
      results: [],
      audit: {
        query: "",
        graphify: {
          shapedQuery: "",
          usedFallback: false,
          included: false,
          skippedReason: "retrieval-disabled",
        },
        kept: [],
        omitted: [],
      },
    };

    if (retrievalEnabled) {
      const knowledgeQuery = input.knowledgeQuery;
      if (!knowledgeQuery?.trim()) {
        throw new Error(`knowledgeQuery is required when retrieval is enabled for role ${input.role}`);
      }
      const knowledgeFallbackQuery = input.knowledgeFallbackQuery;
      [guidanceAudit, retrieval] = await Promise.all([
        guidanceEnabled
          ? this.knowledge.selectGuidanceWithAudit(knowledgeQuery, {
              role: input.role,
              knownPaths: knownPaths(input.input),
            })
          : Promise.resolve({ selected: [], omittedAlwaysApply: [] }),
        this.knowledge.searchWithAudit(
          knowledgeQuery,
          this.config.workflow.contextResults,
          {
            repository: this.config.knowledge.graphify.roles.includes(input.role),
            excludeGuidance: guidanceEnabled,
            runId: input.runId,
            fallbackQuery: knowledgeFallbackQuery,
          },
        ),
      ]);
    } else {
      retrieval = {
        results: [],
        audit: {
          query: "",
          graphify: {
            shapedQuery: "",
            usedFallback: false,
            included: false,
            skippedReason: "retrieval-disabled",
          },
          kept: [],
          omitted: [],
          skipped: "retrieval-disabled",
        },
      };
    }

    const { packet, budgetAudit } = buildWorkPacket({
      invocationId,
      runId: input.runId,
      role: input.role,
      objective: input.objective,
      constraints: input.constraints ?? [],
      input: input.input,
      guidance: guidanceAudit.selected,
      retrievalResults: retrieval.results,
      priorArtifacts: input.priorArtifacts ?? [],
      expectedOutput: input.expectedOutput,
      createdAt: new Date().toISOString(),
      budgets: {
        contextCharacters: this.config.workflow.contextCharacters,
        inputCharacters: this.config.workflow.inputCharacters,
        graphifyCharacters: this.config.workflow.graphifyCharacters,
      },
    });
    const guidanceFingerprint = fingerprintGuidance(packet.guidance);
    const packetPath = `packets/${invocationId}.json`;
    await this.store.writeJson(input.runId, packetPath, packet);
    await this.store.writeJson(input.runId, `packets/${invocationId}.guidance.json`, guidanceAudit);
    await this.store.writeJson(input.runId, `packets/${invocationId}.retrieval.json`, {
      retrieval: retrieval.audit,
      budget: budgetAudit,
    });

    let prompt = renderPrompt(packet);
    const shouldBuildPrompt =
      input.buildPrompt !== false &&
      this.config.agent.promptBuilder &&
      input.role !== "prompt-builder" &&
      input.role !== "message-writer";
    if (shouldBuildPrompt) {
      try {
        const built = await this.invokePacket(
          input.runId,
          "prompt-builder",
          packet,
          renderPromptBuilderPrompt(packet),
          PromptBuilderOutputSchema,
          packetPath,
          { signal: input.signal },
        );
        prompt = built.value.prompt;
      } catch (error) {
        if (error instanceof RunCancelledError || input.signal?.aborted) throw error;
        // Prompt compilation is an optional cheap tier. The deterministic
        // renderer remains a complete handoff if that tier is unavailable.
        prompt = renderPrompt(packet);
      }
    }
    const includeGuidance =
      !episode.providerSessionId ||
      !input.previousGuidanceFingerprint ||
      input.previousGuidanceFingerprint !== guidanceFingerprint;
    const invocation = await this.invokePacket(
      input.runId,
      input.role,
      packet,
      prompt,
      input.schema,
      packetPath,
      {
        providerSessionId: episode.providerSessionId,
        continuationPrompt: episode.providerSessionId
          ? renderContinuationPrompt(packet, { includeGuidance })
          : undefined,
        retainProviderSession: episode.retainProviderSession,
        mode: episode.mode,
        signal: input.signal,
      },
    );
    return { ...invocation, guidanceFingerprint };
  }

  private async invokePacket<T>(
    runId: string,
    role: AgentRole,
    packet: WorkPacket,
    initialPrompt: string,
    schema: z.ZodType<T>,
    packetPath: string,
    options: {
      providerSessionId?: string;
      continuationPrompt?: string;
      retainProviderSession?: boolean;
      mode?: "agent" | "plan";
      signal?: AbortSignal;
    } = {},
  ): Promise<AgentInvocation<T>> {
    let prompt = initialPrompt;
    let continuationPrompt = options.continuationPrompt;
    let providerSessionId = options.providerSessionId;
    let lastError: unknown;
    let completed = false;
    const attempts = this.config.agent.schemaRepairAttempts + 1;
    const retainForRepair = attempts > 1;
    try {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const sessionId = randomUUID();
        const startedAt = new Date().toISOString();
        const submittedPrompt = providerSessionId && continuationPrompt
          ? continuationPrompt
          : prompt;
        await this.store.writeJson(runId, `sessions/${sessionId}.json`, {
          sessionId,
          invocationId: packet.invocationId,
          role,
          model: modelForRole(this.config, role),
          providerSessionId,
          status: "running",
          attempt,
          packet: packetPath,
          prompt: submittedPrompt,
          startedAt,
        });

        let result: AgentBackendResult;
        try {
          result = await withTimeout(
            (signal) =>
              this.backend.run({
                role,
                model: modelForRole(this.config, role),
                prompt,
                continuationPrompt,
                providerSessionId,
                retainProviderSession: options.retainProviderSession || retainForRepair,
                mode: options.mode,
                cwd: this.config.repositoryRoot,
                signal,
              }),
            this.config.agent.timeoutMs,
            `${role} agent`,
            options.signal,
          );
        } catch (error) {
          lastError = error;
          const failure = error instanceof AgentBackendRunError ? error.result : {};
          providerSessionId = failure.providerSessionId ?? providerSessionId;
          const failureOutput = tryResolveAgentOutput(
            failure.output,
            failure.createPlanBodies,
          );
          const cancelled =
            error instanceof RunCancelledError || options.signal?.aborted === true;
          await this.store.writeJson(runId, `sessions/${sessionId}.json`, {
            sessionId,
            invocationId: packet.invocationId,
            role,
            model: modelForRole(this.config, role),
            providerSessionId,
            providerRunId: failure.providerRunId,
            providerSessionReused: failure.providerSessionReused,
            status: cancelled ? "cancelled" : "failed",
            attempt,
            packet: packetPath,
            prompt: failure.submittedPrompt ?? submittedPrompt,
            startedAt,
            endedAt: new Date().toISOString(),
            usage: usageRecord(failure),
            output: failureOutput,
            error: error instanceof Error ? error.message : String(error),
          });
          // Cancel, timeout, and provider errors are not schema-repairable.
          if (cancelled && !(error instanceof RunCancelledError)) {
            throw new RunCancelledError(
              error instanceof Error ? error.message : "Run cancelled",
            );
          }
          throw error;
        }

        providerSessionId = result.providerSessionId ?? providerSessionId;
        const actualPrompt = result.submittedPrompt ?? submittedPrompt;
        let harvestedRaw = tryResolveAgentOutput(result.output, result.createPlanBodies);
        let parsed: T;
        try {
          const harvested = resolveAgentOutput(result.output, result.createPlanBodies);
          harvestedRaw = harvested.raw;
          parsed = schema.parse(harvested.parsed);
        } catch (error) {
          lastError = error;
          await this.store.writeJson(runId, `sessions/${sessionId}.json`, {
            sessionId,
            invocationId: packet.invocationId,
            role,
            model: modelForRole(this.config, role),
            providerSessionId,
            providerRunId: result.providerRunId,
            providerSessionReused: result.providerSessionReused,
            status: "failed",
            attempt,
            packet: packetPath,
            prompt: actualPrompt,
            startedAt,
            endedAt: new Date().toISOString(),
            usage: usageRecord(result),
            output: harvestedRaw,
            error: error instanceof Error ? error.message : String(error),
          });
          if (attempt + 1 >= attempts) {
            throw new HarnessFailure(
              error instanceof Error ? error.message : String(error),
              "contract",
              true,
              { cause: error },
            );
          }
          const repair = repairInstruction("Validation error", error);
          prompt = `${initialPrompt}\n\n${repair}`;
          continuationPrompt = repair;
          continue;
        }

        await this.store.writeJson(runId, `sessions/${sessionId}.json`, {
          sessionId,
          invocationId: packet.invocationId,
          role,
          model: modelForRole(this.config, role),
          providerSessionId,
          providerRunId: result.providerRunId,
          providerSessionReused: result.providerSessionReused,
          status: "completed",
          attempt,
          packet: packetPath,
          prompt: actualPrompt,
          startedAt,
          endedAt: new Date().toISOString(),
          usage: usageRecord(result),
          output: harvestedRaw,
          handoff: {
            summary:
              typeof parsed === "object" && parsed && "summary" in parsed
                ? String((parsed as { summary: unknown }).summary)
                : `${role} completed`,
            artifactRefs: [packetPath, `sessions/${sessionId}.json`],
          },
        });
        completed = true;
        return {
          value: parsed,
          providerSessionId,
          providerRunId: result.providerRunId,
          providerSessionReused: result.providerSessionReused ?? false,
          providerTurns: attempt + 1,
        };
      }
      throw lastError instanceof HarnessFailure
        ? lastError
        : new HarnessFailure(
            lastError instanceof Error ? lastError.message : String(lastError),
            "contract",
            true,
            { cause: lastError },
          );
    } finally {
      if (!options.retainProviderSession || !completed) {
        await this.releaseProviderSession(providerSessionId).catch(() => undefined);
      }
    }
  }
}

function knownPaths(input: unknown): string[] {
  if (typeof input !== "object" || input === null) return [];
  const values: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, nested] of Object.entries(value)) {
      if ((key === "affectedPaths" || key === "changedFiles") && Array.isArray(nested)) {
        values.push(...nested.filter((item): item is string => typeof item === "string"));
      } else {
        visit(nested);
      }
    }
  };
  visit(input);
  return [...new Set(values)];
}

function fingerprintGuidance(guidance: WorkPacket["guidance"]): string {
  return createHash("sha256")
    .update(guidance.map((item) => item.source).join("\0"))
    .digest("hex");
}

export function createCursorBackend(
  apiKey = process.env.CURSOR_API_KEY,
  options?: { retainTtlMs?: number; maxRetained?: number },
): AgentBackend {
  type CursorUsage = {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
  };
  type CursorRun = {
    id: string;
    wait(): Promise<{
      id?: string;
      status: string;
      result?: string;
      usage?: CursorUsage;
    }>;
    cancel?: () => Promise<void>;
    supports?(operation: string): boolean;
    conversation?(): Promise<Array<{ steps?: unknown[] }>>;
  };
  type CursorAgent = {
    agentId: string;
    send(prompt: string, options?: Record<string, unknown>): Promise<CursorRun>;
    close?: () => void;
    [Symbol.asyncDispose]?: () => Promise<void>;
  };
  type RetainedAgent = { agent: CursorAgent; lastUsedAt: number };

  const retainTtlMs = options?.retainTtlMs ?? 60 * 60_000;
  const maxRetained = options?.maxRetained ?? 8;
  const retainedAgents = new Map<string, RetainedAgent>();

  async function disposeRetained(agent: CursorAgent): Promise<void> {
    await disposeAgent(agent).catch(() => undefined);
  }

  async function sweepExpired(now: number): Promise<void> {
    for (const [id, entry] of retainedAgents) {
      if (now - entry.lastUsedAt <= retainTtlMs) continue;
      retainedAgents.delete(id);
      await disposeRetained(entry.agent);
    }
  }

  async function evictLruToCap(): Promise<void> {
    while (retainedAgents.size > maxRetained) {
      let oldestId: string | undefined;
      let oldestAt = Infinity;
      for (const [id, entry] of retainedAgents) {
        if (entry.lastUsedAt < oldestAt) {
          oldestAt = entry.lastUsedAt;
          oldestId = id;
        }
      }
      if (oldestId == null) break;
      const entry = retainedAgents.get(oldestId);
      retainedAgents.delete(oldestId);
      if (entry) await disposeRetained(entry.agent);
    }
  }

  return {
    readiness() {
      return apiKey
        ? { ready: true }
        : { ready: false, message: "CURSOR_API_KEY is required for the Cursor backend." };
    },
    async run(request) {
      if (!apiKey) throw new Error("CURSOR_API_KEY is required for the Cursor backend");
      const sdk = (await import("@cursor/sdk")) as unknown as {
        Agent: {
          create(options: Record<string, unknown>): Promise<CursorAgent>;
          resume(agentId: string, options?: Record<string, unknown>): Promise<CursorAgent>;
        };
      };

      await sweepExpired(Date.now());

      let agent: CursorAgent | undefined;
      let providerSessionReused = false;
      if (request.providerSessionId) {
        const retained = retainedAgents.get(request.providerSessionId);
        if (retained) {
          agent = retained.agent;
          retained.lastUsedAt = Date.now();
        } else {
          try {
            agent = await sdk.Agent.resume(request.providerSessionId, {
              apiKey,
              model: { id: request.model },
              local: { cwd: request.cwd },
            });
          } catch {
            // The complete prompt remains a durable fallback when a provider
            // checkpoint is missing, expired, or cannot be hydrated.
          }
        }
        providerSessionReused = agent != null;
      }
      if (!agent) {
        agent = await sdk.Agent.create({
          apiKey,
          model: { id: request.model },
          local: { cwd: request.cwd },
        });
      }

      const submittedPrompt = providerSessionReused
        ? request.continuationPrompt ?? request.prompt
        : request.prompt;
      let run: CursorRun | undefined;
      const cancel = (): void => {
        if (run?.cancel) void run.cancel().catch(() => undefined);
      };
      request.signal.addEventListener("abort", cancel, { once: true });
      try {
        const createPlanBodies: string[] = [];
        run = await agent.send(submittedPrompt, {
          model: { id: request.model },
          mode: request.mode,
          onStep: ({ step }: { step: { type: string; message?: { type?: string; args?: unknown } } }) => {
            if (step.type !== "toolCall") return;
            const planBody = createPlanBodyFromTool(step.message);
            if (planBody) createPlanBodies.push(planBody);
          },
        });
        if (request.signal.aborted) cancel();
        const response = await Promise.race([
          run.wait(),
          new Promise<never>((_resolve, reject) => {
            if (request.signal.aborted) {
              reject(new HarnessFailure(`${request.role} aborted`, "provider", true));
              return;
            }
            request.signal.addEventListener(
              "abort",
              () => reject(new HarnessFailure(`${request.role} aborted`, "provider", true)),
              { once: true },
            );
          }),
        ]);
        if (createPlanBodies.length === 0 && run.supports?.("conversation") && run.conversation) {
          try {
            createPlanBodies.push(...(await harvestCreatePlansFromConversation(await run.conversation())));
          } catch {
            // Conversation replay is best-effort when onStep missed CreatePlan.
          }
        }
        if (request.retainProviderSession) {
          retainedAgents.set(agent.agentId, { agent, lastUsedAt: Date.now() });
          await evictLruToCap();
        }
        const result: AgentBackendResult = {
          output: response.result ?? "",
          createPlanBodies,
          providerSessionId: agent.agentId,
          providerRunId: response.id ?? run.id,
          providerSessionReused,
          submittedPrompt,
          inputTokens: response.usage?.inputTokens,
          outputTokens: response.usage?.outputTokens,
          cacheReadTokens: response.usage?.cacheReadTokens,
          cacheWriteTokens: response.usage?.cacheWriteTokens,
          totalTokens: reportedTotal(response.usage),
          reasoningTokens: response.usage?.reasoningTokens,
        };
        if (response.status === "error" || response.status === "cancelled") {
          throw new AgentBackendRunError(
            `Cursor run ${run.id} ${response.status}`,
            result,
          );
        }
        return result;
      } catch (error) {
        if (error instanceof AgentBackendRunError) throw error;
        throw new AgentBackendRunError(
          error instanceof Error ? error.message : String(error),
          {
            providerSessionId: agent.agentId,
            providerRunId: run?.id,
            providerSessionReused,
            submittedPrompt,
          },
        );
      } finally {
        request.signal.removeEventListener("abort", cancel);
        if (!request.retainProviderSession || !retainedAgents.has(agent.agentId)) {
          await disposeAgent(agent);
        }
      }
    },
    async release(providerSessionId) {
      const entry = retainedAgents.get(providerSessionId);
      if (!entry) return;
      retainedAgents.delete(providerSessionId);
      await disposeRetained(entry.agent);
    },
  };
}

export function createFakeBackend(
  handlers: Partial<Record<AgentRole, (request: AgentRequest) => unknown | Promise<unknown>>>,
): AgentBackend {
  return {
    async run(request) {
      const handler = handlers[request.role];
      if (!handler) throw new Error(`No fake handler for ${request.role}`);
      const providerSessionId = request.providerSessionId ?? randomUUID();
      const providerSessionReused = request.providerSessionId != null;
      return {
        output: await handler(request),
        providerSessionId,
        providerRunId: randomUUID(),
        providerSessionReused,
        submittedPrompt: providerSessionReused
          ? request.continuationPrompt ?? request.prompt
          : request.prompt,
      };
    },
    async release() {
      // Fake sessions have no external resources.
    },
  };
}

function usageRecord(result: Partial<AgentBackendResult>): Record<string, number> | undefined {
  const usage = {
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheReadTokens: result.cacheReadTokens,
    cacheWriteTokens: result.cacheWriteTokens,
    totalTokens: reportedTotal(result),
    reasoningTokens: result.reasoningTokens,
  };
  const present = Object.entries(usage).filter(
    (entry): entry is [string, number] => typeof entry[1] === "number",
  );
  return present.length > 0 ? Object.fromEntries(present) : undefined;
}

/**
 * Derive a non-double-counted total. Cursor SDK usage reports inputTokens
 * inclusive of cache reads, yet its own totalTokens adds cacheReadTokens (and
 * cacheWriteTokens) on top, so the provider total is never trusted when the
 * input/output components are available.
 */
export function reportedTotal(
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined,
): number | undefined {
  if (typeof usage?.inputTokens !== "number" || typeof usage.outputTokens !== "number") {
    return usage?.totalTokens;
  }
  return usage.inputTokens + usage.outputTokens;
}

function repairInstruction(label: string, error: unknown): string {
  return [
    "Your previous response did not satisfy the required JSON contract.",
    `${label}: ${error instanceof Error ? error.message.slice(0, 4_000) : String(error)}`,
    "Return one corrected JSON object only. Do not repeat repository exploration.",
  ].join("\n");
}

async function disposeAgent(agent: {
  close?: () => void;
  [Symbol.asyncDispose]?: () => Promise<void>;
}): Promise<void> {
  const dispose = agent[Symbol.asyncDispose];
  if (dispose) {
    await dispose.call(agent);
    return;
  }
  agent.close?.();
}

/**
 * Prefer the latest parseable candidate among assistant result text and
 * CreatePlan bodies (oldest first). Empty result strings are skipped.
 */
export function resolveAgentOutput(
  resultOutput: unknown,
  createPlanBodies: string[] = [],
): { raw: unknown; parsed: unknown } {
  const candidates: unknown[] = [];
  for (const body of createPlanBodies) {
    if (typeof body === "string" && body.trim()) candidates.push(body);
  }
  if (typeof resultOutput === "string") {
    if (resultOutput.trim()) candidates.push(resultOutput);
  } else if (resultOutput != null) {
    candidates.push(resultOutput);
  }

  let lastError: unknown = new Error("Agent response contains no JSON object");
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index]!;
    try {
      return { raw: candidate, parsed: parseOutput(candidate) };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** Best-effort raw payload for failed sessions that may lack parseable JSON. */
function tryResolveAgentOutput(
  resultOutput: unknown,
  createPlanBodies: string[] = [],
): unknown {
  try {
    return resolveAgentOutput(resultOutput, createPlanBodies).raw;
  } catch {
    const lastPlan = [...createPlanBodies].reverse().find((body) => body.trim());
    return lastPlan ?? resultOutput ?? "";
  }
}

export function parseOutput(output: unknown): unknown {
  if (typeof output !== "string") return output;
  // Greedy fence capture: JSON string values may themselves contain code
  // fences (```java, ```mermaid), so a lazy match would truncate mid-object.
  const fenced = output.match(/```json\s*([\s\S]*)```/i)?.[1];
  const candidate = fenced ?? output;
  const start = candidate.indexOf("{");
  if (start < 0) throw new Error("Agent response contains no JSON object");
  const balancedEnd = jsonObjectEnd(candidate, start);
  if (balancedEnd > start) {
    return JSON.parse(candidate.slice(start, balancedEnd + 1));
  }
  const end = candidate.lastIndexOf("}");
  if (end <= start) throw new Error("Agent response contains no JSON object");
  return JSON.parse(candidate.slice(start, end + 1));
}

/**
 * End index of the JSON object opening at `start`, ignoring braces inside
 * string literals. Returns -1 when the object never closes.
 */
function jsonObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function createPlanBodyFromTool(message: { type?: string; args?: unknown } | undefined): string | undefined {
  if (!message || message.type !== "createPlan") return undefined;
  if (!isRecord(message.args)) return undefined;
  const plan = message.args.plan;
  return typeof plan === "string" && plan.trim() ? plan : undefined;
}

async function harvestCreatePlansFromConversation(
  turns: Array<{ steps?: unknown[] }>,
): Promise<string[]> {
  const bodies: string[] = [];
  for (const turn of turns) {
    for (const step of turn.steps ?? []) {
      if (!isRecord(step) || step.type !== "toolCall") continue;
      const message = isRecord(step.message) ? step.message : undefined;
      const plan = createPlanBodyFromTool(
        message
          ? { type: typeof message.type === "string" ? message.type : undefined, args: message.args }
          : undefined,
      );
      if (plan) bodies.push(plan);
    }
  }
  return bodies;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
  external?: AbortSignal,
): Promise<T> {
  const timeoutController = new AbortController();
  const signal =
    external != null
      ? AbortSignal.any([external, timeoutController.signal])
      : timeoutController.signal;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timeoutController.abort();
      reject(new HarnessFailure(`${label} timed out after ${timeoutMs}ms`, "provider", true));
    }, timeoutMs);
  });
  let onExternalAbort: (() => void) | undefined;
  const cancelled =
    external != null
      ? new Promise<never>((_resolve, reject) => {
          const fail = (): void => {
            reject(new RunCancelledError(`${label} cancelled`));
          };
          if (external.aborted) {
            fail();
            return;
          }
          onExternalAbort = fail;
          external.addEventListener("abort", fail, { once: true });
        })
      : null;
  try {
    return await Promise.race([
      operation(signal),
      timeout,
      ...(cancelled ? [cancelled] : []),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (external && onExternalAbort) {
      external.removeEventListener("abort", onExternalAbort);
    }
  }
}
