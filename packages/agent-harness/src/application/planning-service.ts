import path from "node:path";
import { ProjectSettingsPatchSchema } from "../config/schema.js";
import type { ProjectSettingsPatch } from "../config/schema.js";
import { writeProjectSettings } from "../config/io.js";
import { commandEvidence } from "../commands.js";
import {
  applyHighLevelPlan,
  applyPlan,
  HighLevelPlanSchema,
  ISSUE_SLICER_EXPECTED_OUTPUT,
  IssueSlicerOutputSchema,
  PLANNER_EXPECTED_OUTPUT,
  PRD_EXPECTED_OUTPUT,
  PrdSchema,
  PROJECT_PROFILER_EXPECTED_OUTPUT,
  SCENARIO_PLANNER_EXPECTED_OUTPUT,
  ScenarioPlannerOutputSchema,
  ProjectProfilerOutputSchema,
  VerificationSettingsPatchSchema,
  type CommandEvidence,
  type HighLevelPlan,
  type PlannerEpisode,
  type RunState,
  type VerificationSettingsPatch,
  type VerificationSettingsSnapshot,
} from "../domain.js";
import { HarnessFailure, RunCancelledError } from "../errors.js";
import { compactDomainSeed } from "../knowledge.js";
import type { ApplicationContext } from "./application-context.js";
import { applyFrozenConfigRepair } from "./frozen-config-repair.js";
import {
  pendingInstallApprovals,
  pendingPlanReady,
  pendingVerificationBaselineReady,
  pendingVerificationReady,
} from "./helpers.js";
import {
  collectVerificationEvidence,
  isVerificationBaselineAcceptable,
  verificationEvidenceNeedsTools,
} from "./verification-evidence.js";


export class PlanningService {
  constructor(private readonly ctx: ApplicationContext) {}

  async plan(state: RunState): Promise<RunState> {
    // Docker workspaces stay detached until publication. Git-disabled setup
    // retains the existing branch behavior for its narrow non-Git path.
    let branchName = state.branchName;
    if (this.ctx.usesDockerWorkspace()) {
      branchName = this.ctx.workspace.branchName ?? state.branchName;
      const dirty = await this.ctx.git.changedFiles();
      if (dirty.length > 0) {
        throw new HarnessFailure(
          `Refusing to start on a dirty working tree. Commit or stash first: ${dirty.join(", ")}`,
          "workspace",
          true,
        );
      }
    } else {
      branchName = await this.ctx.git.ensureRunBranch(state.runId);
    }

    // Idempotent resume: tasks already materialized — do not re-slice.
    if (state.tasks.length > 0) {
      const phase = pendingInstallApprovals(state).length > 0 ? "awaiting_input" : "executing";
      return this.ctx.store.record(
        { ...state, branchName: branchName ?? state.branchName, phase },
        "plan.resumed",
        { tasks: state.tasks.length, pendingInstalls: pendingInstallApprovals(state).length },
      );
    }

    // Resume while the plan review gate is open: do not re-plan.
    if (pendingPlanReady(state)) {
      return this.ctx.store.record(
        {
          ...state,
          branchName: branchName ?? state.branchName,
          phase: "awaiting_input",
        },
        "plan.resumed",
        { summary: state.planReady!.summary },
      );
    }

    // Resume while the verification gate is already open: do not re-propose.
    if (pendingVerificationReady(state)) {
      return this.ctx.store.record(
        {
          ...state,
          branchName: branchName ?? state.branchName,
          phase: "awaiting_input",
        },
        "verification.resumed",
        { summary: state.verificationReady!.summary },
      );
    }

    if (!state.verificationConfirmedAt) {
      return this.proposeVerification(state, branchName);
    }

    // Resume while the baseline gate is open: do not re-run until the operator retries.
    if (pendingVerificationBaselineReady(state)) {
      return this.ctx.store.record(
        {
          ...state,
          branchName: branchName ?? state.branchName,
          phase: "awaiting_input",
        },
        "verification.baseline_resumed",
        { summary: state.verificationBaselineReady!.summary },
      );
    }

    let working: RunState = {
      ...state,
      branchName: branchName ?? state.branchName,
    };

    if (!working.verificationBaselinePassedAt) {
      const baseline = await this.runVerificationBaseline(working);
      if (!baseline.ok) return baseline.state;
      working = baseline.state;
    }

    // Plan drafted but PRD not yet authored.
    if (working.plan && !working.prd) {
      return this.authorPrd(working);
    }

    // PRD present but scenarios not yet planned.
    if (working.prd && working.scenarios.length === 0) {
      return this.planScenarios(working);
    }

    // Scenarios present but the bundled gate has not been approved yet.
    if (
      working.prd &&
      working.scenarios.length > 0 &&
      working.tasks.length === 0 &&
      !pendingPlanReady(working) &&
      !working.planConfirmedAt
    ) {
      return this.openBundledPlanGate(working);
    }

    // Gate approved (planConfirmedAt set, planReady cleared) but tasks not yet sliced.
    if (
      working.prd &&
      working.scenarios.length > 0 &&
      working.tasks.length === 0 &&
      working.planConfirmedAt
    ) {
      return this.sliceIssues(working);
    }

    return this.authorHighLevelPlan(working);
  }

