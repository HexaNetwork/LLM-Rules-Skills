import { access, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { hostname as localHostname } from "node:os";
import path from "node:path";
import {
  CONFIG_VERSION,
  HarnessConfigSchema,
  type HarnessConfig,
  type PreflightCommitOrder,
} from "./config.js";
import {
  AgentCoordinator,
  reportedTotal,
  type AgentBackend,
  type InvokeInput,
} from "./agent.js";
import { commandEvidence, recentEvidenceOutput, runCommand } from "./commands.js";
import {
  GRILL_EXPECTED_OUTPUT,
  GrillOutputSchema,
  MessageOutputSchema,
  REFLECT_EXPECTED_OUTPUT,
  ReflectOutputSchema,
  PlannerOutputSchema,
  ReviewOutputSchema,
  WorkerOutputSchema,
  createRunState,
  formatReflectRestatement,
  seedUnknownsFromReflect,
  type BuildTask,
  type GrillEpisode,
  type GrillOutput,
  type GrillResolution,
  type HumanQuestionDraft,
  type MessageOutput,
  type OpenUnknown,
  type OpenUnknownDraft,
  type OperatorNote,
  type QuestionPurpose,
  type ReflectOutput,
  type RunPhase,
  type RunState,
} from "./domain.js";
import { classifyFailure, HarnessFailure, RunCancelledError } from "./errors.js";
import { GitService } from "./git.js";
import {
  GraphifyRepositoryLookup,
  prepareGraphifyForRun,
  runGraphify,
  type GraphifyRunner,
  type GraphifySetupRunner,
} from "./graphify.js";
import { LocalKnowledgeBase, compactDomainSeed, matchesGlob } from "./knowledge.js";
import { RunStore } from "./store.js";
import { LocalTracker, assertAcyclic, taskFrontier, type TrackerPort } from "./tracker.js";

export type HarnessDependencies = {
  backend: AgentBackend;
  tracker?: TrackerPort;
  store?: RunStore;
  knowledge?: LocalKnowledgeBase;
  git?: GitService;
  graphifyRunner?: GraphifyRunner;
  graphifySetupRunner?: GraphifySetupRunner;
  /** Test seam for provider-retry backoff; defaults to real wall-clock sleep. */
  sleep?: (ms: number) => Promise<void>;
};

const PROVIDER_RETRY_BACKOFF_MS = [1_000, 4_000, 16_000] as const;
const CANCEL_LOCK_WAIT_MS = 5_000;

/**
 * Process-wide: the UI constructs a fresh HarnessEngine per request, but cancel
 * must still abort an in-flight advance in the same Node process.
 */
const activeRuns = new Map<string, AbortController>();

type StepResult = { state: RunState; consumedBudget: boolean };

export type CancelResult = {
  state: RunState;
  pending: boolean;
};

/** `committedBranch` is where the commit landed (audit only); `runBranch` is set only when the order actually produced the run's branch. */
type PreflightCommitResult = {
  committedBranch?: string;
  runBranch?: string;
  sha: string;
  files: string[];
};

export class HarnessEngine {
  readonly store: RunStore;
  readonly knowledge: LocalKnowledgeBase;
  readonly tracker: TrackerPort;
  readonly git: GitService;
  readonly agents: AgentCoordinator;
  private readonly graphifyRunner: GraphifyRunner;
  private readonly graphifySetupRunner?: GraphifySetupRunner;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    readonly config: HarnessConfig,
    dependencies: HarnessDependencies,
  ) {
    this.store = dependencies.store ?? new RunStore(config);
    this.graphifyRunner = dependencies.graphifyRunner ?? runGraphify;
    this.graphifySetupRunner = dependencies.graphifySetupRunner;
    this.knowledge =
      dependencies.knowledge ??
      new LocalKnowledgeBase(
        config,
        new GraphifyRepositoryLookup(config, this.graphifyRunner),
      );
    this.tracker = dependencies.tracker ?? new LocalTracker(this.store);
    this.git = dependencies.git ?? new GitService(config);
    this.agents = new AgentCoordinator(config, dependencies.backend, this.store, this.knowledge);
    this.sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private signalFor(runId: string): AbortSignal | undefined {
    return activeRuns.get(runId)?.signal;
  }

  private cancelRequestPath(runId: string): string {
    return path.join(this.store.runDirectory(runId), "cancel.request");
  }

  private async writeCancelRequest(runId: string): Promise<void> {
    await writeFile(
      this.cancelRequestPath(runId),
      JSON.stringify({
        at: new Date().toISOString(),
        by: `${localHostname()}:${process.pid}`,
      }),
      "utf8",
    );
  }

  private async clearCancelRequest(runId: string): Promise<void> {
    await unlink(this.cancelRequestPath(runId)).catch(() => undefined);
  }

  private async cancelRequestPresent(runId: string): Promise<boolean> {
    try {
      await access(this.cancelRequestPath(runId));
      return true;
    } catch {
      return false;
    }
  }

  private async isCancelRequested(runId: string): Promise<boolean> {
    if (this.signalFor(runId)?.aborted) return true;
    return this.cancelRequestPresent(runId);
  }

  private async completeCancellation(state: RunState): Promise<RunState> {
    if (terminal(state.phase)) {
      await this.clearCancelRequest(state.runId);
      return state;
    }
    const withoutSessions = await this.releaseAllImplementerSessions({
      ...state,
      phase: "cancelled",
    });
    const cancelled = await this.closeGrillEpisode(withoutSessions);
    const recorded = await this.store.record(cancelled, "run.cancelled");
    await this.clearCancelRequest(state.runId);
    return recorded;
  }

  async start(
    idea: string,
    runId: string = randomUUID(),
    refreshKnowledge = true,
    prepareGraphify = true,
  ): Promise<RunState> {
    if (!idea.trim()) throw new Error("Idea cannot be empty");
    await this.store.initialize();
    let state = createRunState(
      runId,
      idea,
      new Date().toISOString(),
      configurationHash(this.config),
      CONFIG_VERSION,
    );
    await this.store.create(state);
    await this.store.writeJson(runId, "config.json", {
      ...this.config,
      configVersion: CONFIG_VERSION,
    });
    state = await this.store.record(state, "run.created", { idea: idea.trim() });
    // Lock ordering: repository → run, always (avoid deadlock with paths that take both).
    await this.store.withRepositoryLock({ runId, action: "start" }, async () => {
      try {
        // Same changedFiles() source ensureRunBranch guards later; fail before burning a run.
        if (this.config.git.enabled) {
          const dirty = await this.git.changedFiles();
          if (dirty.length > 0) {
            if (!this.config.git.autoCommitPreflight) {
              throw new HarnessFailure(dirtyTreeMessage(dirty), "workspace", true);
            }
            const order = this.config.git.preflightCommitOrder;
            const commit = await this.runPreflightCommit(runId, order, defaultPreflightCommitMessage(runId));
            state = await this.store.record(
              {
                ...state,
                branchName: commit.runBranch ?? state.branchName,
                treeFingerprint: await this.git.treeFingerprint(),
              },
              "run.preflight_committed",
              preflightCommitDetail(order, commit, true),
            );
          }
        }
        if (prepareGraphify && this.config.knowledge.graphify.enabled) {
          if (this.graphifySetupRunner) {
            await prepareGraphifyForRun(
              this.config,
              this.graphifyRunner,
              this.graphifySetupRunner,
            );
          } else {
            await prepareGraphifyForRun(this.config, this.graphifyRunner);
          }
        }
        if (refreshKnowledge) await this.knowledge.refresh();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const classified = classifyFailure(error);
        state = await this.store.record(
          {
            ...state,
            phase: "blocked",
            blockedFrom: "new",
            failure: message,
            blockedKind: classified.kind,
            blockedRetriable: classified.retriable,
          },
          "run.blocked",
          {
            blockedFrom: "new",
            error: message,
            blockedKind: classified.kind,
            blockedRetriable: classified.retriable,
          },
        );
      }
    });
    await this.syncArtifacts(state);
    return state;
  }

  async advance(runId: string, maxSteps = this.config.workflow.maxStepsPerRun): Promise<RunState> {
    const controller = new AbortController();
    activeRuns.set(runId, controller);
    let state: RunState;
    try {
      // Lock ordering: repository → run, always (avoid deadlock with paths that take both).
      state = await this.store.withRepositoryLock({ runId, action: "advance" }, async () => {
        return this.store.withLock(runId, async () => {
          let state = await this.store.load(runId);
          try {
            state = await this.ensureCompatibleConfiguration(state);
            if (!(terminal(state.phase) || state.phase === "awaiting_input")) {
              if (await this.isCancelRequested(runId)) {
                state = await this.completeCancellation(state);
              } else {
                if (state.yieldedAt) {
                  state = await this.store.record({ ...state, yieldedAt: undefined }, "run.resumed");
                }
                await this.assertTreeFingerprint(state);
                let remaining = maxSteps;
                let iterations = 0;
                const maxIterations = Math.max(maxSteps * 8, 40);
                while (remaining > 0 && iterations < maxIterations) {
                  iterations += 1;
                  if (await this.isCancelRequested(runId)) {
                    state = await this.completeCancellation(state);
                    break;
                  }
                  // Enforce spend ceilings between steps only — never abort mid-step.
                  state = await this.accrueUsage(state);
                  this.assertWithinBudget(state);
                  const step = await this.advanceOneWithProviderRetry(state);
                  state = step.state;
                  await this.syncArtifacts(state);
                  if (step.consumedBudget) {
                    remaining -= 1;
                    state = await this.accrueUsage(state);
                  }
                  if (await this.isCancelRequested(runId)) {
                    state = await this.completeCancellation(state);
                    break;
                  }
                  if (terminal(state.phase) || state.phase === "awaiting_input") {
                    state = await this.accrueUsage(state);
                    break;
                  }
                }
                // Step budget exhausted — yield only when cancel has not already won.
                if (
                  !terminal(state.phase) &&
                  state.phase !== "awaiting_input" &&
                  !(await this.isCancelRequested(runId))
                ) {
                  state = await this.accrueUsage(state);
                  state = await this.store.record(
                    { ...state, yieldedAt: new Date().toISOString() },
                    "run.yielded",
                    { maxSteps },
                  );
                }
              }
            }
          } catch (error) {
            state = await this.store.load(runId).catch(() => state);
            if (
              error instanceof RunCancelledError ||
              (await this.isCancelRequested(runId))
            ) {
              state = await this.completeCancellation(state);
              await this.syncArtifacts(state);
            } else {
              const message = error instanceof Error ? error.message : String(error);
              const classified = classifyFailure(error);
              // Keep the latest accrued usage on the blocked snapshot when available.
              state = await this.accrueUsage(state).catch(() => state);
              const blockedFrom =
                state.phase === "blocked" ? (state.blockedFrom ?? state.phase) : state.phase;
              state = await this.store.record(
                {
                  ...state,
                  phase: "blocked",
                  blockedFrom,
                  failure: message,
                  blockedKind: classified.kind,
                  blockedRetriable: classified.retriable,
                },
                "run.blocked",
                {
                  blockedFrom,
                  error: message,
                  blockedKind: classified.kind,
                  blockedRetriable: classified.retriable,
                },
              );
              await this.syncArtifacts(state);
            }
          }
          // Drain cancel before releasing the run lock. Covers cancel after the last
          // post-step check (yield / awaiting_input / terminal) so cancel.request cannot
          // outlive the advancing process while the UI stays on "Cancelling…".
          if (await this.isCancelRequested(runId)) {
            state = await this.completeCancellation(state);
          }
          return state;
        });
      });
    } finally {
      activeRuns.delete(runId);
    }
    // Cancel may race in after the in-lock drain but before activeRuns was cleared
    // (cancel short-circuits to pending while a controller exists). Finish it now.
    if (await this.cancelRequestPresent(runId)) {
      const locked = await this.store.tryWithLock(runId, CANCEL_LOCK_WAIT_MS, async () => {
        const current = await this.store.load(runId);
        return this.completeCancellation(current);
      });
      if (locked.acquired) {
        state = locked.value;
      }
    }
    return state;
  }

  /**
   * Recompute run usage from sessions/*.json and replace state.usage.
   * Idempotent: reading the same files twice yields the same totals.
   */
  async accrueUsage(state: RunState): Promise<RunState> {
    const files = await this.store.listFiles(state.runId, "sessions");
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let totalTokens = 0;
    let costUsd = 0;
    let costIsLowerBound = false;
    let sessionsRead = 0;
    let invocations = 0;

    for (const file of files) {
      let session: {
        model?: string;
        usage?: {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
          totalTokens?: number;
        };
      };
      try {
        session = (await this.store.readJson(state.runId, file)) as typeof session;
      } catch {
        // Concurrently-written or partial files must not fail accrual.
        continue;
      }
      sessionsRead += 1;
      invocations += 1;
      const usage = session.usage ?? {};
      const input = Number(usage.inputTokens ?? 0);
      const output = Number(usage.outputTokens ?? 0);
      const cacheRead = Number(usage.cacheReadTokens ?? 0);
      const cacheWrite = Number(usage.cacheWriteTokens ?? 0);
      const total = reportedTotal(usage) ?? 0;
      inputTokens += input;
      outputTokens += output;
      cacheReadTokens += cacheRead;
      cacheWriteTokens += cacheWrite;
      totalTokens += total;

      const model = typeof session.model === "string" ? session.model : "";
      const pricing = model ? this.config.models.pricing[model] : undefined;
      if (!pricing) {
        if (input > 0 || output > 0 || total > 0) costIsLowerBound = true;
        continue;
      }
      costUsd +=
        (input / 1_000_000) * pricing.inputPerMillion +
        (output / 1_000_000) * pricing.outputPerMillion +
        (cacheRead / 1_000_000) * pricing.cacheReadPerMillion +
        (cacheWrite / 1_000_000) * pricing.cacheWritePerMillion;
    }

    const nextUsage = {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens,
      costUsd,
      costIsLowerBound,
      invocations,
      sessionsRead,
    };
    if (
      state.usage.inputTokens === nextUsage.inputTokens &&
      state.usage.outputTokens === nextUsage.outputTokens &&
      state.usage.cacheReadTokens === nextUsage.cacheReadTokens &&
      state.usage.cacheWriteTokens === nextUsage.cacheWriteTokens &&
      state.usage.totalTokens === nextUsage.totalTokens &&
      state.usage.costUsd === nextUsage.costUsd &&
      state.usage.costIsLowerBound === nextUsage.costIsLowerBound &&
      state.usage.invocations === nextUsage.invocations &&
      state.usage.sessionsRead === nextUsage.sessionsRead
    ) {
      return state;
    }
    return this.store.writeState({ ...state, usage: nextUsage });
  }

  /** Throw a non-retriable budget failure when a configured ceiling is exceeded. */
  private assertWithinBudget(state: RunState): void {
    const { maxRunTokens, maxRunCostUsd } = this.config.workflow;
    if (maxRunTokens > 0 && state.usage.totalTokens > maxRunTokens) {
      throw new HarnessFailure(
        `Run exceeded maxRunTokens: observed ${state.usage.totalTokens} > limit ${maxRunTokens}`,
        "budget",
        false,
      );
    }
    if (maxRunCostUsd > 0 && state.usage.costUsd > maxRunCostUsd) {
      throw new HarnessFailure(
        `Run exceeded maxRunCostUsd: observed ${state.usage.costUsd} > limit ${maxRunCostUsd}`,
        "budget",
        false,
      );
    }
  }

  private async ensureCompatibleConfiguration(state: RunState): Promise<RunState> {
    if (state.configVersion < CONFIG_VERSION) {
      // Re-stamp the hash before any comparison so additive config defaults
      // from a CONFIG_VERSION bump do not permanently block existing runs.
      return this.store.record(
        {
          ...state,
          configVersion: CONFIG_VERSION,
          configurationHash: configurationHash(this.config),
        },
        "run.config_migrated",
        { from: state.configVersion, to: CONFIG_VERSION },
      );
    }
    if (state.configVersion > CONFIG_VERSION) {
      throw new HarnessFailure(
        `Run configVersion ${state.configVersion} is newer than harness ${CONFIG_VERSION}`,
        "config",
        false,
      );
    }
    if (configurationHash(this.config) !== state.configurationHash) {
      throw new HarnessFailure(
        "Run configuration changed; resume with the persisted run config",
        "config",
        false,
      );
    }
    return state;
  }

  /** Single-question path; delegates to the batch-aware answerMany. */
  async answer(
    runId: string,
    questionId: string,
    answer: string,
    structured?: ReflectOutput,
  ): Promise<RunState> {
    return this.answerMany(runId, [{ questionId, answer, structured }]);
  }

  /**
   * Answers and/or parks a batch of open questions in one state transition.
   * Staleness is computed once per batch (shared askedAt), not per question.
   */
  async answerMany(
    runId: string,
    answers: Array<{
      questionId: string;
      answer: string;
      optionId?: string;
      structured?: ReflectOutput;
    }> = [],
    parkedQuestionIds: string[] = [],
  ): Promise<RunState> {
    if (answers.length === 0 && parkedQuestionIds.length === 0) {
      throw new Error("At least one answer or parked question id is required");
    }
    for (const entry of answers) {
      if (!entry.answer.trim()) throw new Error(`Answer for ${entry.questionId} cannot be empty`);
    }
    return this.store.withLock(runId, async () => {
      let state = await this.store.load(runId);
      const now = new Date().toISOString();
      const byId = new Map(state.questions.map((item) => [item.id, item] as const));

      for (const entry of answers) {
        const question = byId.get(entry.questionId);
        if (!question || question.status !== "open") {
          throw new Error(`Question ${entry.questionId} is not open`);
        }
      }
      for (const id of parkedQuestionIds) {
        const question = byId.get(id);
        if (!question || question.status !== "open") throw new Error(`Question ${id} is not open`);
      }

      const reflectEntry = answers.find((entry) => byId.get(entry.questionId)?.purpose === "reflect");
      if (reflectEntry) {
        // Reflect always asks a single confirmable question; never batched with grill.
        if (answers.length !== 1 || parkedQuestionIds.length !== 0) {
          throw new Error("The reflect confirmation must be answered on its own");
        }
        const trimmed = reflectEntry.answer.trim();
        const questions = state.questions.map((item) =>
          item.id === reflectEntry.questionId
            ? { ...item, status: "answered" as const, answer: trimmed, answeredAt: now }
            : item,
        );
        const structured = reflectEntry.structured;
        const confirmed = structured ? formatReflectRestatement(structured) : trimmed;
        state = await this.store.record(
          {
            ...state,
            questions,
            activeQuestionId: undefined,
            reflectBrief: {
              draft: state.reflectBrief?.draft ?? trimmed,
              structured: state.reflectBrief?.structured,
              confirmed,
              confirmedStructured: structured ?? state.reflectBrief?.confirmedStructured,
              confirmedAt: now,
            },
            phase: "grilling",
          },
          "reflect.confirmed",
          { questionId: reflectEntry.questionId },
        );
        await this.syncArtifacts(state);
        return state;
      }

      const answerById = new Map(answers.map((entry) => [entry.questionId, entry] as const));
      const parkedIds = new Set(parkedQuestionIds);
      const questions = state.questions.map((item) => {
        const entry = answerById.get(item.id);
        if (entry) {
          return {
            ...item,
            status: "answered" as const,
            answer: entry.answer.trim(),
            answerOptionId: entry.optionId,
            answeredAt: now,
          };
        }
        if (parkedIds.has(item.id)) {
          return { ...item, status: "parked" as const, answeredAt: now };
        }
        return item;
      });

      const touchedBatchIds = new Set(
        [...answerById.keys(), ...parkedIds]
          .map((id) => byId.get(id)?.batchId)
          .filter((id): id is string => Boolean(id)),
      );
      const staleMs = this.config.workflow.staleAnswerMinutes * 60_000;
      let stale = false;
      for (const batchId of touchedBatchIds) {
        const batchQuestion = state.questions.find((item) => item.batchId === batchId);
        const askedAt = batchQuestion ? Date.parse(batchQuestion.askedAt) : NaN;
        if (Number.isFinite(askedAt) && Date.parse(now) - askedAt > staleMs) stale = true;
      }

      state = await this.store.record(
        { ...state, questions, activeQuestionId: undefined, phase: "grilling" },
        "question.answered",
        { questionIds: [...answerById.keys(), ...parkedIds], stale },
      );

      if (stale) {
        state = await this.closeGrillEpisode(state, "grill.episode_stale_reset");
      }

      await this.syncArtifacts(state);
      return state;
    });
  }

  /** Records unprompted human input mid-grill for the next griller turn. */
  async addNote(runId: string, text: string, asUnknown = false): Promise<RunState> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("Note text cannot be empty");
    return this.store.withLock(runId, async () => {
      let state = await this.store.load(runId);
      const now = new Date().toISOString();
      const note: OperatorNote = {
        id: `note-${randomUUID()}`,
        text: trimmed,
        title: asUnknown ? trimmed.slice(0, 160) : undefined,
        at: now,
      };
      const openUnknowns: OpenUnknown[] = asUnknown
        ? [
            ...state.openUnknowns,
            {
              id: `unknown-note-${randomUUID()}`,
              title: trimmed.slice(0, 160),
              whyItMatters: "Raised by an operator note.",
              impact: "shaping",
              status: "fog",
            },
          ]
        : state.openUnknowns;
      state = await this.store.record(
        { ...state, operatorNotes: [...state.operatorNotes, note], openUnknowns },
        "operator.note_added",
        { noteId: note.id, asUnknown },
      );
      await this.syncArtifacts(state);
      return state;
    });
  }

  async retry(
    runId: string,
    options?: { force?: boolean; maxRunTokens?: number; maxRunCostUsd?: number },
  ): Promise<RunState> {
    return this.store.withLock(runId, async () => {
      let state = await this.store.load(runId);
      if (state.phase !== "blocked" || !state.blockedFrom) {
        throw new Error(`Run ${runId} is not resumably blocked`);
      }
      // Legacy runs without blockedRetriable stay permissive so they are not stranded.
      if (state.blockedRetriable === false && !options?.force) {
        throw new Error(
          `Run ${runId} is blocked with kind "${state.blockedKind ?? "unknown"}" and is not retriable without force`,
        );
      }
      const resumePhase = state.blockedFrom;
      if (options?.maxRunTokens != null || options?.maxRunCostUsd != null) {
        state = await this.raiseRunBudget(state, {
          maxRunTokens: options.maxRunTokens,
          maxRunCostUsd: options.maxRunCostUsd,
        });
      }
      state = await this.store.record(
        {
          ...state,
          phase: resumePhase,
          blockedFrom: undefined,
          failure: undefined,
          blockedKind: undefined,
          blockedRetriable: undefined,
        },
        "run.retry_requested",
        {
          force: Boolean(options?.force),
          ...(options?.maxRunTokens != null ? { maxRunTokens: options.maxRunTokens } : {}),
          ...(options?.maxRunCostUsd != null ? { maxRunCostUsd: options.maxRunCostUsd } : {}),
        },
      );
      return state;
    });
  }

  /**
   * Rewrite maxRunTokens / maxRunCostUsd on the frozen run config snapshot and
   * re-stamp configurationHash so resume does not treat it as config drift.
   */
  private async raiseRunBudget(
    state: RunState,
    ceilings: { maxRunTokens?: number; maxRunCostUsd?: number },
  ): Promise<RunState> {
    if (ceilings.maxRunTokens != null) {
      this.config.workflow.maxRunTokens = ceilings.maxRunTokens;
    }
    if (ceilings.maxRunCostUsd != null) {
      this.config.workflow.maxRunCostUsd = ceilings.maxRunCostUsd;
    }
    // Validate via the same schema that freezes run configs.
    const parsed = HarnessConfigSchema.parse(this.config);
    this.config.workflow.maxRunTokens = parsed.workflow.maxRunTokens;
    this.config.workflow.maxRunCostUsd = parsed.workflow.maxRunCostUsd;

    const raw = (await this.store.readJson(state.runId, "config.json")) as Record<string, unknown>;
    const frozenVersion =
      typeof raw.configVersion === "number" ? raw.configVersion : state.configVersion;
    await this.store.writeJson(state.runId, "config.json", {
      ...this.config,
      configVersion: frozenVersion,
    });
    return {
      ...state,
      configurationHash: configurationHash(this.config),
    };
  }

  /**
   * Operator accepts the current working tree after a divergence block: re-stamps
   * `treeFingerprint`, clears the block, and audits `run.tree_accepted`.
   */
  async acceptTree(runId: string): Promise<RunState> {
    return this.store.withRepositoryLock({ runId, action: "acceptTree" }, async () =>
      this.store.withLock(runId, async () => {
        let state = await this.store.load(runId);
        if (state.phase !== "blocked" || !state.blockedFrom) {
          throw new Error(`Run ${runId} is not resumably blocked`);
        }
        const previousFingerprint = state.treeFingerprint;
        const recorded = new Set(state.tasks.flatMap((task) => task.changedFiles));
        const current = this.config.git.enabled ? await this.git.changedFiles() : [];
        const divergingPaths = current.filter((file) => !recorded.has(file));
        const listed = divergingPaths.length > 0 ? divergingPaths : current;
        const treeFingerprint = await this.git.treeFingerprint();
        state = await this.store.record(
          {
            ...state,
            phase: state.blockedFrom,
            blockedFrom: undefined,
            failure: undefined,
            blockedKind: undefined,
            blockedRetriable: undefined,
            treeFingerprint,
          },
          "run.tree_accepted",
          {
            previousFingerprint,
            treeFingerprint,
            divergingPaths: listed,
          },
        );
        return state;
      }),
    );
  }

  /** Resolves a dirty tree the harness itself found by committing it, then clears the block like retry(). */
  async commitPreflight(
    runId: string,
    options?: { order?: PreflightCommitOrder; message?: string },
  ): Promise<RunState> {
    // Lock ordering: repository → run (mutates the shared working tree).
    return this.store.withRepositoryLock({ runId, action: "commitPreflight" }, async () =>
      this.store.withLock(runId, async () => {
        let state = await this.store.load(runId);
        if (state.phase !== "blocked" || !state.blockedFrom) {
          throw new Error(`Run ${runId} is not resumably blocked`);
        }
        const order = options?.order ?? this.config.git.preflightCommitOrder;
        const message = options?.message ?? defaultPreflightCommitMessage(runId);
        const commit = await this.runPreflightCommit(runId, order, message);
        state = await this.store.record(
          {
            ...state,
            phase: state.blockedFrom,
            blockedFrom: undefined,
            failure: undefined,
            blockedKind: undefined,
            blockedRetriable: undefined,
            branchName: commit.runBranch ?? state.branchName,
            treeFingerprint: await this.git.treeFingerprint(),
          },
          "run.preflight_committed",
          preflightCommitDetail(order, commit, false),
        );
        return state;
      }),
    );
  }

  private async runPreflightCommit(
    runId: string,
    order: PreflightCommitOrder,
    message: string,
  ): Promise<PreflightCommitResult> {
    // branch-then-commit must cut the branch before committing so the dirty tree rides onto it.
    if (order === "branch-then-commit") {
      const runBranch = await this.git.createRunBranchFromHead(runId);
      const result = await this.git.commitWorkingTree(message);
      return { committedBranch: runBranch, runBranch, sha: result.sha, files: result.files };
    }
    const result = await this.git.commitWorkingTree(message);
    // commit-then-branch lands on whatever was checked out; that is an audit
    // fact, not the run branch, so it must not overwrite state.branchName.
    const committedBranch = await this.git.currentBranch();
    return { committedBranch, sha: result.sha, files: result.files };
  }

  async cancel(runId: string): Promise<CancelResult> {
    const current = await this.store.load(runId);
    if (terminal(current.phase)) {
      await this.clearCancelRequest(runId);
      return { state: current, pending: false };
    }

    await this.writeCancelRequest(runId);
    const controller = activeRuns.get(runId);
    controller?.abort();

    // In-process advance owns the lock and will complete the cancelled transition.
    if (controller) {
      return { state: await this.store.load(runId), pending: true };
    }

    const locked = await this.store.tryWithLock(runId, CANCEL_LOCK_WAIT_MS, async () => {
      const state = await this.store.load(runId);
      if (terminal(state.phase)) {
        await this.clearCancelRequest(runId);
        return state;
      }
      return this.completeCancellation(state);
    });
    if (locked.acquired) {
      return { state: locked.value, pending: false };
    }
    return { state: await this.store.load(runId), pending: true };
  }

  status(runId: string): Promise<RunState> {
    return this.store.load(runId);
  }

  /**
   * Retries provider failures in-place with exponential backoff. Retries do not
   * consume maxStepsPerRun — the outer advance loop only counts a successful step.
   */
  private async advanceOneWithProviderRetry(state: RunState): Promise<StepResult> {
    const maxRetries = this.config.workflow.maxProviderRetries;
    let attempt = 0;
    for (;;) {
      try {
        return await this.advanceOne(state);
      } catch (error) {
        if (error instanceof RunCancelledError || (await this.isCancelRequested(state.runId))) {
          throw error instanceof RunCancelledError
            ? error
            : new RunCancelledError("Run cancelled");
        }
        const classified = classifyFailure(error);
        if (classified.kind !== "provider" || !classified.retriable || attempt >= maxRetries) {
          throw error;
        }
        attempt += 1;
        const message = error instanceof Error ? error.message : String(error);
        // Reload before recording — advanceOne may have persisted mid-step progress.
        state = await this.store.load(state.runId);
        state = await this.store.record(state, "run.provider_retry", {
          attempt,
          error: message,
        });
        const delay =
          PROVIDER_RETRY_BACKOFF_MS[attempt - 1] ??
          PROVIDER_RETRY_BACKOFF_MS[PROVIDER_RETRY_BACKOFF_MS.length - 1]!;
        await this.sleepProviderBackoff(delay, state.runId);
      }
    }
  }

  /**
   * Chunk backoff so `<runDir>/cancel.request` and the in-process AbortSignal
   * can short-circuit without waiting the full delay.
   */
  private async sleepProviderBackoff(ms: number, runId: string): Promise<void> {
    const chunkMs = 100;
    let remaining = ms;
    while (remaining > 0) {
      await this.throwIfCancelRequested(runId);
      const slice = Math.min(chunkMs, remaining);
      await this.sleep(slice);
      remaining -= slice;
    }
    await this.throwIfCancelRequested(runId);
  }

  private async throwIfCancelRequested(runId: string): Promise<void> {
    if (await this.isCancelRequested(runId)) {
      throw new RunCancelledError("Run cancellation requested during provider retry backoff");
    }
  }

  private async advanceOne(state: RunState): Promise<StepResult> {
    switch (state.phase) {
      case "new":
      case "reflecting":
        return { state: await this.reflect(state), consumedBudget: true };
      case "grilling":
        return { state: await this.grill(state), consumedBudget: true };
      case "planning":
        return { state: await this.plan(state), consumedBudget: true };
      case "executing":
        return this.execute(state);
      case "publishing":
        return { state: await this.publish(state), consumedBudget: true };
      case "awaiting_input":
      case "completed":
      case "blocked":
      case "cancelled":
        return { state, consumedBudget: false };
    }
  }

  private async reflect(state: RunState): Promise<RunState> {
    if (state.phase !== "reflecting") {
      state = await this.store.record({ ...state, phase: "reflecting" }, "reflect.started");
    }
    const output = await this.agents.invoke({
      runId: state.runId,
      role: "reflector",
      objective: "Restate the feature idea so the operator can confirm shared understanding",
      input: { idea: state.idea },
      expectedOutput: REFLECT_EXPECTED_OUTPUT,
      schema: ReflectOutputSchema,
      knowledgeQuery: state.idea,
      knowledgeFallbackQuery: compactDomainSeed(state.idea),
      buildPrompt: false,
      signal: this.signalFor(state.runId),
    });
    const draft = formatReflectRestatement(output);
    state = await this.store.record(
      {
        ...state,
        reflectBrief: { draft, structured: output },
        openUnknowns: seedUnknownsFromReflect(output.unknowns),
      },
      "reflect.drafted",
      { summary: output.summary },
    );
    return this.askQuestions(state, "reflect", [
      {
        prompt: "Edit and confirm this restatement of the feature before grilling begins.",
        context:
          "Adjust anything that is wrong or incomplete. Confirming sends this exact text into the grill-me session.",
        draftAnswer: draft,
        options: [],
      },
    ]);
  }

  private async grill(state: RunState): Promise<RunState> {
    const brief = state.reflectBrief?.confirmed;
    if (!brief) throw new Error("Cannot grill without a confirmed reflect brief");

    const answeredQuestions = state.questions.filter(
      (question) =>
        question.purpose === "grill" &&
        question.status === "answered" &&
        !state.grillResolutions.some((item) => item.id === question.id),
    );
    const openGrill = state.questions.find(
      (question) => question.purpose === "grill" && question.status === "open",
    );
    if (openGrill) {
      return this.store.record(
        { ...state, activeQuestionId: openGrill.id, phase: "awaiting_input" },
        "question.reopened",
        { questionId: openGrill.id },
      );
    }

    const episodeLimit = this.config.workflow.maxGrillQuestionsPerEpisode;
    const episode = state.grillEpisode;
    if (episode && !episode.closedAt && episode.questionsAnswered >= episodeLimit) {
      state = await this.closeGrillEpisode(state, "grill.episode_rolled");
    }

    // Batch-level staleness already closed the episode (see answerMany), so
    // a cold start here is sufficient.
    const coldStart = !state.grillEpisode || Boolean(state.grillEpisode.closedAt);

    const unconsumedNotes = state.operatorNotes.filter((note) => !note.consumedAt);
    if (unconsumedNotes.length > 0) {
      const consumedAt = new Date().toISOString();
      const consumedIds = new Set(unconsumedNotes.map((note) => note.id));
      state = await this.store.record(
        {
          ...state,
          operatorNotes: state.operatorNotes.map((note) =>
            consumedIds.has(note.id) ? { ...note, consumedAt } : note,
          ),
        },
        "operator.notes_consumed",
        { count: unconsumedNotes.length },
      );
    }

    const questionsPayload =
      answeredQuestions.length > 0
        ? {
            questions: answeredQuestions.map((question) => ({
              prompt: question.prompt,
              context: question.context,
              options: question.options,
              recommendation: question.recommendation,
              unknownId: question.unknownId,
            })),
            answers: answeredQuestions.map((question) => ({
              questionId: question.id,
              answer: question.answer,
              optionId: question.answerOptionId,
            })),
          }
        : {};
    const notesPayload =
      unconsumedNotes.length > 0
        ? { operatorNotes: unconsumedNotes.map((note) => ({ text: note.text, title: note.title })) }
        : {};

    const input = {
      mode: coldStart ? "fresh_episode" : "continue",
      confirmedBrief: brief,
      resolutions: state.grillResolutions,
      openUnknowns: state.openUnknowns,
      ...questionsPayload,
      ...notesPayload,
    };

    const batchCeiling = this.config.workflow.grillQuestionsPerBatch;
    const invocation = await this.invokeGrill(state, {
      runId: state.runId,
      role: "griller",
      objective:
        answeredQuestions.length > 0
          ? "Incorporate the human answers and either ask the next batch of independent grill questions or declare ready to plan"
          : "Begin grilling from the confirmed feature brief; ask the first batch of decision-ready questions",
      input,
      constraints: [
        `Ask at most ${batchCeiling} question(s) this turn, and only if they are mutually independent. This is a ceiling, not a target — prefer fewer, and ask exactly one whenever the next decision forks on its answer.`,
      ],
      expectedOutput: GRILL_EXPECTED_OUTPUT,
      schema: GrillOutputSchema,
      knowledgeQuery: [brief, ...answeredQuestions.map((q) => `${q.prompt} ${q.answer ?? ""}`)]
        .filter(Boolean)
        .join(" "),
      knowledgeFallbackQuery: compactDomainSeed(state.idea, brief),
      forceFresh: Boolean(coldStart),
      signal: this.signalFor(state.runId),
    });
    state = invocation.state;
    const output = invocation.output;

    if (answeredQuestions.length > 0) {
      const now = new Date().toISOString();
      const summaryByQuestionId = new Map(
        output.resolutionSummaries.map((item) => [item.questionId, item.summary]),
      );
      const resolutions: GrillResolution[] = answeredQuestions.map((question) => ({
        id: question.id,
        question: question.prompt,
        answer: question.answer ?? "",
        summary: summaryByQuestionId.get(question.id) ?? output.summary,
        resolvedAt: now,
      }));
      const questionsAnswered = (state.grillEpisode?.questionsAnswered ?? 0) + answeredQuestions.length;
      state = await this.store.record(
        {
          ...state,
          grillResolutions: mergeResolutionLists(state.grillResolutions, resolutions),
          grillEpisode: state.grillEpisode
            ? {
                ...state.grillEpisode,
                questionsAnswered,
                updatedAt: new Date().toISOString(),
              }
            : state.grillEpisode,
        },
        "grill.answers_incorporated",
        { questionIds: answeredQuestions.map((q) => q.id), questionsAnswered },
      );
    }

    // Parked grill questions never produce resolutions; their unknown stays parked (sticky).
    const parkedUnknownIds = state.questions
      .filter((question) => question.purpose === "grill" && question.status === "parked" && question.unknownId)
      .map((question) => question.unknownId!);

    if (output.status === "ready_to_plan") {
      const now = new Date().toISOString();
      const fromOutput = output.resolutions.map((item) => ({
        ...item,
        resolvedAt: now,
      }));
      const closed = await this.closeGrillEpisode({
        ...state,
        grillResolutions: mergeResolutionLists(state.grillResolutions, fromOutput),
        openUnknowns: reconcileUnknowns(
          state.openUnknowns,
          output.openUnknowns,
          new Set(),
          new Set(parkedUnknownIds),
        ),
        phase: "planning",
      });
      return this.store.record(closed, "grill.completed", {
        resolutions: closed.grillResolutions.length,
      });
    }

    if (
      state.grillEpisode &&
      !state.grillEpisode.closedAt &&
      state.grillEpisode.questionsAnswered >= episodeLimit
    ) {
      state = await this.closeGrillEpisode(state, "grill.episode_rolled");
    }

    // Defensive clamp: the configured ceiling may be lower than the schema's hard cap of 6.
    const questions = output.questions.slice(0, batchCeiling);
    const askedUnknownIds = questions
      .map((question) => question.unknownId)
      .filter((id): id is string => Boolean(id));
    const openUnknowns = reconcileUnknowns(
      state.openUnknowns,
      output.openUnknowns,
      new Set(askedUnknownIds),
      new Set(parkedUnknownIds),
    );

    return this.askQuestions(
      { ...state, openUnknowns },
      "grill",
      questions.map((question) => ({ ...question })),
    );
  }

  private async invokeGrill(
    state: RunState,
    input: InvokeInput<GrillOutput> & { forceFresh?: boolean },
  ): Promise<{ state: RunState; output: GrillOutput }> {
    let episode = state.grillEpisode;
    const now = new Date().toISOString();
    if (input.forceFresh || !episode || episode.closedAt) {
      if (episode && !episode.closedAt) {
        await this.agents.releaseProviderSession(episode.providerSessionId).catch(() => undefined);
      }
      const nextNumber = (episode?.number ?? 0) + 1;
      state = await this.store.record(
        {
          ...state,
          grillEpisode: {
            number: nextNumber,
            questionsAnswered: 0,
            startedAt: now,
            updatedAt: now,
          },
        },
        "grill.episode_started",
        { episode: nextNumber, forceFresh: Boolean(input.forceFresh) },
      );
      episode = state.grillEpisode;
    }

    const invocation = await this.agents.invokeInEpisode({
      ...input,
      buildPrompt: false,
      providerSessionId: episode?.providerSessionId,
      previousGuidanceFingerprint: episode?.guidanceFingerprint,
    });
    const updatedAt = new Date().toISOString();
    return {
      state: {
        ...state,
        grillEpisode: {
          number: episode?.number ?? 1,
          providerSessionId: invocation.providerSessionId,
          questionsAnswered: episode?.questionsAnswered ?? 0,
          guidanceFingerprint: invocation.guidanceFingerprint ?? episode?.guidanceFingerprint,
          startedAt: episode?.startedAt ?? updatedAt,
          updatedAt,
        },
      },
      output: invocation.value,
    };
  }

  private async closeGrillEpisode(
    state: RunState,
    event = "grill.episode_closed",
  ): Promise<RunState> {
    const episode = state.grillEpisode;
    if (!episode || episode.closedAt) return state;
    await this.agents.releaseProviderSession(episode.providerSessionId).catch(() => undefined);
    const now = new Date().toISOString();
    const closed: GrillEpisode = {
      ...episode,
      updatedAt: now,
      closedAt: now,
    };
    return this.store.record({ ...state, grillEpisode: closed }, event, {
      episode: episode.number,
      questionsAnswered: episode.questionsAnswered,
    });
  }

  /**
   * Asks a batch of questions in one turn: one shared batchId and askedAt.
   * Reflect always calls this with a single-item array.
   */
  private async askQuestions(
    state: RunState,
    purpose: QuestionPurpose,
    drafts: Array<{
      prompt: string;
      context?: string;
      options?: HumanQuestionDraft["options"];
      recommendedOptionId?: string;
      recommendation?: string;
      draftAnswer?: string;
      unknownId?: string;
    }>,
  ): Promise<RunState> {
    if (drafts.length === 0) throw new Error("At least one question is required");
    const now = new Date().toISOString();
    const batchId = `batch-${randomUUID()}`;
    const newQuestions = drafts.map((details) => ({
      id: `q-${randomUUID()}`,
      purpose,
      prompt: details.prompt,
      context: details.context ?? "",
      options: details.options ?? [],
      recommendedOptionId: details.recommendedOptionId,
      recommendation: details.recommendation,
      draftAnswer: details.draftAnswer,
      unknownId: details.unknownId,
      batchId,
      status: "open" as const,
      askedAt: now,
    }));
    return this.store.record(
      {
        ...state,
        questions: [...state.questions, ...newQuestions],
        activeQuestionId: newQuestions[0]!.id,
        phase: "awaiting_input",
      },
      "question.asked",
      { questionIds: newQuestions.map((q) => q.id), purpose, batchId },
    );
  }

  private async plan(state: RunState): Promise<RunState> {
    const output = await this.agents.invoke({
      runId: state.runId,
      role: "planner",
      objective:
        "Turn the confirmed brief and grill resolutions into dependency-ordered tracer-bullet implementation tickets",
      input: {
        idea: state.idea,
        confirmedBrief: state.reflectBrief?.confirmed,
        resolutions: state.grillResolutions,
        defaultTdd: this.config.workflow.tdd,
        defaultTestCommand: this.config.commands.test,
      },
      expectedOutput:
        "{summary,tasks:[{id,title,description,acceptanceCriteria,affectedPaths?,blockedBy,tdd?,testCommand?}]}",
      schema: PlannerOutputSchema,
      knowledgeQuery: [
        state.reflectBrief?.confirmed ?? state.idea,
        compactDomainSeed(
          state.idea,
          state.reflectBrief?.confirmed,
          ...state.grillResolutions.flatMap((item) => [item.question, item.answer, item.summary]),
        ),
      ]
        .filter(Boolean)
        .join(" "),
      knowledgeFallbackQuery: compactDomainSeed(state.idea, state.reflectBrief?.confirmed),
      signal: this.signalFor(state.runId),
    });
    const tasks = materializeTasks(output, this.config);
    assertAcyclic(tasks);
    const branchName = await this.git.ensureRunBranch(state.runId);
    return this.store.record(
      { ...state, tasks, branchName, phase: "executing" },
      "plan.created",
      { tasks: tasks.length, tdd: tasks.filter((task) => task.tdd).length },
    );
  }

  private async execute(state: RunState): Promise<StepResult> {
    const failed = state.tasks.find((task) => task.status === "failed");
    if (failed) {
      throw new HarnessFailure(
        `Task ${failed.id} failed: ${failed.failure ?? "unknown failure"}`,
        "contract",
        false,
      );
    }
    const active = state.tasks.find((task) => task.status === "active");
    const task = active ?? taskFrontier(state.tasks)[0];
    if (!task) {
      if (state.tasks.every((item) => item.status === "done")) {
        return {
          state: await this.store.record({ ...state, phase: "publishing" }, "implementation.completed"),
          consumedBudget: false,
        };
      }
      throw new HarnessFailure(
        "Build frontier is empty while pending tasks remain",
        "internal",
        false,
      );
    }
    return this.executeTaskStep(state, task);
  }

  private async executeTaskStep(state: RunState, task: BuildTask): Promise<StepResult> {
    switch (task.step) {
      case "pending": {
        const next = {
          ...task,
          status: "active" as const,
          step: task.tdd ? ("writing_tests" as const) : ("implementing" as const),
        };
        return {
          state: await this.updateTask(state, next, "task.started"),
          consumedBudget: false,
        };
      }
      case "writing_tests":
        return { state: await this.writeTests(state, task), consumedBudget: true };
      case "red":
        return {
          state: await this.updateTask(
            state,
            { ...task, step: "implementing" },
            "task.red_confirmed",
          ),
          consumedBudget: false,
        };
      case "implementing":
        return { state: await this.implementTask(state, task), consumedBudget: true };
      case "verifying":
        return { state: await this.verifyTask(state, task), consumedBudget: true };
      case "reviewing":
        return { state: await this.reviewTask(state, task), consumedBudget: true };
      case "committing":
        return { state: await this.commitTask(state, task), consumedBudget: true };
      case "done":
      case "failed":
        return { state, consumedBudget: false };
    }
  }

  private async writeTests(state: RunState, task: BuildTask): Promise<RunState> {
    const result = await this.agents.invoke({
      runId: state.runId,
      role: "test-writer",
      objective: `Write the next failing behavioral test for “${task.title}”`,
      input: {
        task: taskForPacket(task),
        priorCommandOutput: recentEvidenceOutput(task.evidence),
      },
      expectedOutput: "{summary,changedFiles}",
      schema: WorkerOutputSchema,
      constraints: ["Change tests only", "Do not implement production code"],
      knowledgeQuery: [task.title, task.description, ...task.acceptanceCriteria].join(" "),
      knowledgeFallbackQuery: compactDomainSeed(
        state.idea,
        state.reflectBrief?.confirmed,
        task.title,
        task.description,
      ),
      signal: this.signalFor(state.runId),
    });
    const observedPaths = this.config.git.enabled ? await this.git.changedFiles() : result.changedFiles;
    const testPatterns = this.config.workflow.testPathPatterns;
    const illegal = observedPaths.filter((file) => !isTestPath(file, testPatterns));
    if (illegal.length > 0) {
      throw new Error(`Test writer changed non-test paths: ${illegal.join(", ")}`);
    }
    const evidence = await this.runTargetedTest(state.runId, task, "tdd:red");
    const attempts = { ...task.attempts, tests: task.attempts.tests + 1 };
    const meaningfulRed =
      evidence.exitCode !== 0 &&
      evidence.exitCode !== 124 &&
      !/no tests found|no test files found|command not found|not recognized/i.test(
        `${evidence.stdout}\n${evidence.stderr}`,
      );
    const exhausted = !meaningfulRed && attempts.tests >= this.config.workflow.maxTestAttempts;
    const updated: BuildTask = {
      ...task,
      attempts,
      testPaths: unique([
        ...task.testPaths,
        ...observedPaths.filter((file) => isTestPath(file, testPatterns)),
      ]),
      changedFiles: unique([...task.changedFiles, ...result.changedFiles]),
      evidence: [...task.evidence, evidence],
      step: meaningfulRed ? "red" : exhausted ? "failed" : "writing_tests",
      status: exhausted ? "failed" : "active",
      failure: exhausted ? "Test writer could not produce a meaningful RED run" : undefined,
    };
    return this.updateTask(
      await this.withTreeFingerprint(state),
      updated,
      meaningfulRed ? "task.red_observed" : "task.red_rejected",
    );
  }

  private async implementTask(state: RunState, task: BuildTask): Promise<RunState> {
    if (task.tdd && task.attempts.implementation > 0) {
      const recovery = await this.runTargetedTest(state.runId, task, "tdd:resume-check");
      if (recovery.passed) {
        return this.updateTask(
          await this.withTreeFingerprint(state),
          { ...task, evidence: [...task.evidence, recovery], step: "verifying" },
          "task.recovered_green",
        );
      }
      task = { ...task, evidence: [...task.evidence, recovery] };
      state = await this.updateTask(await this.withTreeFingerprint(state), task, "task.resume_check_failed");
    }
    const episode = task.implementerSession;
    const invocation = await this.agents.invokeInEpisode({
      runId: state.runId,
      role: "implementer",
      mode: "agent",
      objective: `Implement or repair the behavior in “${task.title}”`,
      input: {
        task: taskForPacket(task),
        verifiedCommandOutput: recentEvidenceOutput(task.evidence),
        reviewFeedback: task.reviewSummary,
      },
      expectedOutput: "{summary,changedFiles}",
      schema: WorkerOutputSchema,
      constraints: ["Do not commit", "Do not weaken tests", "Stop after this one task"],
      knowledgeQuery: [task.title, task.description, ...task.acceptanceCriteria].join(" "),
      knowledgeFallbackQuery: compactDomainSeed(
        state.idea,
        state.reflectBrief?.confirmed,
        task.title,
        task.description,
      ),
      providerSessionId: episode?.providerSessionId,
      previousGuidanceFingerprint: episode?.guidanceFingerprint,
      signal: this.signalFor(state.runId),
    });
    const result = invocation.value;
    task = {
      ...task,
      implementerSession: {
        providerSessionId: invocation.providerSessionId,
        guidanceFingerprint: invocation.guidanceFingerprint ?? episode?.guidanceFingerprint,
        turns: (episode?.turns ?? 0) + 1,
      },
    };
    const evidence = await this.runTargetedTest(state.runId, task, task.tdd ? "tdd:green" : "test");
    const attempts = {
      ...task.attempts,
      implementation: task.attempts.implementation + 1,
    };
    const observedPaths = this.config.git.enabled
      ? await this.git.changedFiles()
      : result.changedFiles;
    const touchedTests = observedPaths.filter((file) =>
      task.testPaths.some((testPath) => normalizePathKey(testPath) === normalizePathKey(file)),
    );
    if (touchedTests.length > 0) {
      const exhausted = attempts.implementation >= this.config.workflow.maxImplementationAttempts;
      const failure = `Implementer modified recorded test files: ${touchedTests.join(", ")}`;
      const updated: BuildTask = {
        ...task,
        attempts,
        changedFiles: unique([...task.changedFiles, ...result.changedFiles]),
        evidence: [
          ...task.evidence,
          evidence,
          {
            purpose: "guard:test-tamper",
            command: "deterministic-test-path-guard",
            exitCode: 1,
            passed: false,
            stdout: "",
            stderr: failure,
            durationMs: 0,
            at: new Date().toISOString(),
          },
        ],
        step: exhausted ? "failed" : "implementing",
        status: exhausted ? "failed" : "active",
        failure: exhausted ? failure : undefined,
        reviewSummary: failure,
      };
      return this.updateTask(await this.withTreeFingerprint(state), updated, "task.implementation_test_tamper", {
        passed: evidence.passed,
      });
    }
    const exhausted =
      !evidence.passed && attempts.implementation >= this.config.workflow.maxImplementationAttempts;
    const updated: BuildTask = {
      ...task,
      attempts,
      changedFiles: unique([...task.changedFiles, ...result.changedFiles]),
      evidence: [...task.evidence, evidence],
      step: evidence.passed ? "verifying" : exhausted ? "failed" : "implementing",
      status: exhausted ? "failed" : "active",
      failure: exhausted
        ? `Targeted test failed after ${attempts.implementation} implementation attempts`
        : undefined,
    };
    return this.updateTask(
      await this.withTreeFingerprint(state),
      updated,
      evidence.passed ? "task.green_observed" : "task.implementation_repair_needed",
    );
  }

  private async verifyTask(state: RunState, task: BuildTask): Promise<RunState> {
    const evidence = [];
    for (const gate of this.config.commands.gates) {
      const result = await runCommand(gate.command, {
        cwd: this.config.repositoryRoot,
        timeoutMs: gate.timeoutMs,
        signal: this.signalFor(state.runId),
      });
      if (result.cancelled) {
        throw new RunCancelledError(`Gate ${gate.id} cancelled`);
      }
      evidence.push(commandEvidence(`gate:${gate.id}`, result));
    }
    const passed = evidence.every((item) => item.passed);
    const canRepair = task.attempts.implementation < this.config.workflow.maxImplementationAttempts;
    const updated: BuildTask = {
      ...task,
      evidence: [...task.evidence, ...evidence],
      step: passed ? "reviewing" : canRepair ? "implementing" : "failed",
      status: passed || canRepair ? "active" : "failed",
      failure:
        !passed && !canRepair
          ? "Command gates failed and implementation repair budget is exhausted"
          : undefined,
    };
    return this.updateTask(
      await this.withTreeFingerprint(state),
      updated,
      passed ? "task.gates_passed" : "task.gates_failed",
    );
  }

  private async reviewTask(state: RunState, task: BuildTask): Promise<RunState> {
    const changedFiles = this.config.git.enabled ? await this.git.changedFiles() : task.changedFiles;
    const diffResult =
      this.config.git.enabled && changedFiles.length > 0
        ? await this.git.diffForPaths(changedFiles, this.config.workflow.reviewDiffCharacters)
        : { diff: "", omittedFiles: [] as string[], truncated: false };
    const review = await this.agents.invoke({
      runId: state.runId,
      role: "reviewer",
      objective: `Independently review “${task.title}” against its acceptance criteria`,
      input: {
        task: taskForPacket(task),
        changedFiles,
        commandEvidence: recentEvidenceOutput(task.evidence),
        diff: diffResult.diff,
        diffOmittedFiles: diffResult.omittedFiles,
      },
      expectedOutput: "{approved,summary,findings:[{severity,message}]}",
      schema: ReviewOutputSchema,
      knowledgeQuery: [task.title, task.description, ...task.acceptanceCriteria].join(" "),
      signal: this.signalFor(state.runId),
      knowledgeFallbackQuery: compactDomainSeed(
        state.idea,
        state.reflectBrief?.confirmed,
        task.title,
        task.description,
      ),
    });
    const blocking = review.findings.filter((finding) => finding.severity === "blocking");
    const approved = review.approved && blocking.length === 0;
    const attempts = { ...task.attempts, review: task.attempts.review + 1 };
    const canRepair =
      attempts.review < this.config.workflow.maxReviewAttempts &&
      task.attempts.implementation < this.config.workflow.maxImplementationAttempts;
    const updated: BuildTask = {
      ...task,
      attempts,
      reviewSummary: [
        review.summary,
        ...review.findings.map((finding) => `${finding.severity}: ${finding.message}`),
      ].join("\n"),
      step: approved ? "committing" : canRepair ? "implementing" : "failed",
      status: approved || canRepair ? "active" : "failed",
      failure: !approved && !canRepair ? "Review failed and repair budget is exhausted" : undefined,
    };
    return this.updateTask(state, updated, approved ? "task.review_passed" : "task.review_failed");
  }

  private async commitTask(state: RunState, task: BuildTask): Promise<RunState> {
    const fallback: MessageOutput = {
      subject: `feat: ${task.title}`.slice(0, 100),
      body: task.description,
    };
    const message = this.config.workflow.generateCommitMessages
      ? await this.message(
          state.runId,
          `Write the commit message for completed task “${task.title}”`,
          { task: taskForPacket(task), changedFiles: task.changedFiles, review: task.reviewSummary },
          fallback,
        )
      : MessageOutputSchema.parse(fallback);
    const commitSha = await this.git.commitTask(task.id, message, task.changedFiles);
    const graphifyUpdated = includesSourcePath(
      task.changedFiles,
      this.config.knowledge.graphify.sourceExtensions,
    )
      ? await this.knowledge.rebuildRepositoryGraph()
      : false;
    return this.updateTask(
      await this.withTreeFingerprint(state),
      { ...task, status: "done", step: "done", commitSha },
      "task.committed",
      { commitSha, graphifyUpdated },
    );
  }

  private async publish(state: RunState): Promise<RunState> {
    const fallback: MessageOutput = {
      subject: `feat: ${state.idea}`.slice(0, 100),
      body: state.tasks.map((task) => `- ${task.title}`).join("\n"),
    };
    const message = await this.message(
      state.runId,
      "Write the pull-request title and body for this verified feature",
      {
        brief: state.reflectBrief?.confirmed,
        resolutions: state.grillResolutions,
        tasks: state.tasks.map(({ title, reviewSummary, commitSha }) => ({
          title,
          reviewSummary,
          commitSha,
        })),
      },
      fallback,
    );
    const pullRequestUrl = state.branchName
      ? await this.git.publish(state.branchName, message)
      : undefined;
    return this.store.record(
      { ...state, phase: "completed", pullRequestUrl },
      "run.completed",
      { pullRequestUrl },
    );
  }

  private async message(
    runId: string,
    objective: string,
    input: unknown,
    fallback: MessageOutput,
  ): Promise<MessageOutput> {
    try {
      return await this.agents.invoke({
        runId,
        role: "message-writer",
        objective,
        input,
        expectedOutput: "{subject,body}",
        schema: MessageOutputSchema,
        buildPrompt: false,
        retrieval: false,
        signal: this.signalFor(runId),
      });
    } catch (error) {
      if (error instanceof RunCancelledError || this.signalFor(runId)?.aborted) throw error;
      return MessageOutputSchema.parse(fallback);
    }
  }

  private async runTargetedTest(runId: string, task: BuildTask, purpose: string) {
    const command = task.testCommand ?? this.config.commands.test;
    const gate = this.config.commands.gates.find((item) => item.command === command);
    const result = await runCommand(command, {
      cwd: this.config.repositoryRoot,
      timeoutMs: gate?.timeoutMs ?? 10 * 60 * 1000,
      signal: this.signalFor(runId),
    });
    if (result.cancelled) {
      throw new RunCancelledError(`Command cancelled: ${purpose}`);
    }
    return commandEvidence(purpose, result);
  }

  private async updateTask(
    state: RunState,
    task: BuildTask,
    event: string,
    detail: Record<string, unknown> = {},
  ): Promise<RunState> {
    const next =
      task.status === "done" || task.status === "failed"
        ? await this.releaseImplementerSession(task)
        : task;
    return this.store.record(
      { ...state, tasks: state.tasks.map((item) => (item.id === next.id ? next : item)) },
      event,
      { taskId: next.id, step: next.step, ...detail },
    );
  }

  private async releaseImplementerSession(task: BuildTask): Promise<BuildTask> {
    if (!task.implementerSession) return task;
    await this.agents
      .releaseProviderSession(task.implementerSession.providerSessionId)
      .catch(() => undefined);
    return { ...task, implementerSession: undefined };
  }

  private async releaseAllImplementerSessions(state: RunState): Promise<RunState> {
    const tasks: BuildTask[] = [];
    for (const task of state.tasks) {
      tasks.push(await this.releaseImplementerSession(task));
    }
    return { ...state, tasks };
  }

  private async withTreeFingerprint(state: RunState): Promise<RunState> {
    if (!this.config.git.enabled) return state;
    return { ...state, treeFingerprint: await this.git.treeFingerprint() };
  }

  /** Throws HarnessFailure when the working tree no longer matches the last stamped fingerprint. */
  private async assertTreeFingerprint(state: RunState): Promise<void> {
    if (!this.config.git.enabled || !state.treeFingerprint) return;
    const observed = await this.git.treeFingerprint();
    if (observed === state.treeFingerprint) return;
    const recorded = new Set(state.tasks.flatMap((task) => task.changedFiles));
    const current = await this.git.changedFiles();
    const diverging = current.filter((file) => !recorded.has(file));
    const listed = diverging.length > 0 ? diverging : current;
    throw new HarnessFailure(
      `Working tree diverged from the harness's last known state. Diverging paths: ${
        listed.length > 0 ? listed.join(", ") : "(HEAD or index changed with no dirty paths)"
      }`,
      "workspace",
      true,
    );
  }

  private async syncArtifacts(state: RunState): Promise<void> {
    await this.tracker.sync(state);
  }
}

