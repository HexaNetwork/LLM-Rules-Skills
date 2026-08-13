import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  outcomeFromParsedOutput,
  type InvocationKind,
  type InvocationTrigger,
} from "../../application/agent-activity.js";
import { resolveHarnessHome } from "../../application/harness-home.js";
import { resolveHarnessPaths, type HarnessPaths } from "../../application/paths.js";
import {
  assertWorkspaceIsolation,
  capabilitiesForBackend,
} from "../../application/workspace-isolation.js";
import type { HarnessConfig } from "../../config/schema.js";
import { modelForRole } from "../../config/defaults.js";
import {
  PromptBuilderOutputSchema,
  type AgentRole,
  type RunPhase,
  type WorkPacket,
} from "../../domain.js";
import { discoverDomainArtifacts } from "../../domain/domain-artifacts.js";
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

type CausalMeta = {
  taskId?: string;
  phase?: RunPhase;
  taskStep?: string;
  invocationKind?: InvocationKind;
  trigger?: InvocationTrigger;
};

/** Roles that get a tighter document context budget (soft diversity + lower limit). */
const WORKER_RETRIEVAL_ROLES = new Set<AgentRole>([
  "scenario-writer",
  "unit-test-writer",
  "implementer",
  "reviewer",
  "task-reviewer",
  "fixer",
  "config-fixer",
  "message-writer",
]);

export class AgentCoordinator {
  constructor(
    private readonly config: HarnessConfig,
    private readonly backend: AgentBackend,
    private readonly store: RunStore,
    private readonly knowledge: LocalKnowledgeBase,
    private readonly paths: HarnessPaths = resolveHarnessPaths(config),
  ) {}

  private get workspaceRoot(): string {
    return this.paths.workspaceRoot;
  }

  /**
   * Enforce writable-workspace isolation before agent invocations.
   * Strict mode refuses providers that cannot restrict the workspace root.
   */
  assertIsolationBoundary(homeRoot = resolveHarnessHome().homeRoot): void {
    assertWorkspaceIsolation({
      paths: this.paths,
      homeRoot,
      strictIsolation: this.config.agent.strictIsolation,
      capabilities: capabilitiesForBackend(
        this.backend,
        this.config.agent.provider,
      ),
      agentCwd: this.workspaceRoot,
    });
  }

  async invoke<T>(input: InvokeInput<T>): Promise<T> {
    return (await this.invokeInternal(input)).value;
  }