  /**
   * Approve or reopen the high-level plan gate.
   * Approve applies optional edits and leaves phase=planning so advance runs to-prd + slicer.
   * Feedback clears the plan and reopens planning for a cold planner restart.
   */
  async confirmPlan(
    runId: string,
    options: { feedback?: string; plan?: HighLevelPlan } = {},
  ): Promise<RunState> {
    return this.ctx.withMutatingRunLock(runId, "confirmPlan", async () => {
      let state = await this.ctx.store.load(runId);
      const pending = pendingPlanReady(state);
      if (state.phase !== "awaiting_input" || !pending) {
        throw new Error(`Run ${runId} is not awaiting plan confirmation`);
      }
      const feedback = options.feedback?.trim() ?? "";
      if (feedback) {
        state = await this.closePlannerEpisode(state, "planner.episode_released");
        state = await this.ctx.store.record(
          {
            ...state,
            planReady: undefined,
            planConfirmedAt: undefined,
            plan: undefined,
            prd: undefined,
            scenarios: [],
            tasks: [],
            proposedInstalls: [],
            planFeedback: feedback,
            phase: "planning",
          },
          "plan.reopened",
          { feedback },
        );
        await this.ctx.syncArtifacts(state);
        return state;
      }

      const plan = options.plan
        ? HighLevelPlanSchema.parse(options.plan)
        : state.plan
          ? HighLevelPlanSchema.parse(state.plan)
          : undefined;
      if (!plan) {
        throw new Error(`Run ${runId} has no plan to confirm`);
      }

      state = await this.ctx.store.record(
        {
          ...state,
          plan,
          planReady: undefined,
          planConfirmedAt: new Date().toISOString(),
          planFeedback: undefined,
          phase: "planning",
        },
        "plan.confirmed",
        { summary: plan.summary, edited: Boolean(options.plan) },
      );
      await this.ctx.syncArtifacts(state);
      return state;
    });
  }

  async closePlannerEpisode(
    state: RunState,
    event = "planner.episode_closed",
  ): Promise<RunState> {
    const episode = state.plannerEpisode;
    if (!episode || episode.closedAt) return state;
    await this.ctx.agents.releaseProviderSession(episode.providerSessionId).catch(() => undefined);
    const now = new Date().toISOString();
    const closed: PlannerEpisode = {
      ...episode,
      updatedAt: now,
      closedAt: now,
    };
    return this.ctx.store.record({ ...state, plannerEpisode: closed }, event, {
      episode: episode.number,
    });
  }

