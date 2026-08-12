import path from "node:path";
import type { InvokeInput } from "../agent.js";
import {
  loadRunWorkspace,
  normalizeFrozenRunConfig,
  ProjectSettingsPatchSchema,
  writeRunWorkspace,
  type PreflightCommitOrder,
} from "../config.js";
import {
  ConfigFixerPlanSchema,
  FixerPlanSchema,
  WorkerOutputSchema,
  clearBlock,
  decideWorktreeCleanup,
  isCancelSettled,
  isTerminalPhase,
  type FixerRecovery,
  type OpenUnknown,
  type OperatorNote,
  type ProposedInstall,
  type RunState,
} from "../domain.js";
import { classifyFailure, HarnessFailure, RunCancelledError } from "../errors.js";
import { commandEvidence, runApprovedInstall } from "../commands.js";
import { WorktreeManager } from "../git/worktree-manager.js";
import type { ApplicationContext } from "./application-context.js";
import { applyFrozenConfigRepair } from "./frozen-config-repair.js";
import type { InterviewService } from "./interview-service.js";
import {
  CANCEL_LOCK_WAIT_MS,
  defaultPreflightCommitMessage,
  indexOfTaskForReportedPaths,
  isConfigFixerCandidate,
  offersPreflightCommitOrders,
  pendingInstallApprovals,
  preflightCommitDetail,
  preflightCommitUnavailableMessage,
  repairRoute,
  unique,
  type CancelResult,
  type CleanupResult,
  type MigrateWorkspaceResult,
  type PreflightCommitResult,
} from "./helpers.js";
import { updateRunConfig } from "./update-run-config.js";
import { accrueRunUsage } from "./usage-ledger.js";

const terminal = isTerminalPhase;

function cleanupRefusalMessage(reason: string): string {
  switch (reason) {
    case "run-not-settled":
      return "Refusing cleanup: run is still active. Cancel or complete it first.";
    case "dirty-worktree":
      return "Refusing cleanup: run worktree is dirty. Commit, stash, or discard local changes first.";
    case "path-invalid":
      return "Refusing cleanup: recorded worktree path failed validation.";
    case "not-registered":
      return "Refusing cleanup: worktree is not registered in git worktree list.";
    case "git-common-dir-mismatch":
      return "Refusing cleanup: worktree does not match the recorded Git common directory.";
    case "unpublished-requires-discard":
      return "Refusing cleanup: commits are not reachable from a retained named ref. Pass --discard to explicitly discard unpublished work.";
    case "not-git-worktree":
      return "Refusing cleanup: run is not a git-worktree workspace.";
    default:
      return `Refusing cleanup (${reason}).`;
  }
}

export class RecoveryService {
  constructor(
    private readonly ctx: ApplicationContext,
    private readonly interview: InterviewService,
  ) {}

  private async invokeWithUsage<T>(
    state: RunState,
    input: InvokeInput<T>,
  ): Promise<{ value: T; state: RunState }> {
    try {
      const value = await this.ctx.agents.invoke(input);
      return { value, state: await accrueRunUsage(this.ctx, state) };
    } catch (error) {
      // Failed and schema-repair sessions are durable usage too. Persist their
      // aggregate before surfacing the recovery failure to the caller.
      await accrueRunUsage(this.ctx, state).catch(() => undefined);
      throw error;
    }
  }

  private async invokeFixerEpisodeWithUsage<T>(
    state: RunState,
    input: InvokeInput<T> & {
      providerSessionId?: string;
      mode?: "agent" | "plan";
      retainProviderSession?: boolean;
    },
  ): Promise<{
    value: T;
    state: RunState;
    providerSessionId?: string;
    providerSessionReused: boolean;
  }> {
    try {
      const invocation = await this.ctx.agents.invokeInEpisode(input);
      return {
        value: invocation.value,
        state: await accrueRunUsage(this.ctx, state),
        providerSessionId: invocation.providerSessionId,
        providerSessionReused: invocation.providerSessionReused,
      };
    } catch (error) {
      await accrueRunUsage(this.ctx, state).catch(() => undefined);
      throw error;
    }
  }

  private async releaseFixerProviderSession(
    recovery: FixerRecovery | undefined,
  ): Promise<void> {
    if (recovery?.role === "fixer" && recovery.providerSessionId) {
      await this.ctx.agents
        .releaseProviderSession(recovery.providerSessionId)
        .catch(() => undefined);
    }
  }

