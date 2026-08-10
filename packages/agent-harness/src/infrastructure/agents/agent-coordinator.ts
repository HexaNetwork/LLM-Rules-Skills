import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { HarnessConfig } from "../../config.js";
import { modelForRole } from "../../config.js";
import {
  PromptBuilderOutputSchema,
  type AgentRole,
  type WorkPacket,
} from "../../domain.js";
import { HarnessFailure, RunCancelledError } from "../../errors.js";
import { LocalKnowledgeBase } from "../../knowledge.js";
import { buildWorkPacket } from "../../packet.js";
import {
  renderContinuationPrompt,
  renderPrompt,
  renderPromptBuilderPrompt,
} from "../../prompts.js";
import { RunStore } from "../../store.js";
import { createSessionActivityTracker } from "./activity-tracker.js";
import { resolveAgentOutput, tryResolveAgentOutput } from "./output-parser.js";
import {
  AgentBackendRunError,
  type AgentBackend,
  type AgentBackendResult,
  type AgentInvocation,
  type InvokeInput,
} from "./types.js";
import { usageRecord } from "./usage.js";

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
    input: InvokeInput<T> & {
      providerSessionId?: string;
      mode?: "agent" | "plan";
    },
  ): Promise<AgentInvocation<T>> {
    return this.invokeInternal(input, {
      providerSessionId: input.providerSessionId,
      retainProviderSession: true,
      mode: input.mode ?? "plan",
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
      missingAssignments: [],
      omittedAlwaysApply: [],
      omittedOverrides: [],
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
              assignment: this.config.knowledge.guidance.assignments?.[input.role],
              knownPaths: knownPaths(input.input),
            })
          : Promise.resolve({ selected: [], missingAssignments: [], omittedAlwaysApply: [], omittedOverrides: [] }),
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
      constraints: [
        ...(input.constraints ?? []),
        ...(this.config.agent.maxToolCalls > 0
          ? [`This invocation has a hard limit of ${this.config.agent.maxToolCalls} tool calls. Stay within it; if more investigation is required, stop and report the blocker.`]
          : []),
      ],
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
        const model = modelForRole(this.config, role);
        await this.store.writeJson(runId, `sessions/${sessionId}.json`, {
          sessionId,
          invocationId: packet.invocationId,
          role,
          model,
          providerSessionId,
          status: "running",
          attempt,
          packet: packetPath,
          prompt: submittedPrompt,
          startedAt,
        });

        const activity = createSessionActivityTracker(this.store, runId, {
          sessionId,
          role,
          model,
          startedAt,
        });
        await activity.writeNow();

        let result: AgentBackendResult;
        let toolCallCount = 0;
        let toolLimitFailure: HarnessFailure | undefined;
        const toolLimitController = new AbortController();
        const invocationSignal = options.signal
          ? AbortSignal.any([options.signal, toolLimitController.signal])
          : toolLimitController.signal;
        try {
          const taskId = taskIdFromPacketInput(packet.input);
          result = await withTimeout(
            (signal) =>
              this.backend.run({
                role,
                model,
                prompt,
                continuationPrompt,
                providerSessionId,
                retainProviderSession: options.retainProviderSession || retainForRepair,
                mode: options.mode,
                cwd: this.config.repositoryRoot,
                signal,
                taskId,
                onStep: (step) => {
                  void activity.recordStep(step);
                  if (
                    step.type === "toolCall" &&
                    this.config.agent.maxToolCalls > 0 &&
                    ++toolCallCount > this.config.agent.maxToolCalls &&
                    !toolLimitFailure
                  ) {
                    toolLimitFailure = new HarnessFailure(
                      `${role} agent exceeded the ${this.config.agent.maxToolCalls}-tool-call limit`,
                      "budget",
                      false,
                    );
                    toolLimitController.abort();
                  }
                },
                onInstallObserved: (entry) => {
                  void this.store
                    .appendJsonl(runId, "installs.jsonl", {
                      at: new Date().toISOString(),
                      role: entry.role,
                      ...(entry.taskId ? { taskId: entry.taskId } : {}),
                      manager: entry.manager,
                      commandSummary: entry.commandSummary,
                      packages: entry.packages,
                      source: "agent",
                    })
                    .catch(() => undefined);
                },
              }),
            this.config.agent.timeoutMs,
            `${role} agent`,
            invocationSignal,
          );
          await activity.flush();
        } catch (error) {
          await activity.flush();
          await activity.clear();
          const invocationError = toolLimitFailure ?? error;
          lastError = invocationError;
          const failure = error instanceof AgentBackendRunError ? error.result : {};
          providerSessionId = failure.providerSessionId ?? providerSessionId;
          const failureOutput = tryResolveAgentOutput(
            failure.output,
            failure.createPlanBodies,
          );
          const cancelled = !toolLimitFailure && (
            error instanceof RunCancelledError || options.signal?.aborted === true
          );
          await this.store.writeJson(runId, `sessions/${sessionId}.json`, {
            sessionId,
            invocationId: packet.invocationId,
            role,
            model,
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
            error: invocationError instanceof Error ? invocationError.message : String(invocationError),
          });
          if (toolLimitFailure) throw toolLimitFailure;
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
          await activity.clear();
          lastError = error;
          await this.store.writeJson(runId, `sessions/${sessionId}.json`, {
            sessionId,
            invocationId: packet.invocationId,
            role,
            model,
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

        await activity.clear();
        await this.store.writeJson(runId, `sessions/${sessionId}.json`, {
          sessionId,
          invocationId: packet.invocationId,
          role,
          model,
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

function repairInstruction(label: string, error: unknown): string {
  return [
    "Your previous response did not satisfy the required JSON contract.",
    `${label}: ${error instanceof Error ? error.message.slice(0, 4_000) : String(error)}`,
    "Return one corrected JSON object only. Do not repeat repository exploration.",
  ].join("\n");
}

function taskIdFromPacketInput(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  if (typeof input.taskId === "string" && input.taskId.trim()) return input.taskId.trim();
  const task = input.task;
  if (isRecord(task) && typeof task.id === "string" && task.id.trim()) return task.id.trim();
  return undefined;
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