  private async authorHighLevelPlan(state: RunState): Promise<RunState> {
    const feedback = state.planFeedback?.trim();
    const coldStart = !state.plannerEpisode || Boolean(state.plannerEpisode.closedAt);
    let working = state;
    if (coldStart) {
      working = await this.startPlannerEpisode(working, Boolean(feedback));
    }

    const episode = working.plannerEpisode;
    const invocation = await this.ctx.agents.invokeInEpisode({
      runId: working.runId,
      role: "planner",
      objective:
        "Turn the confirmed brief and grill resolutions into a high-level implementation plan for operator review",
      input: {
        confirmedBrief: working.reflectBrief?.confirmed,
        resolutions: working.grillResolutions,
        ...(feedback ? { planFeedback: feedback } : {}),
      },
      expectedOutput: PLANNER_EXPECTED_OUTPUT,
      schema: HighLevelPlanSchema,
      knowledgeQuery: [
        working.reflectBrief?.confirmed,
        compactDomainSeed(
          working.reflectBrief?.confirmed,
          ...working.grillResolutions.flatMap((item) => [item.question, item.answer, item.summary]),
          feedback,
        ),
      ]
        .filter(Boolean)
        .join(" "),
      knowledgeFallbackQuery: compactDomainSeed(
        working.reflectBrief?.confirmed,
        ...working.grillResolutions.flatMap((item) => [item.question, item.answer, item.summary]),
      ),
      providerSessionId: episode?.providerSessionId,
      previousGuidanceFingerprint: episode?.guidanceFingerprint,
      signal: this.ctx.signalFor(working.runId),
    });

    const now = new Date().toISOString();
    working = {
      ...working,
      plannerEpisode: {
        number: episode?.number ?? 1,
        providerSessionId: invocation.providerSessionId,
        guidanceFingerprint: invocation.guidanceFingerprint ?? episode?.guidanceFingerprint,
        startedAt: episode?.startedAt ?? now,
        updatedAt: now,
      },
      planFeedback: undefined,
    };

    const transition = applyHighLevelPlan(working, invocation.value, now);

    // Persist the plan first so a dirty-tree block does not discard planning progress.
    // Stay in `planning` so retry resumes the cold path (PRD → scenarios → gate).
    if (this.ctx.config.git.enabled) {
      const dirty = await this.ctx.git.changedFiles();
      if (dirty.length > 0) {
        await this.ctx.store.persistTransition(working.runId, {
          state: transition.state,
          events: transition.events,
        });
        throw new HarnessFailure(
          `Refusing to start on a dirty working tree. Commit or stash first: ${dirty.join(", ")}`,
          "workspace",
          true,
        );
      }
    }

    const persisted = await this.ctx.store.persistTransition(working.runId, transition);
    await this.ctx.syncArtifacts(persisted);
    // Continue cold path: PRD → scenarios → bundled gate (no operator stop yet).
    return this.authorPrd(persisted);
  }

  private async authorPrd(state: RunState): Promise<RunState> {
    const plan = state.plan;
    if (!plan) throw new Error("Cannot author PRD without an approved plan");
    const episode = state.plannerEpisode;
    if (!episode?.providerSessionId || episode.closedAt) {
      throw new Error("Cannot author PRD without a retained planner provider session");
    }

    const invocation = await this.ctx.agents.invokeInEpisode({
      runId: state.runId,
      role: "planner",
      objective:
        "Expand the approved high-level plan into a local PRD (problem, solution, user stories, decisions)",
      input: {
        approvedPlan: plan,
        confirmedBrief: state.reflectBrief?.confirmed,
        resolutions: state.grillResolutions,
      },
      expectedOutput: PRD_EXPECTED_OUTPUT,
      schema: PrdSchema,
      knowledgeQuery: [
        plan.summary,
        plan.problemStatement,
        plan.solution,
        plan.approach,
        compactDomainSeed(state.reflectBrief?.confirmed),
      ]
        .filter(Boolean)
        .join(" "),
      knowledgeFallbackQuery: compactDomainSeed(plan.summary, plan.approach),
      providerSessionId: episode.providerSessionId,
      previousGuidanceFingerprint: episode.guidanceFingerprint,
      signal: this.ctx.signalFor(state.runId),
    });

    const now = new Date().toISOString();
    let next = await this.ctx.store.record(
      {
        ...state,
        prd: invocation.value,
        plannerEpisode: {
          ...episode,
          providerSessionId: invocation.providerSessionId ?? episode.providerSessionId,
          guidanceFingerprint: invocation.guidanceFingerprint ?? episode.guidanceFingerprint,
          updatedAt: now,
        },
        phase: "planning",
      },
      "prd.created",
      { summary: invocation.value.summary },
    );
    await this.ctx.syncArtifacts(next);
    next = await this.closePlannerEpisode(next, "planner.episode_released");

    if (this.ctx.config.git.enabled) {
      const dirty = await this.ctx.git.changedFiles();
      if (dirty.length > 0) {
        throw new HarnessFailure(
          `Refusing to start on a dirty working tree. Commit or stash first: ${dirty.join(", ")}`,
          "workspace",
          true,
        );
      }
    }

    // Continue cold path into scenario planning.
    return this.planScenarios(next);
  }