function materializeTasks(
  output: {
    tasks: Array<{
      id: string;
      title: string;
      description: string;
      acceptanceCriteria: string[];
      affectedPaths?: string[];
      blockedBy: string[];
      tdd?: boolean;
      testCommand?: string;
    }>;
  },
  config: HarnessConfig,
): BuildTask[] {
  const idMap = new Map<string, string>();
  const used = new Set<string>();
  for (const [index, task] of output.tasks.entries()) {
    let id = safeId(task.id, `task-${index + 1}`);
    let suffix = 2;
    while (used.has(id)) {
      id = `${safeId(task.id, `task-${index + 1}`)}-${suffix}`;
      suffix += 1;
    }
    used.add(id);
    idMap.set(task.id, id);
  }
  return output.tasks.map((task) => ({
    id: idMap.get(task.id)!,
    title: task.title,
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
    affectedPaths: task.affectedPaths ?? [],
    blockedBy: task.blockedBy.map((id) => idMap.get(id) ?? id),
    tdd: task.tdd ?? config.workflow.tdd,
    testCommand: task.testCommand ?? config.commands.test,
    status: "pending" as const,
    step: "pending" as const,
    attempts: { tests: 0, implementation: 0, review: 0 },
    evidence: [],
    testPaths: [],
    changedFiles: [],
  }));
}

