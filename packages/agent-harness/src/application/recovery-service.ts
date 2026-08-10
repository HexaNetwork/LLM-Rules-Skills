import path from "node:path";
import {
  HarnessConfigSchema,
  configurationHash,
  configurationPolicyDiff,
  normalizeFrozenRunConfig,
  ProjectSettingsPatchSchema,
  type ProjectSettingsPatch,
  type PreflightCommitOrder,
} from "../config.js";
import {
  ConfigFixerPlanSchema,
  FixerPlanSchema,
  WorkerOutputSchema,
  clearBlock,
  isTerminalPhase,
  type FixerRecovery,
  type OpenUnknown,
  type OperatorNote,
  type ProposedInstall,
  type RunState,
} from "../domain.js";
import { classifyFailure, HarnessFailure, RunCancelledError } from "../errors.js";
import { commandEvidence, runApprovedInstall } from "../commands.js";
import type { ApplicationContext } from "./application-context.js";
import type { InterviewService } from "./interview-service.js";
import {
  CANCEL_LOCK_WAIT_MS,
  defaultPreflightCommitMessage,
  indexOfTaskForReportedPaths,
  isConfigFixerCandidate,
  pendingInstallApprovals,
  preflightCommitDetail,
  unique,
  type CancelResult,
  type PreflightCommitResult,
} from "./helpers.js";

const terminal = isTerminalPhase;

export class RecoveryService {
  constructor(
    private readonly ctx: ApplicationContext,
    private readonly interview: InterviewService,
  ) {}

  async completeCancellation(state: RunState): Promise<RunState> {
    if (terminal(state.phase)) {
      await this.ctx.clearCancelRequest(state.runId);
      return state;
    }
    const withoutSessions = await this.ctx.releaseAllImplementerSessions({
      ...state,
      phase: "cancelled",
    });
    const cancelled = await this.interview.closeGrillEpisode(withoutSessions);
    const recorded = await this.ctx.store.record(cancelled, "run.cancelled");
    await this.ctx.clearCancelRequest(state.runId);
    return recorded;
  }

  async proposeFix(runId: string, guidance: string): Promise<RunState> {
    return this.ctx.store.withRepositoryLock({ runId, action: "proposeFix" }, () => this.ctx.store.withLock(runId, async () => {
      const state = await this.ctx.store.load(runId);
      if (state.phase !== "blocked" || !state.failure || !state.blockedFrom) {
        throw new Error(`Run ${runId} is not blocked with a recoverable failure`);
      }
      if (isConfigFixerCandidate(state.blockedKind)) {
        return this.proposeConfigFix(state, guidance.trim());
      }
      return this.proposeFileFix(state, guidance.trim());
    }));
  }