  private async planScenarios(state: RunState): Promise<RunState> {
    const prd = state.prd;
    if (!prd) throw new Error("Cannot plan scenarios without a PRD");
    const plan = state.plan;
    if (!plan) throw new Error("Cannot plan scenarios without a plan");

    const output = await this.ctx.agents.invoke({
      runId: state.runId,
      role: "scenario-planner",
      objective:
        "Author intent-level test scenarios covering the PRD user stories and plan approach",
      input: {
        prd,
        plan,
        userStories: prd.userStories,
        confirmedBrief: state.reflectBrief?.confirmed,
        resolutions: state.grillResolutions,
      },
      expectedOutput: SCENARIO_PLANNER_EXPECTED_OUTPUT,
      schema: ScenarioPlannerOutputSchema,
      knowledgeQuery: [
        prd.summary,
        ...prd.userStories,
        plan.summary,
        compactDomainSeed(state.reflectBrief?.confirmed),
      ]
        .filter(Boolean)
        .join(" "),
      knowledgeFallbackQuery: compactDomainSeed(prd.summary, ...prd.userStories),
      signal: this.ctx.signalFor(state.runId),
    });

    const scenarios = output.scenarios.map((scenario) => ({
      ...scenario,
      taskIds: [] as string[],
      status: "pending" as const,
      attempts: 0,
      writerAttempts: 0,
      repairAttempts: 0,
      testPaths: [] as string[],
      seenEvidenceFingerprints: [] as string[],
      seenRepairEdges: [] as string[],
      reviewFindings: [] as string[],
    }));
    const next = await this.ctx.store.record(
      {
        ...state,
        scenarios,
        phase: "planning",
      },
      "scenarios.planned",
      { count: scenarios.length, summary: output.summary },
    );
    await this.ctx.syncArtifacts(next);
    return this.openBundledPlanGate(next);
  }

  private async openBundledPlanGate(state: RunState): Promise<RunState> {
    const plan = state.plan;
    if (!plan) throw new Error("Cannot open plan gate without a plan");
    if (!state.prd) throw new Error("Cannot open plan gate without a PRD");
    if (state.scenarios.length === 0) {
      throw new Error("Cannot open plan gate without scenarios");
    }
    const now = new Date().toISOString();
    const next = await this.ctx.store.record(
      {
        ...state,
        planReady: {
          summary: `${plan.summary} · ${state.scenarios.length} scenario(s)`,
          readyAt: now,
        },
        phase: "awaiting_input",
      },
      "plan.ready",
      {
        summary: plan.summary,
        scenarios: state.scenarios.length,
        prdSummary: state.prd.summary,
      },
    );
    await this.ctx.syncArtifacts(next);
    return next;
  }

  private async sliceIssues(state: RunState): Promise<RunState> {
    const prd = state.prd;
    if (!prd) throw new Error("Cannot slice issues without a PRD");

    const output = await this.ctx.agents.invoke({
      runId: state.runId,
      role: "issue-slicer",
      objective:
        "Turn the local PRD into dependency-ordered tracer-bullet implementation tickets tagged with scenario ids",
      input: {
        prd,
        plan: state.plan,
        scenarios: state.scenarios,
        confirmedBrief: state.reflectBrief?.confirmed,
        resolutions: state.grillResolutions,
      },
      expectedOutput: ISSUE_SLICER_EXPECTED_OUTPUT,
      schema: IssueSlicerOutputSchema,
      knowledgeQuery: [
        prd.summary,
        prd.problemStatement,
        prd.solution,
        ...prd.userStories,
        compactDomainSeed(state.reflectBrief?.confirmed),
      ]
        .filter(Boolean)
        .join(" "),
      knowledgeFallbackQuery: compactDomainSeed(prd.summary, ...prd.userStories),
      signal: this.ctx.signalFor(state.runId),
    });

    const now = new Date().toISOString();
    const transition = applyPlan(state, output, now, {
      branchName: state.branchName,
    });

    if (this.ctx.config.git.enabled) {
      const dirty = await this.ctx.git.changedFiles();
      if (dirty.length > 0) {
        await this.ctx.store.persistTransition(state.runId, {
          state: { ...transition.state, phase: "planning" },
          events: transition.events,
        });
        throw new HarnessFailure(
          `Refusing to start on a dirty working tree. Commit or stash first: ${dirty.join(", ")}`,
          "workspace",
          true,
        );
      }
    }

    const persisted = await this.ctx.store.persistTransition(state.runId, transition);
    await this.ctx.syncArtifacts(persisted);
    return persisted;
  }

