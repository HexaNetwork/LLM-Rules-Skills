import path from "node:path";
import {
  ProjectSettingsPatchSchema,
  writeProjectSettings,
  type ProjectSettingsPatch,
} from "../config.js";
import {
  applyPlan,
  PlannerOutputSchema,
  ProjectProfilerOutputSchema,
  VerificationSettingsPatchSchema,
  type RunState,
  type VerificationSettingsPatch,
  type VerificationSettingsSnapshot,
} from "../domain.js";
import { HarnessFailure } from "../errors.js";
import { compactDomainSeed } from "../knowledge.js";
import type { ApplicationContext } from "./application-context.js";
import { applyFrozenConfigRepair } from "./frozen-config-repair.js";
import { pendingInstallApprovals, pendingVerificationReady } from "./helpers.js";
import {
  collectVerificationEvidence,
  verificationEvidenceNeedsTools,
} from "./verification-evidence.js";


export class PlanningService {
  constructor(private readonly ctx: ApplicationContext) {}

  async plan(state: RunState): Promise<RunState> {
    // Idempotent: start() (and commit-then-branch preflight) already cut the run
    // branch. Keep the guard here so resume/retry cannot plan on a drifted checkout.
    const branchName = await this.ctx.git.ensureRunBranch(state.runId);

    // Idempotent resume: a prior plan.created may have persisted tasks before a
    // post-planner workspace block. Do not re-invoke the planner.
    if (state.tasks.length > 0) {
      const phase = pendingInstallApprovals(state).length > 0 ? "awaiting_input" : "executing";
      return this.ctx.store.record(
        { ...state, branchName: branchName ?? state.branchName, phase },
        "plan.resumed",
        { tasks: state.tasks.length, pendingInstalls: pendingInstallApprovals(state).length },
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

    const output = await this.ctx.agents.invoke({
      runId: state.runId,
      role: "planner",
      objective:
        "Turn the confirmed brief and grill resolutions into dependency-ordered tracer-bullet implementation tickets",
      input: {
        confirmedBrief: state.reflectBrief?.confirmed,
        resolutions: state.grillResolutions,
        defaultTdd: this.ctx.config.workflow.tdd,
        defaultTestCommand: this.ctx.config.commands.test,
      },
      expectedOutput:
        "{summary,tasks:[{id,title,description,acceptanceCriteria,affectedPaths?,blockedBy,tdd?,testCommand?}],proposedInstalls?:[{id,manager,packages,reason,command?}]}",
      schema: PlannerOutputSchema,
      knowledgeQuery: [
        state.reflectBrief?.confirmed,
        compactDomainSeed(
          state.reflectBrief?.confirmed,
          ...state.grillResolutions.flatMap((item) => [item.question, item.answer, item.summary]),
        ),
      ]
        .filter(Boolean)
        .join(" "),
      knowledgeFallbackQuery: compactDomainSeed(
        state.reflectBrief?.confirmed,
        ...state.grillResolutions.flatMap((item) => [item.question, item.answer, item.summary]),
      ),
      signal: this.ctx.signalFor(state.runId),
    });
    const now = new Date().toISOString();
    const transition = applyPlan(state, output, now, {
      tdd: this.ctx.config.workflow.tdd,
      testCommand: this.ctx.config.commands.test,
      branchName,
    });

    // Planner sessions can still dirty the tree; persist the plan first so a
    // workspace block does not discard it, then refuse to enter executing.
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

    return this.ctx.store.persistTransition(state.runId, transition);
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
    return this.ctx.store.withRepositoryLock({ runId, action: "confirmVerification" }, () =>
      this.ctx.store.withLock(runId, async () => {
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
          const updated = await writeProjectSettings(options.configPath, projectPatch);
          const relative = pathRelativeToRepo(updated.config.repositoryRoot, options.configPath);
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
      }),
    );
  }

  private async proposeVerification(
    state: RunState,
    branchName: string | undefined,
  ): Promise<RunState> {
    const currentSettings = currentVerificationSettings(this.ctx);
    const evidence = await collectVerificationEvidence(
      this.ctx.config.repositoryRoot,
      currentSettings,
    );
    const allowTools = verificationEvidenceNeedsTools(evidence);
    const output = await this.ctx.agents.invoke({
      runId: state.runId,
      role: "project-profiler",
      objective:
        "Propose the smallest verification settings patch (test command and test path patterns) for this repository",
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
            "Return exactly one raw JSON object with top-level summary and configPatch fields; no Markdown or code fences.",
            "configPatch may only include workflow.testPathPatterns and/or commands.test.",
            "Propose a single test runner command — never invent shell pipelines.",
          ]
        : [
            "The work packet contains every fact needed. Do not call tools, inspect files, or search the repository.",
            "Return exactly one raw JSON object with top-level summary and configPatch fields; no Markdown or code fences.",
            "configPatch may only include workflow.testPathPatterns and/or commands.test.",
            "Prefer the existing currentSettings when they already match the evidence.",
            "Propose a single test runner command — never invent shell pipelines.",
          ],
      expectedOutput:
        '{"summary":"concise explanation","configPatch":{"workflow":{"testPathPatterns":[]},"commands":{"test":"…"}}}',
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

function currentVerificationSettings(ctx: ApplicationContext): VerificationSettingsSnapshot {
  return {
    workflow: { testPathPatterns: [...ctx.config.workflow.testPathPatterns] },
    commands: { test: ctx.config.commands.test },
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
      if (key !== "test") {
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
  if (patch.commands?.test != null) {
    next.commands = { test: patch.commands.test };
  }
  if (patch.workflow?.testPathPatterns != null) {
    next.workflow = { testPathPatterns: patch.workflow.testPathPatterns };
  }
  // Empty patch means keep current (caller handles no-op).
  if (!next.commands && !next.workflow) {
    return {
      commands: { test: current.commands.test },
      workflow: { testPathPatterns: current.workflow.testPathPatterns },
    };
  }
  return next;
}

function verificationPatchChangesSettings(
  current: VerificationSettingsSnapshot,
  patch: VerificationSettingsPatch,
): boolean {
  if (patch.commands?.test != null && patch.commands.test !== current.commands.test) {
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
      commands: { test: current.commands.test },
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
