import { HarnessFailure } from "../../errors.js";
import {
  AgentBackendRunError,
  type AgentBackend,
  type AgentBackendResult,
} from "./types.js";
import {
  detectInstallFromToolStep,
  prohibitedAgentPathAccess,
  summarizeAgentStep,
} from "./step-utils.js";
import { reportedTotal } from "./usage.js";

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
    workspaceCapabilities() {
      return { canRestrictWritableWorkspace: true, providerId: "cursor" };
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
              local: {
                cwd: request.cwd,
                sandboxOptions: { enabled: request.sandboxEnabled !== false },
              },
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
          local: {
            cwd: request.cwd,
            sandboxOptions: { enabled: request.sandboxEnabled !== false },
          },
        });
      }

      const submittedPrompt = providerSessionReused
        ? request.continuationPrompt ?? request.prompt
        : request.prompt;
      let run: CursorRun | undefined;
      let forbiddenToolCall: string | undefined;
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
            const observed = detectInstallFromToolStep(step);
            if (observed) {
              request.onInstallObserved?.({
                ...observed,
                role: request.role,
                ...(request.taskId ? { taskId: request.taskId } : {}),
              });
            }
            request.onStep?.(summarizeAgentStep(step));
            if (step.type !== "toolCall") return;
            const prohibitedPath = prohibitedAgentPathAccess(step.message?.args, request.cwd);
            if (prohibitedPath) {
              forbiddenToolCall = `${step.message?.type ?? "unknown"} (${prohibitedPath})`;
              cancel();
              return;
            }
            if (request.allowTools === false) {
              forbiddenToolCall = step.message?.type ?? "unknown";
              cancel();
              return;
            }
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
        if (forbiddenToolCall) {
          throw new AgentBackendRunError(
            `${request.role} attempted prohibited tool call: ${forbiddenToolCall}`,
            result,
          );
        }
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