  private async startPlannerEpisode(state: RunState, forceFresh: boolean): Promise<RunState> {
    const episode = state.plannerEpisode;
    if (episode && !episode.closedAt) {
      await this.ctx.agents.releaseProviderSession(episode.providerSessionId).catch(() => undefined);
    }
    const now = new Date().toISOString();
    const nextNumber = (episode?.number ?? 0) + 1;
    return this.ctx.store.record(
      {
        ...state,
        plannerEpisode: {
          number: nextNumber,
          startedAt: now,
          updatedAt: now,
        },
      },
      "planner.episode_started",
      { episode: nextNumber, forceFresh },
    );
  }

  /**
   * Confirm or edit verification settings before the planner runs.
   * Applies the patch to this run's frozen config; optionally writes project defaults.
   */
  async confirmVerification(
    runId: string,
    options: {
      patch?: VerificationSettingsPatch;
      keepCurrent?: boolean;
      persistProjectDefaults?: boolean;
      configPath?: string;
    } = {},
  ): Promise<RunState> {
    return this.ctx.withMutatingRunLock(runId, "confirmVerification", async () => {
      let state = await this.ctx.store.load(runId);
      const gate = pendingVerificationReady(state);
      if (state.phase !== "awaiting_input" || !gate) {
        throw new Error(`Run ${runId} is not awaiting verification confirmation`);
      }

      const keepCurrent = Boolean(options.keepCurrent);
      const rawPatch = keepCurrent
        ? {}
        : (options.patch ?? gate.proposedPatch);
      const patch = VerificationSettingsPatchSchema.parse(rawPatch);
      // Reject unrelated keys that ProjectSettingsPatch would otherwise allow.
      assertVerificationOnlyPatch(patch);

      let reportPaths: string[] = [];
      if (options.persistProjectDefaults) {
        if (!options.configPath) {
          throw new Error("Cannot persist project defaults without a config file path");
        }
        const projectPatch = toProjectSettingsPatch(patch, gate.currentSettings, keepCurrent);
        await writeProjectSettings(options.configPath, projectPatch);
        const relative = pathRelativeToRepo(this.ctx.paths.controlRoot, options.configPath);
        if (relative) reportPaths = [relative];
      }

      const effectivePatch = keepCurrent
        ? {}
        : mergeVerificationPatch(gate.currentSettings, patch);
      const hasChange = verificationPatchChangesSettings(gate.currentSettings, effectivePatch);
      if (hasChange) {
        state = await applyFrozenConfigRepair(
          this.ctx,
          state,
          effectivePatch as ProjectSettingsPatch,
          {
            persistedProjectDefaults: Boolean(options.persistProjectDefaults),
            reportPaths,
            allowNoChange: false,
          },
        );
      }

      const now = new Date().toISOString();
      state = await this.ctx.store.record(
        {
          ...state,
          verificationReady: undefined,
          verificationConfirmedAt: now,
          phase: "planning",
        },
        "verification.confirmed",
        {
          keepCurrent,
          persistProjectDefaults: Boolean(options.persistProjectDefaults),
          patch: effectivePatch,
          reportPaths,
        },
      );
      await this.ctx.syncArtifacts(state);
      return state;
    });
  }