  async completeCancellation(state: RunState): Promise<RunState> {
    if (isCancelSettled(state.phase)) {
      await this.ctx.clearCancelRequest(state.runId);
      return state;
    }
    const withoutSessions = await this.ctx.releaseAllTaskWorkerSessions({
      ...state,
      phase: "cancelled",
    });
    let cancelled = await this.interview.closeGrillEpisode(withoutSessions);
    await this.releaseFixerProviderSession(cancelled.fixerRecovery);
    if (cancelled.fixerRecovery?.role === "fixer" && cancelled.fixerRecovery.providerSessionId) {
      cancelled = {
        ...cancelled,
        fixerRecovery: { ...cancelled.fixerRecovery, providerSessionId: undefined },
      };
    }
    const plannerEpisode = cancelled.plannerEpisode;
    if (plannerEpisode && !plannerEpisode.closedAt) {
      await this.ctx.agents
        .releaseProviderSession(plannerEpisode.providerSessionId)
        .catch(() => undefined);
      const now = new Date().toISOString();
      cancelled = {
        ...cancelled,
        plannerEpisode: { ...plannerEpisode, updatedAt: now, closedAt: now },
      };
    }
    const recorded = await this.ctx.store.record(cancelled, "run.cancelled");
    await this.ctx.clearCancelRequest(state.runId);
    return recorded;
  }

  async proposeFix(runId: string, guidance: string): Promise<RunState> {
    return this.ctx.withMutatingRunLock(runId, "proposeFix", async () => {
      const state = await this.ctx.store.load(runId);
      if (state.phase !== "blocked" || !state.failure || !state.blockedFrom) {
        throw new Error(`Run ${runId} is not blocked with a recoverable failure`);
      }
      if (isConfigFixerCandidate(state.blockedKind, state.failure)) {
        return this.proposeConfigFix(state, guidance.trim());
      }
      return this.proposeFileFix(state, guidance.trim());
    });
  }

  private async proposeConfigFix(state: RunState, guidance: string): Promise<RunState> {
    await this.releaseFixerProviderSession(state.fixerRecovery);
    const frozen = normalizeFrozenRunConfig(await this.ctx.store.readJson(state.runId, "config.json"));
    const currentRepairableSettings = {
      workflow: {
        maxGrillQuestionsPerEpisode: frozen.workflow.maxGrillQuestionsPerEpisode,
        staleAnswerMinutes: frozen.workflow.staleAnswerMinutes,
        grillQuestionsPerBatch: frozen.workflow.grillQuestionsPerBatch,
        testPathPatterns: frozen.workflow.testPathPatterns,
      },
      commands: {
        verification: frozen.commands.verification,
        ...(frozen.commands.testTargetTemplate
          ? { testTargetTemplate: frozen.commands.testTargetTemplate }
          : {}),
      },
      git: {
        autoCommitPreflight: frozen.git.autoCommitPreflight,
        preflightCommitOrder: frozen.git.preflightCommitOrder,
        ignoredArtifactPatterns: frozen.git.ignoredArtifactPatterns,
      },
    };
    const invoked = await this.invokeWithUsage(state, {
      runId: state.runId,
      role: "config-fixer",
      objective: "Propose the smallest harness settings patch that unblocks this run",
      input: {
        failure: state.failure,
        blockedFrom: state.blockedFrom,
        blockedKind: state.blockedKind,
        operatorGuidance: guidance,
        currentRepairableSettings,
      },
      constraints: [
        "The work packet contains every fact needed. Do not call tools, inspect files, or search the repository.",
        "Return exactly one raw JSON object with top-level summary and configPatch fields; no Markdown or code fences.",
        "configPatch may include workflow, commands, and/or git keys from ProjectSettingsPatch.",
        "Prefer the smallest change that covers the reported failure.",
      ],
      expectedOutput: '{"summary":"concise explanation","configPatch":{"workflow":{},"commands":{},"git":{}}}',
      schema: ConfigFixerPlanSchema,
      retrieval: false,
      buildPrompt: false,
      allowTools: false,
      signal: this.ctx.signalFor(state.runId),
    });
    state = invoked.state;
    const plan = invoked.value;
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
    // Revise / re-plan drops the prior retained context so apply never continues a discarded plan.
    await this.releaseFixerProviderSession(state.fixerRecovery);
    const invoked = await this.invokeFixerEpisodeWithUsage(state, {
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
      mode: "plan",
      retainProviderSession: true,
      causal: {
        phase: state.phase,
        invocationKind: "initial",
        trigger: {
          event: "fixer.propose",
          classification: "initial",
          summary: "propose fixer recovery plan",
        },
      },
      signal: this.ctx.signalFor(state.runId),
    });
    state = invoked.state;
    const plan = invoked.value;
    const fixerRecovery: FixerRecovery = {
      role: "fixer",
      guidance,
      failure: state.failure!,
      plan,
      status: "proposed",
      proposedAt: new Date().toISOString(),
      changedFiles: [],
      providerSessionId: invoked.providerSessionId,
    };
    const updated = await this.ctx.store.record({ ...state, fixerRecovery }, "fixer.plan_proposed", {
      blockedFrom: state.blockedFrom,
      blockedKind: state.blockedKind,
      guidance,
      summary: plan.summary,
      role: "fixer",
      providerSessionId: invoked.providerSessionId,
    });
    await this.ctx.syncArtifacts(updated);
    return updated;
  }