/**
 * Reconciles the open-unknowns register against the griller's latest draft.
 * Absent priors: asked→resolved, parked→parked (sticky), resolved→resolved,
 * otherwise (fog/dropped)→dropped. A dropped entry that reappears recomputes
 * normally (not sticky). Entries are never deleted, only transitioned.
 */
export function reconcileUnknowns(
  previous: OpenUnknown[],
  incoming: OpenUnknownDraft[],
  askedIds: Set<string> = new Set(),
  parkedIds: Set<string> = new Set(),
): OpenUnknown[] {
  const previousById = new Map(previous.map((item) => [item.id, item] as const));
  const incomingIds = new Set(incoming.map((item) => item.id));
  const reconciled: OpenUnknown[] = incoming.map((draft) => {
    const prior = previousById.get(draft.id);
    const status: OpenUnknown["status"] = askedIds.has(draft.id)
      ? "asked"
      : parkedIds.has(draft.id) || prior?.status === "parked"
        ? "parked"
        : "fog";
    return {
      id: draft.id,
      title: draft.title,
      whyItMatters: draft.whyItMatters ?? "",
      impact: draft.impact ?? "shaping",
      status,
    };
  });
  for (const prior of previous) {
    if (incomingIds.has(prior.id)) continue;
    const status: OpenUnknown["status"] =
      prior.status === "asked"
        ? "resolved"
        : prior.status === "parked"
          ? "parked"
          : prior.status === "resolved"
            ? "resolved"
            : "dropped";
    reconciled.push({ ...prior, status });
  }
  return reconciled;
}