  /**
   * Retry the pre-planner verification baseline after a failure gate.
   * A command edit replaces the authoritative verification collection.
   */
  async retryVerificationBaseline(
    runId: string,
    options: {
      verificationCommand?: string;
      persistProjectDefaults?: boolean;
      configPath?: string;
    } = {},
  ): Promise<RunState> {
    return this.ctx.withMutatingRunLock(runId, "retryVerificationBaseline", async () => {
      let state = await this.ctx.store.load(runId);
      const gate = pendingVerificationBaselineReady(state);
      if (state.phase !== "awaiting_input" || !gate) {
        throw new Error(`Run ${runId} is not awaiting a verification baseline retry`);
      }

      const verificationCommand = options.verificationCommand?.trim();
      let reportPaths: string[] = [];
      if (verificationCommand) {
        const patch: VerificationSettingsPatch = {
          commands: {
            verification: [{ id: "test", command: verificationCommand, timeoutMs: 10 * 60 * 1000 }],
          },
        };
        assertVerificationOnlyPatch(patch);
        if (options.persistProjectDefaults) {
          if (!options.configPath) {
            throw new Error("Cannot persist project defaults without a config file path");
          }
          await writeProjectSettings(options.configPath, patch);
          const relative = pathRelativeToRepo(this.ctx.paths.controlRoot, options.configPath);
          if (relative) reportPaths = [relative];
        }
        const current = currentVerificationSettings(this.ctx);
        if (
          current.commands.verification.length !== 1 ||
          current.commands.verification[0]?.command !== verificationCommand
        ) {
          state = await applyFrozenConfigRepair(this.ctx, state, patch as ProjectSettingsPatch, {
            persistedProjectDefaults: Boolean(options.persistProjectDefaults),
            reportPaths,
            allowNoChange: false,
          });
        }
      } else if (options.persistProjectDefaults) {
        throw new Error("persistProjectDefaults requires verificationCommand when retrying the baseline");
      }

      state = await this.ctx.store.record(
        {
          ...state,
          verificationBaselineReady: undefined,
          phase: "planning",
        },
        "verification.baseline_retried",
        {
          verificationCommand: verificationCommand ?? this.ctx.config.commands.verification[0]!.command,
          persistProjectDefaults: Boolean(options.persistProjectDefaults),
          reportPaths,
        },
      );
      await this.ctx.syncArtifacts(state);

      const baseline = await this.runVerificationBaseline(state);
      return baseline.state;
    });
  }

  private async runVerificationBaseline(
    state: RunState,
  ): Promise<{ ok: true; state: RunState } | { ok: false; state: RunState }> {
    const evidence = await this.executeVerificationBaseline(state.runId);
    let next = await this.ctx.store.record(state, "verification.baseline_run", {
      command: evidence.command,
      exitCode: evidence.exitCode,
      passed: evidence.passed,
      durationMs: evidence.durationMs,
    });

    if (isVerificationBaselineAcceptable(evidence)) {
      const now = new Date().toISOString();
      next = await this.ctx.store.record(
        {
          ...next,
          verificationBaselineReady: undefined,
          verificationBaselinePassedAt: now,
          phase: "planning",
        },
        "verification.baseline_passed",
        { evidence },
      );
      await this.ctx.syncArtifacts(next);
      return { ok: true, state: next };
    }

    const summary = baselineFailureSummary(evidence);
    next = await this.ctx.store.record(
      {
        ...next,
        phase: "awaiting_input",
        verificationBaselineReady: {
          summary,
          evidence,
          readyAt: new Date().toISOString(),
        },
      },
      "verification.baseline_failed",
      { summary, evidence },
    );
    await this.ctx.syncArtifacts(next);
    return { ok: false, state: next };
  }

  private async executeVerificationBaseline(runId: string): Promise<CommandEvidence> {
    const collected: CommandEvidence[] = [];
    for (const verification of this.ctx.config.commands.verification) {
      const result = await this.ctx.deps.commands.run(verification.command, {
        cwd: this.ctx.paths.workspaceRoot,
        timeoutMs: verification.timeoutMs,
        signal: this.ctx.signalFor(runId),
        ...this.ctx.commandEnvironmentOptions(),
      });
      if (result.cancelled) {
        throw new RunCancelledError(`Command cancelled: verification:baseline:${verification.id}`);
      }
      const evidence = commandEvidence(`verification:baseline:${verification.id}`, result);
      collected.push(evidence);
      if (!isVerificationBaselineAcceptable(evidence)) return evidence;
    }
    return collected.at(-1)!;
  }