  private async proposeConfigFix(state: RunState, guidance: string): Promise<RunState> {
    const frozen = normalizeFrozenRunConfig(await this.ctx.store.readJson(state.runId, "config.json"));
    const currentAmendableSettings = {
      workflow: {
        maxGrillQuestionsPerEpisode: frozen.workflow.maxGrillQuestionsPerEpisode,
        staleAnswerMinutes: frozen.workflow.staleAnswerMinutes,
        grillQuestionsPerBatch: frozen.workflow.grillQuestionsPerBatch,
        testPathPatterns: frozen.workflow.testPathPatterns,
      },
      commands: { test: frozen.commands.test },
      git: {
        autoCommitPreflight: frozen.git.autoCommitPreflight,
        preflightCommitOrder: frozen.git.preflightCommitOrder,
        ignoredArtifactPatterns: frozen.git.ignoredArtifactPatterns,
      },
    };
    const plan = await this.ctx.agents.invoke({
      runId: state.runId,
      role: "config-fixer",
      objective: "Propose the smallest harness settings patch that unblocks this run",
      input: {
        failure: state.failure,
        blockedFrom: state.blockedFrom,
        blockedKind: state.blockedKind,
        operatorGuidance: guidance,
        currentAmendableSettings,
      },
      constraints: [
        "Do not edit files.",
        "Return only summary and configPatch.",
        "configPatch may include workflow, commands, and/or git keys from ProjectSettingsPatch.",
        "Prefer the smallest change that covers the reported failure.",
      ],
      expectedOutput: "{summary:string,configPatch:{workflow?,commands?,git?}}",
      schema: ConfigFixerPlanSchema,
      knowledgeQuery: `${state.failure}\n${guidance}`,
      signal: this.ctx.signalFor(state.runId),
    });
    ProjectSettingsPatchSchema.parse(plan.configPatch);
    const fixerRecovery: FixerRecovery = {
      role: "config-fixer",
      guidance,
      failure: state.failure!,
      plan,
      status: "proposed",
      proposedAt: new Date().toISOString(),
      changedFiles: [],
    };
    const updated = await this.ctx.store.record({ ...state, fixerRecovery }, "fixer.plan_proposed", {
      blockedFrom: state.blockedFrom,
      blockedKind: state.blockedKind,
      guidance,
      summary: plan.summary,
      role: "config-fixer",
    });
    await this.ctx.syncArtifacts(updated);
    return updated;
  }

  private async proposeFileFix(state: RunState, guidance: string): Promise<RunState> {
    const plan = await this.ctx.agents.invoke({
      runId: state.runId,
      role: "fixer",
      objective: "Propose a minimal recovery plan for the blocked harness run; do not edit the working tree",
      input: {
        failure: state.failure,
        blockedFrom: state.blockedFrom,
        blockedKind: state.blockedKind,
        operatorGuidance: guidance,
      },
      constraints: [
        "Do not edit files during planning.",
        "The operator must approve before any repair is applied.",
        "Keep the recovery plan bounded: name every file it authorizes changing and every validation command it authorizes running. Do not propose broad repository discovery during application.",
      ],
      expectedOutput: "{summary,steps:[{title,description}],risks:string[],allowedPaths:string[],validationCommands:string[]}",
      schema: FixerPlanSchema,
      knowledgeQuery: `${state.failure}\n${guidance}`,
      signal: this.ctx.signalFor(state.runId),
    });
    const fixerRecovery: FixerRecovery = {
      role: "fixer",
      guidance,
      failure: state.failure!,
      plan,
      status: "proposed",
      proposedAt: new Date().toISOString(),
      changedFiles: [],
    };
    const updated = await this.ctx.store.record({ ...state, fixerRecovery }, "fixer.plan_proposed", {
      blockedFrom: state.blockedFrom,
      blockedKind: state.blockedKind,
      guidance,
      summary: plan.summary,
      role: "fixer",
    });
    await this.ctx.syncArtifacts(updated);
    return updated;
  }