  async invokeInEpisode<T>(
    input: InvokeInput<T> & {
      providerSessionId?: string;
      mode?: "agent" | "plan";
      /** Defaults to true. Set false to reuse a context for one final turn then release it. */
      retainProviderSession?: boolean;
    },
  ): Promise<AgentInvocation<T>> {
    return this.invokeInternal(input, {
      providerSessionId: input.providerSessionId,
      retainProviderSession: input.retainProviderSession ?? true,
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
    const invocationRetrieval = input.retrieval !== false;
    // Guidance is independent of document RAG / repository retrieval.
    const guidanceEnabled = invocationRetrieval && this.config.knowledge.guidance.enabled;
    const ragEnabled = invocationRetrieval && this.config.workflow.rag;
    const repositoryWanted =
      invocationRetrieval &&
      this.config.knowledge.repositoryIntelligence.enabled &&
      this.config.knowledge.repositoryIntelligence.roles.includes(input.role);
    let guidancePack: Awaited<ReturnType<LocalKnowledgeBase["compileRoleGuidancePack"]>> = {
      text: "",
      sources: [],
      selected: [],
      missingAssignments: [],
      omittedOverrides: [],
    };
    let retrieval: Awaited<ReturnType<LocalKnowledgeBase["searchWithAudit"]>> = {
      results: [],
      audit: {
        query: "",
        repository: {
          shapedQuery: "",
          usedFallback: false,
          included: false,
          skippedReason: "retrieval-disabled",
          attempts: [],
        },
        kept: [],
        omitted: [],
      },
    };

    if (invocationRetrieval) {
      const knowledgeQuery = input.knowledgeQuery;
      if (!knowledgeQuery?.trim()) {
        throw new Error(`knowledgeQuery is required when retrieval is enabled for role ${input.role}`);
      }
      const knowledgeFallbackQuery = input.knowledgeFallbackQuery;
      const pathHints = knownPaths(input.input);
      const contextLimit = WORKER_RETRIEVAL_ROLES.has(input.role)
        ? Math.min(this.config.workflow.contextResults, 4)
        : this.config.workflow.contextResults;
      const emptyRetrieval = (): typeof retrieval => ({
        results: [],
        audit: {
          query: knowledgeQuery,
          fallbackQuery: knowledgeFallbackQuery,
          repository: {
            shapedQuery: "",
            usedFallback: false,
            included: false,
            skippedReason: repositoryWanted ? "not-requested" : "disabled",
            attempts: [],
          },
          kept: [],
          omitted: [],
          skipped: "rag-disabled",
        },
      });
      [guidancePack, retrieval] = await Promise.all([
        guidanceEnabled
          ? this.knowledge.compileRoleGuidancePack(input.role, {
              assignment: this.config.knowledge.guidance.assignments?.[input.role],
              runId: input.runId,
            })
          : Promise.resolve({
              text: "",
              sources: [],
              selected: [],
              missingAssignments: [],
              omittedOverrides: [],
            }),
        ragEnabled || repositoryWanted
          ? this.knowledge.searchWithAudit(knowledgeQuery, contextLimit, {
              repository: repositoryWanted,
              documents: ragEnabled,
              runId: input.runId,
              fallbackQuery: knowledgeFallbackQuery,
              pathHints,
            })
          : Promise.resolve(emptyRetrieval()),
      ]);
    } else {
      retrieval = {
        results: [],
        audit: {
          query: "",
          repository: {
            shapedQuery: "",
            usedFallback: false,
            included: false,
            skippedReason: "retrieval-disabled",
            attempts: [],
          },
          kept: [],
          omitted: [],
          skipped: "retrieval-disabled",
        },
      };
    }

    const assignment = this.config.knowledge.guidance.assignments?.[input.role];
    const domainArtifacts = assignment?.skills.includes("domain-modeling")
      ? await discoverDomainArtifacts(this.workspaceRoot)
      : undefined;

    const { packet, budgetAudit } = buildWorkPacket({
      invocationId,
      runId: input.runId,
      role: input.role,
      objective: input.objective,
      constraints: input.constraints ?? [],
      input: input.input,
      guidance: guidancePack.selected,
      guidancePack: guidancePack.text,
      retrievalResults: retrieval.results,
      priorArtifacts: input.priorArtifacts ?? [],
      expectedOutput: input.expectedOutput,
      createdAt: new Date().toISOString(),
      budgets: {
        contextCharacters: this.config.workflow.contextCharacters,
        inputCharacters: this.config.workflow.inputCharacters,
        repositoryContextCharacters: this.config.workflow.repositoryContextCharacters,
      },
      domainArtifacts,
    });
    const guidanceFingerprint = fingerprintGuidance(packet.guidance);
    const packetPath = `packets/${invocationId}.json`;
    await this.store.writeJson(input.runId, packetPath, packet);
    await this.store.writeJson(input.runId, `packets/${invocationId}.guidance.json`, {
      sources: guidancePack.sources,
      missingAssignments: guidancePack.missingAssignments,
      omittedOverrides: guidancePack.omittedOverrides,
      ...(guidancePack.truncated ? { truncated: guidancePack.truncated } : {}),
    });
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
          ? renderContinuationPrompt(packet, {
              includeGuidance,
              deltaInput: input.continuationInput,
            })
          : undefined,
        retainProviderSession: episode.retainProviderSession,
        mode: episode.mode,
        allowTools: input.allowTools,
        signal: input.signal,
        causal: input.causal,
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
      allowTools?: boolean;
      signal?: AbortSignal;
      causal?: CausalMeta;
    } = {},
  ): Promise<AgentInvocation<T>> {
    let prompt = initialPrompt;
    let continuationPrompt = options.continuationPrompt;
    let providerSessionId = options.providerSessionId;
    let lastError: unknown;
    let completed = false;
    const observedToolNames = new Set<string>();
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
        const causalFields = causalFieldsForAttempt(options.causal, {
          role,
          attempt,
          providerSessionId,
          providerSessionReused: Boolean(providerSessionId && (continuationPrompt || attempt > 0)),
        });
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
          ...causalFields,
        });