  private async proposeVerification(
    state: RunState,
    branchName: string | undefined,
  ): Promise<RunState> {
    const currentSettings = currentVerificationSettings(this.ctx);
    const evidence = await collectVerificationEvidence(
      this.ctx.paths.workspaceRoot,
      currentSettings,
    );
    const allowTools = verificationEvidenceNeedsTools(evidence);
    const output = await this.ctx.agents.invoke({
      runId: state.runId,
      role: "project-profiler",
      objective:
        "Propose the complete ordered verification commands, config-owned targeted-test template, and test path patterns for this repository",
      input: {
        confirmedBrief: state.reflectBrief?.confirmed,
        evidence,
        currentSettings,
      },
      constraints: allowTools
        ? [
            "Evidence is thin, empty, or ambiguous. You may list and read repository files to choose verification settings.",
            "Do not create, edit, or delete project files — only inspect and propose settings.",
            "When the repository has no build manifests, infer a single stack from the confirmed brief and explain that inference in summary.",
            "Use evidence.host.platform and evidence.host.isWindows when proposing commands.verification.",
            "On Windows (win32), do not use ./ prefixes; prefer native Windows entrypoints from evidence when present.",
            "On POSIX hosts, prefer conventional POSIX invocation from evidence.",
            "Ground the command only in manifests, sample test paths, and currentSettings — never invent a stack.",
            "Return exactly one raw JSON object with top-level summary and configPatch fields; no Markdown or code fences.",
            "configPatch may only include workflow.testPathPatterns and/or commands.verification and commands.testTargetTemplate.",
            "commands.verification is the complete ordered list used at baseline and after implementation; replace stale commands from other ecosystems.",
            "Use {filter} in commands.testTargetTemplate when the runner supports targeted tests; {filter} is a recorded test file path that the harness converts to a wildcard *ClassName pattern for --tests templates, so for Gradle prefer a quoted template such as gradlew test --tests \"{filter}\"; never invent shell pipelines.",
          ]
        : [
            "The work packet contains every fact needed. Do not call tools, inspect files, or search the repository.",
            "Use evidence.host.platform and evidence.host.isWindows when proposing commands.verification.",
            "On Windows (win32), do not use ./ prefixes; prefer native Windows entrypoints from evidence when present.",
            "On POSIX hosts, prefer conventional POSIX invocation from evidence.",
            "Ground the command only in manifests, sample test paths, and currentSettings — never invent a stack.",
            "Return exactly one raw JSON object with top-level summary and configPatch fields; no Markdown or code fences.",
            "configPatch may only include workflow.testPathPatterns and/or commands.verification and commands.testTargetTemplate.",
            "commands.verification is the complete ordered list used at baseline and after implementation; replace stale commands from other ecosystems.",
            "Prefer the existing currentSettings when they already match the evidence.",
            "Use {filter} in commands.testTargetTemplate when the runner supports targeted tests; {filter} is a recorded test file path that the harness converts to a wildcard *ClassName pattern for --tests templates, so for Gradle prefer a quoted template such as gradlew test --tests \"{filter}\"; never invent shell pipelines.",
          ],
      expectedOutput: PROJECT_PROFILER_EXPECTED_OUTPUT,
      schema: ProjectProfilerOutputSchema,
      retrieval: false,
      buildPrompt: false,
      allowTools,
      signal: this.ctx.signalFor(state.runId),
    });

    VerificationSettingsPatchSchema.parse(output.configPatch);
    assertVerificationOnlyPatch(output.configPatch);
    const now = new Date().toISOString();
    const updated = await this.ctx.store.record(
      {
        ...state,
        branchName: branchName ?? state.branchName,
        phase: "awaiting_input",
        verificationReady: {
          summary: output.summary,
          proposedPatch: output.configPatch,
          currentSettings,
          evidence,
          readyAt: now,
        },
      },
      "verification.proposed",
      { summary: output.summary },
    );
    await this.ctx.syncArtifacts(updated);
    return updated;
  }
}

function baselineFailureSummary(evidence: CommandEvidence): string {
  const output = `${evidence.stdout}\n${evidence.stderr}`;
  if (/command not found|not recognized/i.test(output)) {
    return `Baseline test command could not be launched: ${evidence.command}`;
  }
  if (evidence.exitCode === 124 || /timed out/i.test(output)) {
    return `Baseline test command timed out: ${evidence.command}`;
  }
  return `Baseline test command failed (exit ${evidence.exitCode}): ${evidence.command}`;
}