  /**
   * Apply an explicitly approved fixer plan, then clear the block for the normal workflow to resume.
   * Config-fixer plans apply through amendConfig (no second agent). File fixer plans invoke the fixer apply pass.
   */
  async applyApprovedFix(
    runId: string,
    options?: {
      configPatch?: ProjectSettingsPatch;
      persistedProjectDefaults?: boolean;
      reportPaths?: string[];
    },
  ): Promise<RunState> {
    return this.ctx.store.withRepositoryLock({ runId, action: "applyApprovedFix" }, () => this.ctx.store.withLock(runId, async () => {
      let state = await this.ctx.store.load(runId);
      const recovery = state.fixerRecovery;
      if (state.phase !== "blocked" || !state.blockedFrom || !recovery || recovery.status !== "proposed") {
        throw new Error(`Run ${runId} has no fixer plan awaiting approval`);
      }
      const resumePhase = state.blockedFrom;
      state = await this.ctx.store.record(state, "fixer.plan_approved", {
        summary: recovery.plan.summary,
        role: recovery.role,
      });

      if (recovery.role === "config-fixer") {
        const configPatch = ProjectSettingsPatchSchema.parse(
          options?.configPatch ?? recovery.plan.configPatch,
        );
        state = await this.applyFrozenConfigAmendment(state, configPatch, {
          persistedProjectDefaults: options?.persistedProjectDefaults,
          reportPaths: options?.reportPaths,
        });
        const appliedRecovery: FixerRecovery = {
          ...recovery,
          plan: { summary: recovery.plan.summary, configPatch: configPatch as Record<string, unknown> },
          status: "applied",
          appliedAt: new Date().toISOString(),
          result: `Applied harness settings patch: ${JSON.stringify(configPatch)}`,
          changedFiles: unique(options?.reportPaths ?? []),
        };
        const updated = await this.ctx.store.record(
          {
            ...clearBlock(state, resumePhase),
            fixerRecovery: appliedRecovery,
          },
          "fixer.applied",
          {
            summary: appliedRecovery.result,
            changedFiles: appliedRecovery.changedFiles,
            role: "config-fixer",
          },
        );
        await this.ctx.syncArtifacts(updated);
        return updated;
      }

      if (recovery.plan.allowedPaths.length === 0) {
        throw new HarnessFailure(
          "Approved fixer plan has no allowedPaths; propose a bounded recovery plan before applying it",
          "contract",
          false,
        );
      }
      const result = await this.ctx.agents.invoke({
        runId,
        role: "fixer",
        objective: "Apply the operator-approved recovery plan, validate the repair where practical, and do not commit",
        input: {
          failure: recovery.failure,
          blockedFrom: state.blockedFrom,
          operatorGuidance: recovery.guidance,
          approvedPlan: recovery.plan,
        },
        constraints: [
          "This plan is approved by the operator.",
          "Do not commit, push, or open a pull request.",
          "This is bounded apply mode: do not retrieve project guidance or search the repository broadly. Read or write only paths explicitly named by the approved plan, and run only validation commands explicitly named by it. If the plan does not provide enough information, make no changes and report the blocker.",
        ],
        expectedOutput: "{summary,changedFiles:string[]}",
        schema: WorkerOutputSchema,
        retrieval: false,
        buildPrompt: false,
        signal: this.ctx.signalFor(runId),
      });
      const changedFiles = this.ctx.config.git.enabled ? await this.ctx.git.changedFiles() : result.changedFiles;
      const allowedPaths = new Set(
        recovery.plan.allowedPaths.map((candidate) => normalizeRecoveryPath(candidate, this.ctx.config.repositoryRoot)),
      );
      const unexpectedChanges = changedFiles.filter(
        (candidate) => !allowedPaths.has(normalizeRecoveryPath(candidate, this.ctx.config.repositoryRoot)),
      );
      if (unexpectedChanges.length > 0) {
        throw new HarnessFailure(
          `Approved fixer changed paths outside its allowedPaths: ${unexpectedChanges.join(", ")}`,
          "contract",
          false,
        );
      }
      const appliedRecovery: FixerRecovery = {
        ...recovery,
        status: "applied",
        appliedAt: new Date().toISOString(),
        result: result.summary,
        changedFiles: unique(changedFiles),
      };
      const updated = await this.ctx.store.record(
        {
          ...clearBlock(state, resumePhase),
          fixerRecovery: appliedRecovery,
          treeFingerprint: this.ctx.config.git.enabled ? await this.ctx.git.treeFingerprint() : state.treeFingerprint,
        },
        "fixer.applied",
        { summary: result.summary, changedFiles: appliedRecovery.changedFiles, role: "fixer" },
      );
      await this.ctx.syncArtifacts(updated);
      return updated;
    }));
  }