function mergeResolutions(
  existing: GrillResolution[],
  next: GrillResolution,
): GrillResolution[] {
  return [...existing.filter((item) => item.id !== next.id), next];
}

function mergeResolutionLists(
  existing: GrillResolution[],
  additions: GrillResolution[],
): GrillResolution[] {
  let result = existing;
  for (const item of additions) result = mergeResolutions(result, item);
  return result;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function safeId(value: string, fallback: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || fallback;
}

function terminal(phase: RunPhase): boolean {
  return phase === "completed" || phase === "blocked" || phase === "cancelled";
}

function configurationHash(config: unknown): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

const DIRTY_TREE_PATH_LIMIT = 10;

function dirtyTreeMessage(paths: string[]): string {
  const shown = paths.slice(0, DIRTY_TREE_PATH_LIMIT);
  const more = paths.length > shown.length ? ` (+${paths.length - shown.length} more)` : "";
  return `The working tree has uncommitted changes: ${shown.join(", ")}${more}. Commit or stash local changes in the repository, then retry the transition.`;
}

function defaultPreflightCommitMessage(runId: string): string {
  return `chore: commit working tree before harness run ${runId}`;
}

function preflightCommitDetail(
  order: PreflightCommitOrder,
  commit: PreflightCommitResult,
  auto: boolean,
): Record<string, unknown> {
  return {
    order,
    auto,
    sha: commit.sha,
    branch: commit.committedBranch,
    files: commit.files,
    // branch-then-commit is a real deviation from the documented baseBranch branching rule.
    ...(order === "branch-then-commit"
      ? { deviation: "run branch created from current HEAD, not config.git.baseBranch" }
      : {}),
  };
}

const PACKET_DESCRIPTION_LIMIT = 2_000;
const PACKET_CRITERION_LIMIT = 500;

/** Drop durable evidence and bound long prose before a task enters a packet. */
export function taskForPacket(task: BuildTask): Omit<BuildTask, "evidence"> {
  const { evidence: _evidence, ...rest } = task;
  return {
    ...rest,
    description: rest.description.slice(0, PACKET_DESCRIPTION_LIMIT),
    acceptanceCriteria: rest.acceptanceCriteria.map((item) =>
      item.slice(0, PACKET_CRITERION_LIMIT),
    ),
  };
}

export function isTestPath(filePath: string, patterns: readonly string[]): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  return patterns.some((pattern) => matchesGlob(pattern, normalized));
}

function includesSourcePath(paths: string[], extensions: readonly string[]): boolean {
  const allowed = new Set(extensions.map((ext) => ext.toLowerCase()));
  return paths.some((filePath) => {
    const normalized = filePath.replaceAll("\\", "/");
    return allowed.has(path.extname(normalized).toLowerCase());
  });
}

function normalizePathKey(filePath: string): string {
  return filePath.replaceAll("\\", "/").toLowerCase();
}