function currentVerificationSettings(ctx: ApplicationContext): VerificationSettingsSnapshot {
  return {
    workflow: { testPathPatterns: [...ctx.config.workflow.testPathPatterns] },
    commands: {
      verification: ctx.config.commands.verification.map((item) => ({ ...item })),
      ...(ctx.config.commands.testTargetTemplate
        ? { testTargetTemplate: ctx.config.commands.testTargetTemplate }
        : {}),
    },
  };
}

function assertVerificationOnlyPatch(patch: VerificationSettingsPatch): void {
  const keys = Object.keys(patch);
  for (const key of keys) {
    if (key !== "workflow" && key !== "commands") {
      throw new Error(`Verification patch rejects unrelated key: ${key}`);
    }
  }
  if (patch.workflow) {
    for (const key of Object.keys(patch.workflow)) {
      if (key !== "testPathPatterns") {
        throw new Error(`Verification patch rejects unrelated workflow key: ${key}`);
      }
    }
  }
  if (patch.commands) {
    for (const key of Object.keys(patch.commands)) {
      if (key !== "verification" && key !== "testTargetTemplate") {
        throw new Error(`Verification patch rejects unrelated commands key: ${key}`);
      }
    }
  }
  // Extra safety: ProjectSettingsPatch allows grill/git keys; refuse them here.
  ProjectSettingsPatchSchema.parse(patch);
  const asRecord = patch as Record<string, unknown>;
  if ("git" in asRecord) {
    throw new Error("Verification patch rejects git keys");
  }
}

function mergeVerificationPatch(
  current: VerificationSettingsSnapshot,
  patch: VerificationSettingsPatch,
): VerificationSettingsPatch {
  const next: VerificationSettingsPatch = {};
  if (patch.commands) {
    const verification = patch.commands.verification;
    next.commands = {
      ...(verification ? { verification } : {}),
      ...(patch.commands.testTargetTemplate
        ? { testTargetTemplate: patch.commands.testTargetTemplate }
        : {}),
    };
  }
  if (patch.workflow?.testPathPatterns != null) {
    next.workflow = { testPathPatterns: patch.workflow.testPathPatterns };
  }
  // Empty patch means keep current (caller handles no-op).
  if (!next.commands && !next.workflow) {
    return {
      commands: {
        verification: current.commands.verification,
        ...(current.commands.testTargetTemplate
          ? { testTargetTemplate: current.commands.testTargetTemplate }
          : {}),
      },
      workflow: { testPathPatterns: current.workflow.testPathPatterns },
    };
  }
  return next;
}

function verificationPatchChangesSettings(
  current: VerificationSettingsSnapshot,
  patch: VerificationSettingsPatch,
): boolean {
  if (
    patch.commands?.verification != null &&
    JSON.stringify(patch.commands.verification) !== JSON.stringify(current.commands.verification)
  ) {
    return true;
  }
  if (
    patch.commands?.testTargetTemplate != null &&
    patch.commands.testTargetTemplate !== current.commands.testTargetTemplate
  ) {
    return true;
  }
  if (patch.workflow?.testPathPatterns != null) {
    const proposed = patch.workflow.testPathPatterns;
    const existing = current.workflow.testPathPatterns;
    if (
      proposed.length !== existing.length ||
      proposed.some((item, index) => item !== existing[index])
    ) {
      return true;
    }
  }
  return false;
}

function toProjectSettingsPatch(
  patch: VerificationSettingsPatch,
  current: VerificationSettingsSnapshot,
  keepCurrent: boolean,
): ProjectSettingsPatch {
  if (keepCurrent) {
    return {
      commands: {
        verification: current.commands.verification,
        ...(current.commands.testTargetTemplate
          ? { testTargetTemplate: current.commands.testTargetTemplate }
          : {}),
      },
      workflow: { testPathPatterns: current.workflow.testPathPatterns },
    };
  }
  const merged = mergeVerificationPatch(current, patch);
  return ProjectSettingsPatchSchema.parse(merged);
}

function pathRelativeToRepo(repositoryRoot: string, configPath: string): string | undefined {
  const relative = path.relative(repositoryRoot, configPath).replaceAll("\\", "/");
  if (!relative || relative.startsWith("..")) return undefined;
  return relative;
}