  async retry(
    runId: string,
    options?: { force?: boolean; maxRunTokens?: number; maxRunCostUsd?: number },
  ): Promise<RunState> {
    return this.ctx.store.withLock(runId, async () => {
      let state = await this.ctx.store.load(runId);
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
      state = await this.ctx.store.record(
        clearBlock(state, resumePhase),
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

  async raiseRunBudget(
    state: RunState,
    ceilings: { maxRunTokens?: number; maxRunCostUsd?: number },
  ): Promise<RunState> {
    if (ceilings.maxRunTokens != null) {
      this.ctx.config.workflow.maxRunTokens = ceilings.maxRunTokens;
    }
    if (ceilings.maxRunCostUsd != null) {
      this.ctx.config.workflow.maxRunCostUsd = ceilings.maxRunCostUsd;
    }
    // Validate via the same schema that freezes run configs.
    const parsed = HarnessConfigSchema.parse(this.ctx.config);
    this.ctx.config.workflow.maxRunTokens = parsed.workflow.maxRunTokens;
    this.ctx.config.workflow.maxRunCostUsd = parsed.workflow.maxRunCostUsd;

    const raw = (await this.ctx.store.readJson(state.runId, "config.json")) as Record<string, unknown>;
    const frozenVersion =
      typeof raw.configVersion === "number" ? raw.configVersion : state.configVersion;
    const frozenWorkflow =
      typeof raw.workflow === "object" && raw.workflow !== null && !Array.isArray(raw.workflow)
        ? (raw.workflow as Record<string, unknown>)
        : {};
    // Persist intentional budget mutations onto the frozen snapshot — do not dump live overlays.
    await this.ctx.store.writeJson(state.runId, "config.json", {
      ...raw,
      workflow: {
        ...frozenWorkflow,
        maxRunTokens: parsed.workflow.maxRunTokens,
        maxRunCostUsd: parsed.workflow.maxRunCostUsd,
      },
      configVersion: frozenVersion,
    });
    return {
      ...state,
      configurationHash: configurationHash(this.ctx.config),
    };
  }

  /**
   * Apply an operator-reviewed settings patch to a blocked run's frozen
   * configuration. This is intentionally separate from retry: confirmation
   * must happen in the caller before the harness writes a new policy snapshot.
   */
  async amendConfig(
    runId: string,
    patch: ProjectSettingsPatch,
    options?: { persistedProjectDefaults?: boolean; reportPaths?: string[] },
  ): Promise<RunState> {
    return this.ctx.store.withRepositoryLock({ runId, action: "amendConfig" }, () =>
      this.ctx.store.withLock(runId, async () => {
        const state = await this.ctx.store.load(runId);
        if (state.phase !== "blocked" || !state.blockedFrom) {
          throw new Error(`Run ${runId} must be blocked before its frozen config can be amended`);
        }
        const updated = await this.applyFrozenConfigAmendment(state, patch, options);
        await this.ctx.syncArtifacts(updated);
        return updated;
      }),
    );
  }

  /** Caller must hold the run lock. Leaves the run blocked; does not sync artifacts. */
  private async applyFrozenConfigAmendment(
    state: RunState,
    patch: ProjectSettingsPatch,
    options?: { persistedProjectDefaults?: boolean; reportPaths?: string[] },
  ): Promise<RunState> {
    const parsedPatch = ProjectSettingsPatchSchema.parse(patch);
    const raw = (await this.ctx.store.readJson(state.runId, "config.json")) as Record<string, unknown>;
    const frozen = normalizeFrozenRunConfig(raw);
    const amended = HarnessConfigSchema.parse({
      ...frozen,
      ...(parsedPatch.workflow
        ? { workflow: { ...frozen.workflow, ...parsedPatch.workflow } }
        : {}),
      ...(parsedPatch.commands
        ? { commands: { ...frozen.commands, ...parsedPatch.commands } }
        : {}),
      ...(parsedPatch.git ? { git: { ...frozen.git, ...parsedPatch.git } } : {}),
    });
    const changedPaths = configurationPolicyDiff(frozen, amended);
    if (changedPaths.length === 0) {
      throw new Error("The proposed config amendment does not change this run's policy");
    }
    const previousHash = state.configurationHash;
    await this.ctx.store.writeJson(state.runId, "config.json", {
      ...amended,
      configVersion: state.configVersion,
    });
    let nextState = state;
    const reportPaths = unique(
      (options?.reportPaths ?? []).map((file) => file.replaceAll("\\", "/")),
    );
    if (reportPaths.length > 0) {
      const targetIndex = indexOfTaskForReportedPaths(nextState);
      if (targetIndex >= 0) {
        nextState = {
          ...nextState,
          tasks: nextState.tasks.map((task, index) =>
            index === targetIndex
              ? { ...task, changedFiles: unique([...task.changedFiles, ...reportPaths]) }
              : task,
          ),
        };
      }
    }
    const nextHash = configurationHash(amended);
    return this.ctx.store.record(
      { ...nextState, configurationHash: nextHash },
      "run.config_amended",
      {
        previousHash,
        nextHash,
        changedPaths,
        persistedProjectDefaults: Boolean(options?.persistedProjectDefaults),
        reportPaths,
      },
    );
  }

  /**
   * Operator accepts the current working tree after a divergence block: re-stamps
   * `treeFingerprint`, clears the block, and audits `run.tree_accepted`.
   * Optional `reportPaths` are appended to the active task's `changedFiles` so a
   * follow-on commit (e.g. after ignore_artifacts dirties the project config) treats
   * them as intentional rather than unreported.
   */

  async acceptTree(runId: string, options?: { reportPaths?: string[] }): Promise<RunState> {
    return this.ctx.store.withRepositoryLock({ runId, action: "acceptTree" }, async () =>
      this.ctx.store.withLock(runId, async () => {
        let state = await this.ctx.store.load(runId);
        if (state.phase !== "blocked" || !state.blockedFrom) {
          throw new Error(`Run ${runId} is not resumably blocked`);
        }
        const resumePhase = state.blockedFrom;
        const previousFingerprint = state.treeFingerprint;
        const reportPaths = unique(
          (options?.reportPaths ?? []).map((file) => file.replaceAll("\\", "/")),
        );
        if (reportPaths.length > 0) {
          const targetIndex = indexOfTaskForReportedPaths(state);
          if (targetIndex >= 0) {
            state = {
              ...state,
              tasks: state.tasks.map((task, index) =>
                index === targetIndex
                  ? { ...task, changedFiles: unique([...task.changedFiles, ...reportPaths]) }
                  : task,
              ),
            };
          }
        }
        const recorded = new Set(state.tasks.flatMap((task) => task.changedFiles));
        const current = this.ctx.config.git.enabled ? await this.ctx.git.changedFiles() : [];
        const divergingPaths = current.filter((file) => !recorded.has(file));
        const listed = divergingPaths.length > 0 ? divergingPaths : current;
        const treeFingerprint = await this.ctx.git.treeFingerprint();
        state = await this.ctx.store.record(
          { ...clearBlock(state, resumePhase), treeFingerprint },
          "run.tree_accepted",
          {
            previousFingerprint,
            treeFingerprint,
            divergingPaths: listed,
            ...(reportPaths.length > 0 ? { reportPaths } : {}),
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
    return this.ctx.store.withRepositoryLock({ runId, action: "commitPreflight" }, async () =>
      this.ctx.store.withLock(runId, async () => {
        let state = await this.ctx.store.load(runId);
        if (state.phase !== "blocked" || !state.blockedFrom) {
          throw new Error(`Run ${runId} is not resumably blocked`);
        }
        const order = options?.order ?? this.ctx.config.git.preflightCommitOrder;
        const message = options?.message ?? defaultPreflightCommitMessage(runId);
        const commit = await this.runPreflightCommit(runId, order, message);
        state = await this.ctx.store.record(
          {
            ...clearBlock(state, state.blockedFrom),
            branchName: commit.runBranch ?? state.branchName,
            treeFingerprint: await this.ctx.git.treeFingerprint(),
          },
          "run.preflight_committed",
          preflightCommitDetail(order, commit, false),
        );
        return state;
      }),
    );
  }

  async runPreflightCommit(
    runId: string,
    order: PreflightCommitOrder,
    message: string,
  ): Promise<PreflightCommitResult> {
    // branch-then-commit must cut the branch before committing so the dirty tree rides onto it.
    if (order === "branch-then-commit") {
      const runBranch = await this.ctx.git.createRunBranchFromHead(runId);
      const result = await this.ctx.git.commitWorkingTree(message);
      return { committedBranch: runBranch, runBranch, sha: result.sha, files: result.files };
    }
    const result = await this.ctx.git.commitWorkingTree(message);
    // commit-then-branch lands on whatever was checked out; that is an audit
    // fact, not the run branch, so it must not overwrite state.branchName.
    const committedBranch = await this.ctx.git.currentBranch();
    return { committedBranch, sha: result.sha, files: result.files };
  }

  async cancel(runId: string): Promise<CancelResult> {
    const current = await this.ctx.store.load(runId);
    if (terminal(current.phase)) {
      await this.ctx.clearCancelRequest(runId);
      return { state: current, pending: false };
    }

    await this.ctx.writeCancelRequest(runId);
    const hasController = this.ctx.cancellation.has(runId);
    this.ctx.cancellation.abort(runId);

    // In-process advance owns the lock and will complete the cancelled transition.
    if (hasController) {
      return { state: await this.ctx.store.load(runId), pending: true };
    }

    const locked = await this.ctx.store.tryWithLock(runId, CANCEL_LOCK_WAIT_MS, async () => {
      const state = await this.ctx.store.load(runId);
      if (terminal(state.phase)) {
        await this.ctx.clearCancelRequest(runId);
        return state;
      }
      return this.completeCancellation(state);
    });
    if (locked.acquired) {
      return { state: locked.value, pending: false };
    }
    return { state: await this.ctx.store.load(runId), pending: true };
  }

  /** Finish the current task, then halt before starting the next frontier task. */

  async requestStop(runId: string): Promise<RunState> {
    const current = await this.ctx.store.load(runId);
    if (terminal(current.phase)) {
      throw new Error(`Run ${runId} is already ${current.phase}`);
    }
    if (current.phase !== "executing") {
      throw new Error(`Stop after task is only available while executing (phase=${current.phase})`);
    }
    if (current.stoppedAfterTaskAt) {
      return current;
    }

    await this.ctx.writeStopRequest(runId);

    // Prefer durable state update; if advance holds the lock, the stop.request
    // file is enough for the in-flight loop to halt after the current task.
    const locked = await this.ctx.store.tryWithLock(runId, 250, async () => {
      const state = await this.ctx.store.load(runId);
      if (terminal(state.phase) || state.phase !== "executing") {
        await this.ctx.clearStopRequest(runId);
        return state;
      }
      if (state.stoppedAfterTaskAt) {
        await this.ctx.clearStopRequest(runId);
        return state;
      }
      const active = state.tasks.find((task) => task.status === "active");
      if (!active) {
        if (state.tasks.every((task) => task.status === "done")) {
          await this.ctx.clearStopRequest(runId);
          throw new Error("All tasks are already done; nothing left to stop before");
        }
        const stopped = await this.ctx.store.record(
          {
            ...state,
            stopAfterTask: false,
            stoppedAfterTaskAt: new Date().toISOString(),
          },
          "run.stopped_after_task",
        );
        await this.ctx.clearStopRequest(runId);
        return stopped;
      }
      if (state.stopAfterTask) return state;
      return this.ctx.store.record({ ...state, stopAfterTask: true }, "run.stop_requested");
    });
    if (locked.acquired) return locked.value;
    return this.ctx.store.load(runId);
  }

  /**
   * Confirm grilling is complete (continue to planning) or reopen with feedback.
   * Empty/absent feedback clears the gate and enters planning; non-empty feedback
   * seeds an operator note (asUnknown) and returns to grilling.
   */

  async resolveInstalls(
    runId: string,
    decisions: { accepted?: string[]; denied?: string[] },
  ): Promise<RunState> {
    // Installs mutate manifests and lockfiles, so they need the same shared
    // worktree exclusion as an advancing run. Keep repository -> run ordering.
    return this.ctx.store.withRepositoryLock({ runId, action: "resolve-installs" }, () => this.ctx.store.withLock(runId, async () => {
      let state = await this.ctx.store.load(runId);
      const pending = pendingInstallApprovals(state);
      if (state.phase !== "awaiting_input" || pending.length === 0) {
        throw new Error(`Run ${runId} is not awaiting install approval`);
      }
      const accepted = new Set(decisions.accepted ?? []);
      const denied = new Set(decisions.denied ?? []);
      for (const id of accepted) {
        if (denied.has(id)) throw new Error(`Install ${id} cannot be both accepted and denied`);
      }
      const pendingIds = new Set(pending.map((item) => item.id));
      for (const id of [...accepted, ...denied]) {
        if (!pendingIds.has(id)) throw new Error(`Unknown pending install id: ${id}`);
      }
      for (const item of pending) {
        if (!accepted.has(item.id) && !denied.has(item.id)) {
          throw new Error(`Install ${item.id} still needs an accept or deny decision`);
        }
      }

      await this.ctx.assertTreeFingerprint(state);

      const now = new Date().toISOString();
      const nextInstalls: ProposedInstall[] = [];
      for (const item of state.proposedInstalls) {
        if (item.decision) {
          nextInstalls.push(item);
          continue;
        }
        if (denied.has(item.id)) {
          nextInstalls.push({ ...item, decision: "denied", decidedAt: now });
          continue;
        }
        if (!accepted.has(item.id)) {
          nextInstalls.push(item);
          continue;
        }
        const result = await runApprovedInstall(item.manager, item.packages, {
          cwd: this.ctx.config.repositoryRoot,
          timeoutMs: 10 * 60 * 1000,
          signal: this.ctx.signalFor(runId),
          ...this.ctx.commandEnvironmentOptions(),
        });
        if (result.cancelled) {
          throw new RunCancelledError(`Install ${item.id} cancelled`);
        }
        const evidence = commandEvidence(`install:${item.id}`, result);
        if (!evidence.passed) {
          throw new HarnessFailure(
            `Approved install failed (${item.manager} ${item.packages.join(" ")}): ${
              evidence.stderr || evidence.stdout || `exit ${evidence.exitCode}`
            }`.slice(0, 2_000),
            "workspace",
            true,
          );
        }
        await this.ctx.store.appendJsonl(runId, "installs.jsonl", {
          at: now,
          role: "harness",
          manager: item.manager,
          commandSummary: evidence.command.slice(0, 200),
          packages: item.packages,
          source: "harness",
        });
        nextInstalls.push({
          ...item,
          decision: "accepted",
          decidedAt: now,
          evidence,
        });
      }

      state = await this.ctx.store.record(
        {
          ...state,
          proposedInstalls: nextInstalls,
          phase: "executing",
          treeFingerprint: await this.ctx.git.treeFingerprint(),
        },
        "installs.resolved",
        {
          accepted: [...accepted],
          denied: [...denied],
        },
      );
      await this.ctx.syncArtifacts(state);
      return state;
    }));
  }

  /**
   * Toggle TDD for the run default and/or a still-pending task.
   * Refuses once a task has entered writing_tests / implementing work.
   */
}

function normalizeRecoveryPath(candidate: string, repositoryRoot: string): string {
  const resolved = path.isAbsolute(candidate) ? path.relative(repositoryRoot, candidate) : candidate;
  return resolved.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}