        const activity = createSessionActivityTracker(this.store, runId, {
          sessionId,
          role,
          model,
          startedAt,
        });
        await activity.writeNow();

        let result: AgentBackendResult;
        try {
          this.assertIsolationBoundary();
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
                allowTools: options.allowTools,
                sandboxEnabled: this.config.agent.sandbox,
                cwd: this.workspaceRoot,
                signal,
                taskId,
                onStep: (step) => {
                  if (step.toolName) observedToolNames.add(step.toolName);
                  void activity.recordStep(step);
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
            options.signal,
          );
          await activity.flush();
        } catch (error) {
          await activity.flush();
          await activity.clear();
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
            error: error instanceof Error ? error.message : String(error),
            ...causalFieldsForAttempt(options.causal, {
              role,
              attempt,
              providerSessionId,
              providerSessionReused: failure.providerSessionReused,
            }),
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
            ...causalFieldsForAttempt(options.causal, {
              role,
              attempt,
              providerSessionId,
              providerSessionReused: result.providerSessionReused,
            }),
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
        const outcome = outcomeFromParsedOutput(role, parsed);
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
          ...(outcome ? { outcome } : {}),
          handoff: {
            summary:
              typeof parsed === "object" && parsed && "summary" in parsed
                ? String((parsed as { summary: unknown }).summary)
                : `${role} completed`,
            artifactRefs: [packetPath, `sessions/${sessionId}.json`],
          },
          ...causalFieldsForAttempt(options.causal, {
            role,
            attempt,
            providerSessionId,
            providerSessionReused: result.providerSessionReused,
          }),
        });
        completed = true;
        return {
          value: parsed,
          providerSessionId,
          providerRunId: result.providerRunId,
          providerSessionReused: result.providerSessionReused ?? false,
          providerTurns: attempt + 1,
          observedToolNames: [...observedToolNames],
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

function causalFieldsForAttempt(
  causal: CausalMeta | undefined,
  args: {
    role: AgentRole;
    attempt: number;
    providerSessionId?: string;
    providerSessionReused?: boolean;
  },
): {
  taskId?: string;
  phase?: RunPhase;
  taskStep?: string;
  invocationKind: InvocationKind;
  trigger: InvocationTrigger;
} {
  // Only mark continuation when the provider context was actually reused.
  // A freshly spawned context always gets a providerSessionId after the call;
  // that alone must not count as reuse.
  const invocationKind: InvocationKind =
    args.attempt > 0
      ? "schema-repair"
      : causal?.invocationKind ??
        (args.providerSessionReused ? "continuation" : "initial");
  const trigger: InvocationTrigger = causal?.trigger ?? {
    event: `${args.role}.invoke`,
    classification: invocationKind,
    summary:
      invocationKind === "schema-repair"
        ? "schema repair within the same logical invocation"
        : invocationKind === "continuation"
          ? "continued provider context"
          : `initial ${args.role} invocation`,
  };
  return {
    ...(causal?.taskId ? { taskId: causal.taskId } : {}),
    ...(causal?.phase ? { phase: causal.phase } : {}),
    ...(causal?.taskStep ? { taskStep: causal.taskStep } : {}),
    invocationKind,
    trigger,
  };
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
      if (
        [
          "affectedPaths",
          "changedFiles",
          "testPaths",
          "protectedTestPaths",
          "existingTestPaths",
          "omittedFiles",
          "diffOmittedFiles",
        ].includes(key) && Array.isArray(nested)
      ) {
        values.push(...nested.filter((item): item is string => typeof item === "string"));
      } else if (key === "path" && typeof nested === "string") {
        values.push(nested);
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