  /**
   * Apply an explicitly approved fixer plan, then clear the block for the normal workflow to resume.
   * Config-fixer plans apply their validated recommendation directly (no second agent).
   * File fixer plans invoke the fixer apply pass.
   */
  async applyApprovedFix(
    runId: string,
    options?: {
      persistedProjectDefaults?: boolean;
      reportPaths?: string[];
    },
  ): Promise<RunState> {
    return this.ctx.withMutatingRunLock(runId, "applyApprovedFix", async () => {
      let state = await this.ctx.store.load(runId);
      const recovery = state.fixerRecovery;
      if (state.phase !== "blocked" || !state.blockedFrom || !recovery || recovery.status !== "proposed") {
        throw new Error(`Run ${runId} has no fixer plan awaiting approval`);
      }
      const resumePhase = state.blockedFrom;
      const route = repairRoute({
        failure: recovery.failure ?? state.failure,
        blockedKind: state.blockedKind,
      });
      if (recovery.role === "fixer" && route === "config-fixer") {
        throw new Error(
          "This failure requires a config-fixer repair that updates the frozen run config; draft a recommended configuration repair instead of a file fixer plan",
        );
      }
      state = await this.ctx.store.record(state, "fixer.plan_approved", {
        summary: recovery.plan.summary,
        role: recovery.role,
      });

      if (recovery.role === "config-fixer") {
        const configPatch = ProjectSettingsPatchSchema.parse(recovery.plan.configPatch);
        state = await applyFrozenConfigRepair(this.ctx, state, configPatch, {
          persistedProjectDefaults: options?.persistedProjectDefaults,
          reportPaths: options?.reportPaths,
        });
        const appliedRecovery: FixerRecovery = {
          ...recovery,
          plan: { summary: recovery.plan.summary, configPatch: configPatch as Record<string, unknown> },
          status: "applied",
          appliedAt: new Date().toISOString(),
          result: `Applied recommended configuration repair: ${JSON.stringify(configPatch)}`,
          changedFiles: unique(options?.reportPaths ?? []),
        };
        const stamped = this.ctx.config.git.enabled
          ? await this.ctx.stampWorkspaceEvidence()
          : undefined;
        const updated = await this.ctx.store.record(
          {
            ...clearBlock(state, resumePhase),
            fixerRecovery: appliedRecovery,
            ...(stamped ?? {}),
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
      // Approve-without-revise reuses the planning context. Missing/expired contexts
      // fall back to a fresh apply with the approved plan in the packet.
      const reuseSessionId = recovery.providerSessionId;
      const reusing = Boolean(reuseSessionId);
      const invoked = await this.invokeFixerEpisodeWithUsage(state, {
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
        mode: "agent",
        providerSessionId: reuseSessionId,
        // One final turn: reuse when possible, then release so revise/cancel cannot leak.
        retainProviderSession: false,
        causal: {
          phase: state.phase,
          invocationKind: reusing ? "continuation" : "initial",
          trigger: {
            event: "fixer.apply",
            classification: reusing ? "continuation" : "initial",
            summary: reusing
              ? "apply approved fixer plan in retained provider context"
              : "apply approved fixer plan in a fresh provider context",
            previousInvocationId: undefined,
          },
        },
        signal: this.ctx.signalFor(runId),
      });
      state = invoked.state;
      const result = invoked.value;
      const changedFiles = this.ctx.config.git.enabled ? await this.ctx.git.changedFiles() : result.changedFiles;
      const allowedPaths = new Set(
        recovery.plan.allowedPaths.map((candidate) => normalizeRecoveryPath(candidate, this.ctx.paths.workspaceRoot)),
      );
      const unexpectedChanges = changedFiles.filter(
        (candidate) => !allowedPaths.has(normalizeRecoveryPath(candidate, this.ctx.paths.workspaceRoot)),
      );
      if (unexpectedChanges.length > 0) {
        await this.releaseFixerProviderSession(recovery);
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
        // Context is released after apply; keep the id only when it was actually reused.
        providerSessionId: invoked.providerSessionReused
          ? invoked.providerSessionId ?? reuseSessionId
          : undefined,
      };
      const stamped = this.ctx.config.git.enabled
        ? await this.ctx.stampWorkspaceEvidence()
        : undefined;
      const updated = await this.ctx.store.record(
        {
          ...clearBlock(state, resumePhase),
          fixerRecovery: appliedRecovery,
          ...(stamped ?? {}),
        },
        "fixer.applied",
        { summary: result.summary, changedFiles: appliedRecovery.changedFiles, role: "fixer" },
      );
      await this.ctx.syncArtifacts(updated);
      return updated;
    });
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
   * Caller must hold the run lock.
   */
  async raiseRunBudget(
    state: RunState,
    ceilings: { maxRunTokens?: number; maxRunCostUsd?: number },
  ): Promise<RunState> {
    const patch = {
      workflow: {
        ...(ceilings.maxRunTokens != null ? { maxRunTokens: ceilings.maxRunTokens } : {}),
        ...(ceilings.maxRunCostUsd != null ? { maxRunCostUsd: ceilings.maxRunCostUsd } : {}),
      },
    };
    const result = await updateRunConfig(
      this.ctx,
      state.runId,
      state.configRevision ?? 0,
      patch,
      {
        reason: "budget",
        detail: {
          ...(ceilings.maxRunTokens != null ? { maxRunTokens: ceilings.maxRunTokens } : {}),
          ...(ceilings.maxRunCostUsd != null ? { maxRunCostUsd: ceilings.maxRunCostUsd } : {}),
        },
      },
      { alreadyLocked: true, allowNoChange: true },
    );
    return result.state;
  }

  /**
   * Operator accepts the current working tree after a divergence block: re-stamps
   * workspace evidence, clears the block, and audits `run.workspace_accepted`.
   * Optional `reportPaths` are appended to the active task's `changedFiles` so a
   * follow-on commit (e.g. after ignore_artifacts dirties the project config) treats
   * them as intentional rather than unreported.
   */

  async acceptTree(runId: string, options?: { reportPaths?: string[] }): Promise<RunState> {
    return this.ctx.withMutatingRunLock(runId, "acceptTree", async () => {
      let state = await this.ctx.store.load(runId);
      if (state.phase !== "blocked" || !state.blockedFrom) {
        throw new Error(`Run ${runId} is not resumably blocked`);
      }
      const resumePhase = state.blockedFrom;
      const previousEvidence = state.workspaceEvidence;
      const previousFingerprint = previousEvidence?.fingerprint ?? state.treeFingerprint;
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
      const stamped = this.ctx.config.git.enabled
        ? await this.ctx.stampWorkspaceEvidence()
        : undefined;
      state = await this.ctx.store.record(
        {
          ...clearBlock(state, resumePhase),
          ...(stamped ?? {}),
        },
        "run.workspace_accepted",
        {
          previousFingerprint,
          treeFingerprint: stamped?.treeFingerprint,
          previousEvidence,
          acceptedEvidence: stamped?.workspaceEvidence,
          divergingPaths: listed,
          ...(reportPaths.length > 0 ? { reportPaths } : {}),
        },
      );
      return state;
    });
  }

  /** Resolves a dirty tree the harness itself found by committing it, then clears the block like retry(). */

  async commitPreflight(
    runId: string,
    options?: { order?: PreflightCommitOrder; message?: string },
  ): Promise<RunState> {
    return this.ctx.withMutatingRunLock(runId, "commitPreflight", async () => {
      let state = await this.ctx.store.load(runId);
      if (state.phase !== "blocked" || !state.blockedFrom) {
        throw new Error(`Run ${runId} is not resumably blocked`);
      }
      if (!offersPreflightCommitOrders(this.ctx.workspace.kind)) {
        throw new HarnessFailure(
          preflightCommitUnavailableMessage(this.ctx.workspace.kind),
          "workspace",
          false,
        );
      }
      const order = options?.order ?? this.ctx.config.git.preflightCommitOrder;
      const message = options?.message ?? defaultPreflightCommitMessage(runId);
      const commit = await this.runPreflightCommit(runId, order, message);
      // Fingerprint after ensureRunBranch: that hop can move HEAD.
      let branchName = commit.runBranch ?? state.branchName;
      let cutRunBranch = false;
      if (order === "commit-then-branch" && this.ctx.config.git.enabled) {
        // Shared branch-ref creation takes the short workspace-admin lock.
        const ensured = await this.ctx.store.withWorkspaceAdminLock(
          { runId, action: "create-run-branch" },
          () =>
            this.ctx.usesGitWorktree()
              ? this.ctx.git.createRunBranchFromHead(runId)
              : this.ctx.git.ensureRunBranch(runId),
        );
        if (ensured) {
          cutRunBranch = ensured !== branchName;
          branchName = ensured;
        }
      }
      const stamped = this.ctx.config.git.enabled
        ? await this.ctx.stampWorkspaceEvidence()
        : undefined;
      state = await this.ctx.store.record(
        {
          ...clearBlock(state, state.blockedFrom),
          branchName,
          ...(stamped ?? {}),
        },
        "run.preflight_committed",
        preflightCommitDetail(order, commit, false),
      );
      if (cutRunBranch && branchName) {
        state = await this.ctx.store.record(
          state,
          "run.branch_ready",
          { branch: branchName, baseBranch: this.ctx.config.git.baseBranch },
        );
      }
      return state;
    });
  }

  async runPreflightCommit(
    runId: string,
    order: PreflightCommitOrder,
    message: string,
  ): Promise<PreflightCommitResult> {
    // branch-then-commit must cut the branch before committing so the dirty tree rides onto it.
    if (order === "branch-then-commit") {
      const runBranch = await this.ctx.store.withWorkspaceAdminLock(
        { runId, action: "create-run-branch" },
        () => this.ctx.git.createRunBranchFromHead(runId),
      );
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
    if (isCancelSettled(current.phase)) {
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
      if (isCancelSettled(state.phase)) {
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

  /**
   * Explicit migration: move a clean legacy-shared run onto a registered worktree at HEAD.
   * Refuses when the shared tree is dirty; never migrates silently.
   */
  async migrateWorkspace(runId: string): Promise<MigrateWorkspaceResult> {
    return this.ctx.withMutatingRunLock(runId, "migrateWorkspace", async () => {
      const state = await this.ctx.store.load(runId);
      const workspace = await loadRunWorkspace(this.ctx.config, runId);
      this.ctx.bindWorkspace(workspace);

      if (workspace.kind !== "legacy-shared") {
        throw new HarnessFailure(
          `Workspace migration only applies to legacy-shared runs (this run is ${workspace.kind})`,
          "workspace",
          false,
        );
      }
      if (!this.ctx.config.git.enabled) {
        throw new HarnessFailure("Cannot migrate workspace while git.enabled is false", "config", false);
      }

      const dirty = await this.ctx.git.changedFiles();
      if (dirty.length > 0) {
        throw new HarnessFailure(
          `Refusing to migrate a dirty legacy checkout. Commit or stash first: ${dirty.slice(0, 10).join(", ")}`,
          "workspace",
          false,
        );
      }

      const evidence = await this.ctx.git.workspaceEvidence();
      const headSha = evidence.headSha;
      const currentBranch = await this.ctx.git.currentBranch();
      const sourceBranch =
        workspace.branchName ?? state.branchName ?? currentBranch ?? this.ctx.config.git.baseBranch;
      const baseBranch = workspace.baseBranch ?? this.ctx.config.git.baseBranch;

      const manager = new WorktreeManager({
        controlRoot: this.ctx.paths.controlRoot,
        stateRoot: this.ctx.paths.stateRoot,
        worktreeRoot: this.ctx.paths.worktreeRoot,
        store: this.ctx.store,
      });
      const migrated = await manager.create({
        runId,
        baseBranch,
        baseSha: headSha,
        branchName: sourceBranch,
      });
      await writeRunWorkspace(this.ctx.config, runId, migrated);
      this.ctx.bindWorkspace(migrated);

      const nextState = await this.ctx.store.record(state, "run.workspace_migrated", {
        sourceKind: "legacy-shared",
        sourceBranch,
        sourceSha: headSha,
        baseBranch: migrated.baseBranch,
        baseSha: migrated.baseSha,
        kind: migrated.kind,
      });
      return { state: nextState, workspace: migrated };
    });
  }

  /**
   * Explicitly remove a settled run's registered worktree after conservative checks.
   * Never prunes abandoned worktrees implicitly. Retains workspace.json, state, events, and branch.
   */
  async cleanup(
    runId: string,
    options?: { discard?: boolean },
  ): Promise<CleanupResult> {
    return this.ctx.withMutatingRunLock(runId, "cleanup", async () => {
      const state = await this.ctx.store.load(runId);
      const workspace = await loadRunWorkspace(this.ctx.config, runId);
      this.ctx.bindWorkspace(workspace);

      if (workspace.kind !== "git-worktree") {
        throw new HarnessFailure(
          `Cleanup only applies to git-worktree runs (this run is ${workspace.kind})`,
          "workspace",
          false,
        );
      }

      if (workspace.removedAt) {
        return {
          state,
          removed: false,
          reason: "already-removed",
          retainedBranch: workspace.branchName ?? state.branchName,
        };
      }

      const manager = new WorktreeManager({
        controlRoot: this.ctx.paths.controlRoot,
        stateRoot: this.ctx.paths.stateRoot,
        worktreeRoot: this.ctx.paths.worktreeRoot,
        store: this.ctx.store,
      });
      const inspection = await manager.inspectCleanupTarget(workspace);
      const retainedBranch = workspace.branchName ?? state.branchName;
      const decision = decideWorktreeCleanup({
        phase: state.phase,
        workspaceKind: workspace.kind,
        alreadyRemoved: false,
        dirty: inspection.dirty,
        pathValid: inspection.pathValid,
        registered: inspection.registered,
        gitCommonDirMatches: inspection.gitCommonDirMatches,
        commitsReachableFromRetainedRef: inspection.commitsReachableFromRetainedRef,
        hasRetainedNamedRef: Boolean(retainedBranch),
        discard: options?.discard === true,
      });

      if (!decision.allow) {
        throw new HarnessFailure(cleanupRefusalMessage(decision.reason), "workspace", false);
      }

      await manager.removeRegisteredWorktree(workspace, runId);
      const removedAt = new Date().toISOString();
      const nextWorkspace = {
        ...workspace,
        removedAt,
        branchName: retainedBranch ?? workspace.branchName,
      };
      await writeRunWorkspace(this.ctx.config, runId, nextWorkspace);
      this.ctx.bindWorkspace(nextWorkspace);

      const nextState = await this.ctx.store.record(
        state,
        "run.worktree_removed",
        {
          reason: decision.reason,
          discarded: options?.discard === true,
          ...(retainedBranch ? { retainedBranch } : {}),
          ...(inspection.headSha ? { headSha: inspection.headSha } : {}),
        },
      );
      return {
        state: nextState,
        removed: true,
        reason: decision.reason,
        retainedBranch,
      };
    });
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
    // Legacy-shared installs still take the repository lock; worktree installs are run-local.
    return this.ctx.withMutatingRunLock(runId, "resolve-installs", async () => {
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
          cwd: this.ctx.paths.workspaceRoot,
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

      const stamped = this.ctx.config.git.enabled
        ? await this.ctx.stampWorkspaceEvidence()
        : undefined;
      state = await this.ctx.store.record(
        {
          ...state,
          proposedInstalls: nextInstalls,
          phase: "executing",
          ...(stamped ?? {}),
        },
        "installs.resolved",
        {
          accepted: [...accepted],
          denied: [...denied],
        },
      );
      await this.ctx.syncArtifacts(state);
      return state;
    });
  }

  /**
   * Toggle TDD for the run default and/or a still-pending task.
   * Refuses once a task has entered implementing work.
   */
}

function normalizeRecoveryPath(candidate: string, repositoryRoot: string): string {
  const resolved = path.isAbsolute(candidate) ? path.relative(repositoryRoot, candidate) : candidate;
  return resolved.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}
