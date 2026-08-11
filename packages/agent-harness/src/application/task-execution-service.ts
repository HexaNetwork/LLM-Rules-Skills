import { writeRunWorkspace } from "../config.js";
import {
  GREEN_IMPLEMENTER_EXPECTED_OUTPUT,
  GreenImplementerOutputSchema,
  MessageOutputSchema,
  RED_WRITER_EXPECTED_OUTPUT,
  RedWriterOutputSchema,
  REVIEW_EXPECTED_OUTPUT,
  ReviewOutputSchema,
  WorkerOutputSchema,
  assertCanMarkTaskDone,
  canAcceptRedContinue,
  canAcceptRedDone,
  canCompleteTddRound,
  canEnterFinalVerification,
  canRetryFinalRepair,
  canRetryRoundImplementation,
  canRouteTestIssue,
  canToggleTaskTdd,
  ensureTddLoop,
  includesSourcePath,
  isTestPath,
  pendingRoundNumber,
  proposeDeliveryBranchName,
  reviewRepairRoute,
  slugifyFeatureTitle,
  withCompletedTddRound,
  withFinalRepairCleared,
  withFinalRepairRouting,
  withGreenImplementerSession,
  withIncrementedRoundImplementerAttempt,
  withRedWriterSession,
  withTestRepairPendingRound,
  type BuildTask,
  type GreenImplementerOutput,
  type MessageOutput,
  type RunState,
  isTerminalPhase,
} from "../domain.js";
import { isShellToolName } from "../infrastructure/agents/step-utils.js";

const terminal = isTerminalPhase;
import { CONFIG_FAILURE_PATTERN, HarnessFailure, RunCancelledError } from "../errors.js";
import { commandEvidence, recentEvidenceOutput } from "../commands.js";
import { compactDomainSeed } from "../knowledge.js";
import { prepareGraphifyForRun } from "../graphify.js";
import { taskFrontier } from "../tracker.js";
import type { ApplicationContext } from "./application-context.js";
import type { InvocationKind } from "./agent-activity.js";
import {
  evaluateRepairProgress,
  evidenceFingerprint,
  failingTestIdsFromEvidence,
  failureCategoryFromEvidence,
  repairEdgeKey,
} from "./evidence-fingerprint.js";
import { normalizePathKey, taskForPacket, unique } from "./helpers.js";
import { updateRunConfig } from "./update-run-config.js";

export class TaskExecutionService {
  constructor(private readonly ctx: ApplicationContext) {}

  async execute(state: RunState): Promise<RunState> {
    const failed = state.tasks.find((task) => task.status === "failed");
    if (failed) {
      const detail = failed.failure ?? "unknown failure";
      const kind = CONFIG_FAILURE_PATTERN.test(detail) ? "config" : "contract";
      throw new HarnessFailure(`Task ${failed.id} failed: ${detail}`, kind, false);
    }
    const active = state.tasks.find((task) => task.status === "active");
    if (!active) {
      if (state.tasks.every((item) => item.status === "done")) {
        return this.ctx.store.record({ ...state, phase: "publishing" }, "implementation.completed");
      }
      if (await this.ctx.isStopRequested(state.runId, state)) {
        const stopped = await this.ctx.store.record(
          {
            ...state,
            stopAfterTask: false,
            stoppedAfterTaskAt: new Date().toISOString(),
          },
          "run.stopped_after_task",
        );
        await this.ctx.clearStopRequest(state.runId);
        return stopped;
      }
      if (state.stoppedAfterTaskAt) {
        return state;
      }
    }
    const task = active ?? taskFrontier(state.tasks)[0];
    if (!task) {
      throw new HarnessFailure(
        "Build frontier is empty while pending tasks remain",
        "internal",
        false,
      );
    }
    return this.executeTaskStep(state, task);
  }

  async executeTaskStep(state: RunState, task: BuildTask): Promise<RunState> {
    switch (task.step) {
      case "pending": {
        const next = {
          ...task,
          status: "active" as const,
          step: task.tdd ? ("writing_tests" as const) : ("implementing" as const),
        };
        return this.updateTask(state, next, "task.started");
      }
      case "writing_tests":
        return this.writeTests(state, task);
      case "red":
        return this.confirmRed(state, task);
      case "implementing":
        return this.implementTask(state, task);
      case "verifying":
        return this.verifyTask(state, task);
      case "reviewing":
        return this.reviewTask(state, task);
      case "committing":
        return this.commitTask(state, task);
      case "done":
      case "failed":
        return state;
    }
  }

  async writeTests(state: RunState, task: BuildTask): Promise<RunState> {
    // A config repair can intentionally leave its project-settings file dirty.
    // Capture that known baseline before the writer runs so the path allowlist
    // attributes only paths introduced by this invocation to the writer.
    const knownPaths = this.ctx.config.git.enabled
      ? new Set(await this.ctx.git.changedFiles())
      : undefined;
    const testPatterns = this.ctx.config.workflow.testPathPatterns;

    // Crash re-entry: adopt a dangling RED checkpoint without re-invoking the agent.
    if (this.ctx.config.git.enabled) {
      const recovered = await this.ctx.git.findRedCheckpoint(task.id);
      if (recovered && recovered.sha !== task.redCheckpointSha) {
        const dirty = await this.ctx.git.changedFiles();
        const dirtyTests = dirty.filter((file) => isTestPath(file, testPatterns));
        if (dirtyTests.length === 0) {
          const priorTests = new Set(task.testPaths.map((file) => normalizePathKey(file)));
          const recoveredTestPaths = (
            recovered.paths.length > 0 ? recovered.paths : task.testPaths
          ).filter((file) => isTestPath(file, testPatterns));
          const testPathsAdded = recoveredTestPaths.filter(
            (file) => !priorTests.has(normalizePathKey(file)),
          );
          const added =
            testPathsAdded.length > 0 ? testPathsAdded : recoveredTestPaths;
          const loop = ensureTddLoop(task);
          const adopted: BuildTask = {
            ...task,
            redBaseSha: task.redBaseSha ?? recovered.baseSha,
            redCheckpointSha: recovered.sha,
            redCheckpointNumber: (task.redCheckpointNumber ?? 0) + 1,
            redCheckpointPaths: unique([...task.redCheckpointPaths, ...recoveredTestPaths]),
            redCheckpointHistory: unique([...task.redCheckpointHistory, recovered.sha]),
            testPaths: unique([...task.testPaths, ...added]),
            tddLoop: {
              ...loop,
              atVerifiedGreen: false,
              pendingRound: {
                number: loop.round,
                mode: loop.pendingRound?.mode ?? "feature",
                redCheckpointSha: recovered.sha,
                testPathsAdded: added,
                behaviorsAdded: ["unknown/recovered"],
                edgeCasesAdded: [],
                implementerAttempts: loop.pendingRound?.implementerAttempts ?? 0,
                startedAt: new Date().toISOString(),
              },
            },
            step: "red",
            status: "active",
            failure: undefined,
          };
          return this.updateTask(
            await this.ctx.withTreeFingerprint(state),
            adopted,
            "task.red_checkpoint_recovered",
            {
              redCheckpointSha: recovered.sha,
              redBaseSha: adopted.redBaseSha,
            },
          );
        }
      }
    }

    let episode = task.tddLoop?.redWriterSession;
    const maxContextTurns = this.ctx.config.workflow.maxContextTurns;
    if (
      episode?.providerSessionId &&
      maxContextTurns > 0 &&
      (episode.turns ?? 0) >= maxContextTurns
    ) {
      const rotatedTurns = episode.turns;
      await this.ctx.agents.releaseProviderSession(episode.providerSessionId);
      state = await this.ctx.store.record(
        {
          ...state,
          tasks: state.tasks.map((item) =>
            item.id === task.id
              ? {
                  ...item,
                  tddLoop: item.tddLoop
                    ? { ...item.tddLoop, redWriterSession: undefined }
                    : undefined,
                }
              : item,
          ),
        },
        "task.tdd_context_rotated",
        {
          taskId: task.id,
          maxContextTurns,
          turns: rotatedTurns,
          role: "red-writer",
        },
      );
      task = {
        ...task,
        tddLoop: task.tddLoop
          ? { ...task.tddLoop, redWriterSession: undefined }
          : undefined,
      };
      episode = undefined;
    }
    const reuseContext =
      Boolean(episode?.providerSessionId) && (task.integrityViolationCount ?? 0) === 0;
    const invocationKind =
      task.attempts.tests > 0 ? ("continuation" as const) : ("initial" as const);
    const repairMode = task.tddLoop?.pendingRound?.mode === "test-repair";
    const fullInput = {
      task: taskForPacket(task),
      priorCommandOutput: recentEvidenceOutput(task.evidence),
      round: pendingRoundNumber(task.tddLoop),
      atVerifiedGreen: task.tddLoop?.atVerifiedGreen ?? false,
      ...(repairMode
        ? {
            redCheckpointSha: task.redCheckpointSha,
            redBaseSha: task.redBaseSha,
            repairMode: true,
          }
        : {}),
    };
    const invocation = await this.ctx.agents.invokeInEpisode({
      runId: state.runId,
      role: "red-writer",
      mode: "agent",
      objective: repairMode
        ? `Repair the defective tests for “${task.title}” (tests only; no commands)`
        : `Add the next coherent failing test batch for “${task.title}” (tests only; no commands)`,
      input: fullInput,
      continuationInput: reuseContext
        ? {
            round: pendingRoundNumber(task.tddLoop),
            instruction:
              "Add the next coherent test batch or return done. Do not run commands.",
          }
        : undefined,
      expectedOutput: RED_WRITER_EXPECTED_OUTPUT,
      schema: RedWriterOutputSchema,
      constraints: [
        "Edit tests only; do not add production scaffolds or implement behavior",
        "Do not run test, compile, build, lint, or verification commands",
        "Add a coherent batch (typically 3-5 tests) including relevant edge cases",
        "Return status continue when adding a batch, or done only at verified GREEN with no file changes",
      ],
      knowledgeQuery: [task.title, task.description, ...task.acceptanceCriteria].join(" "),
      knowledgeFallbackQuery: compactDomainSeed(
        state.idea,
        state.reflectBrief?.confirmed,
        task.title,
        task.description,
      ),
      providerSessionId: reuseContext ? episode?.providerSessionId : undefined,
      previousGuidanceFingerprint: reuseContext ? episode?.guidanceFingerprint : undefined,
      signal: this.ctx.signalFor(state.runId),
      causal: {
        taskId: task.id,
        phase: state.phase,
        taskStep: task.step,
        invocationKind,
        trigger: {
          event: "task.writing_tests",
          classification: invocationKind,
          summary:
            invocationKind === "continuation"
              ? "continued red-writer episode"
              : "initial red-writer episode",
          evidenceFingerprint: task.evidenceFingerprint,
        },
      },
    });
    const shellTools = invocation.observedToolNames.filter(isShellToolName);
    if (shellTools.length > 0) {
      throw new HarnessFailure(
        `Red writer used command-execution tools: ${[...new Set(shellTools)].join(", ")}`,
        "contract",
        true,
      );
    }
    const result = invocation.value;
    task = {
      ...task,
      tddLoop: withRedWriterSession(task.tddLoop, {
        providerSessionId: invocation.providerSessionId,
        guidanceFingerprint:
          invocation.guidanceFingerprint ?? episode?.guidanceFingerprint,
        turns: (episode?.turns ?? 0) + 1,
      }),
    };

    const observedPaths = this.ctx.config.git.enabled
      ? (await this.ctx.git.changedFiles()).filter((file) => !knownPaths!.has(file))
      : result.changedFiles;
    const dirtyTestPaths = observedPaths.filter((file) => isTestPath(file, testPatterns));
    const dirtyNonTestPaths = observedPaths.filter((file) => !isTestPath(file, testPatterns));
    if (dirtyNonTestPaths.length > 0) {
      throw new HarnessFailure(
        `Red writer changed non-test paths: ${dirtyNonTestPaths.join(", ")}`,
        "config",
        false,
      );
    }

    const attempts = { ...task.attempts, tests: task.attempts.tests + 1 };

    if (result.status === "continue") {
      const guard = canAcceptRedContinue({
        output: result,
        dirtyTestPaths,
        dirtyNonTestPaths,
      });
      if (!guard.ok) {
        throw new HarnessFailure(guard.reason, "contract", true);
      }
      const testPaths = unique([...task.testPaths, ...dirtyTestPaths]);
      let updated: BuildTask = {
        ...task,
        attempts,
        testPaths,
        changedFiles: unique([...task.changedFiles, ...result.changedFiles, ...dirtyTestPaths]),
        step: "red",
        status: "active",
        failure: undefined,
      };
      updated = await this.establishRedCheckpoint(updated, dirtyTestPaths);
      const loop = ensureTddLoop(updated);
      const keepRepair = loop.pendingRound?.mode === "test-repair";
      const acceptedTestRepairFingerprints = keepRepair
        ? unique([
            ...updated.acceptedTestRepairFingerprints,
            ...(updated.evidenceFingerprint ? [updated.evidenceFingerprint] : []),
          ])
        : updated.acceptedTestRepairFingerprints;
      updated = {
        ...updated,
        acceptedTestRepairFingerprints,
        // Clear so GREEN resume after repair is not false-blocked as no-progress.
        evidenceFingerprint: keepRepair ? undefined : updated.evidenceFingerprint,
        tddLoop: {
          ...loop,
          atVerifiedGreen: false,
          pendingRound: {
            number: loop.round,
            mode: keepRepair ? "test-repair" : "feature",
            redCheckpointSha: updated.redCheckpointSha,
            testPathsAdded: dirtyTestPaths,
            behaviorsAdded: result.behaviorsAdded,
            edgeCasesAdded: result.edgeCasesAdded,
            implementerAttempts: keepRepair
              ? (loop.pendingRound?.implementerAttempts ?? 0)
              : 0,
            startedAt: new Date().toISOString(),
          },
        },
      };
      let nextState = await this.ctx.withTreeFingerprint(state);
      if (keepRepair) {
        nextState = await this.ctx.store.record(nextState, "task.test_issue_repaired", {
          taskId: updated.id,
          round: updated.tddLoop?.pendingRound?.number,
          evidenceFingerprint: updated.evidenceFingerprint,
          testPathsAdded: dirtyTestPaths,
        });
      } else {
        nextState = await this.ctx.store.record(nextState, "task.tdd_round_started", {
          taskId: updated.id,
          round: updated.tddLoop?.pendingRound?.number,
          testPathsAdded: dirtyTestPaths,
          behaviorsAdded: result.behaviorsAdded.length,
          edgeCasesAdded: result.edgeCasesAdded.length,
        });
      }
      nextState = await this.ctx.store.record(nextState, "task.red_batch_recorded", {
        taskId: updated.id,
        round: updated.tddLoop?.pendingRound?.number,
        testPathsAdded: dirtyTestPaths,
        redCheckpointSha: updated.redCheckpointSha,
      });
      return this.updateTask(nextState, updated, "task.red_observed", {
        redCheckpointSha: updated.redCheckpointSha,
        redBaseSha: updated.redBaseSha,
      });
    }

    const loop = ensureTddLoop(task);
    const doneGuard = canAcceptRedDone({
      output: result,
      tddLoop: loop,
      dirtyPaths: observedPaths,
    });
    if (!doneGuard.ok) {
      throw new HarnessFailure(doneGuard.reason, "contract", true);
    }
    const updated: BuildTask = {
      ...task,
      attempts,
      tddLoop: {
        ...loop,
        coverage: {
          ...loop.coverage,
          finalAssessment: {
            acceptanceCriteria: result.acceptanceCoverage,
            edgeCaseRationale: result.edgeCaseRationale,
          },
        },
      },
      step: "verifying",
      status: "active",
      failure: undefined,
    };
    let nextState = await this.ctx.withTreeFingerprint(state);
    nextState = await this.ctx.store.record(nextState, "task.tdd_done_declared", {
      taskId: updated.id,
      round: loop.round,
      completedRounds: loop.completedRounds.length,
      atVerifiedGreen: true,
    });
    return this.updateTask(nextState, updated, "task.red_done", { atVerifiedGreen: true });
  }

  async confirmRed(state: RunState, task: BuildTask): Promise<RunState> {
    if (!task.tddLoop?.pendingRound) {
      throw new HarnessFailure(
        "confirmRed requires an open pending TDD round",
        "internal",
        false,
      );
    }
    if (this.ctx.config.git.enabled) {
      if (!task.redCheckpointSha) {
        throw new HarnessFailure(
          "confirmRed requires a recorded RED checkpoint",
          "internal",
          false,
        );
      }
      const existing = await this.ctx.git.findRedCheckpoint(task.id);
      if (!existing || existing.sha !== task.redCheckpointSha) {
        throw new HarnessFailure(
          "RED checkpoint missing or mismatched; writeTests owns dangling-checkpoint recovery",
          "internal",
          false,
        );
      }
    }
    return this.updateTask(
      state,
      { ...task, step: "implementing" },
      "task.red_confirmed",
    );
  }

  async implementTask(state: RunState, task: BuildTask): Promise<RunState> {
    const latestEvidence = task.evidence.at(-1);
    const category = failureCategoryFromEvidence(latestEvidence, "verification");
    const pendingAttempts = task.tddLoop?.pendingRound?.implementerAttempts ?? 0;
    // In-round GREEN retries keep the same failing evidence + tree until the agent runs again;
    // the per-round implementerAttempts budget bounds those retries. Apply the deterministic
    // no-progress gate for cross-role returns (review) and fresh entries, not mid-round retries.
    const inRoundGreenRetry = Boolean(task.tdd && pendingAttempts > 0);
    const inFinalRepairRetry = Boolean(task.tdd && task.tddLoop?.finalRepairPending);
    const skipProgressGate =
      latestEvidence?.purpose === "guard:test-integrity" ||
      inRoundGreenRetry ||
      inFinalRepairRetry;
    if (
      !skipProgressGate &&
      (task.attempts.implementation > 0 || task.reviewSummary)
    ) {
      const gate = await this.progressGate(task, "implementer", "implementer", latestEvidence);
      if (!gate.allowed) {
        return this.blockNoProgress(state, task, gate.fingerprint, gate.summary);
      }
    }

    let episode = task.tddLoop?.greenImplementerSession;
    const maxContextTurns = this.ctx.config.workflow.maxContextTurns;
    if (
      episode?.providerSessionId &&
      maxContextTurns > 0 &&
      (episode.turns ?? 0) >= maxContextTurns
    ) {
      const rotatedTurns = episode.turns;
      await this.ctx.agents.releaseProviderSession(episode.providerSessionId);
      state = await this.ctx.store.record(
        {
          ...state,
          tasks: state.tasks.map((item) =>
            item.id === task.id
              ? {
                  ...item,
                  tddLoop: item.tddLoop
                    ? { ...item.tddLoop, greenImplementerSession: undefined }
                    : undefined,
                }
              : item,
          ),
        },
        "task.tdd_context_rotated",
        {
          taskId: task.id,
          maxContextTurns,
          turns: rotatedTurns,
          role: "green-implementer",
        },
      );
      task = {
        ...task,
        tddLoop: task.tddLoop
          ? { ...task.tddLoop, greenImplementerSession: undefined }
          : undefined,
      };
      episode = undefined;
    }
    const reuseContext =
      Boolean(episode?.providerSessionId) && (task.integrityViolationCount ?? 0) === 0;
    const invocationKind: InvocationKind =
      pendingAttempts > 0 || task.attempts.implementation > 0 || task.reviewSummary
        ? "implementation-repair"
        : episode?.providerSessionId
          ? "continuation"
          : "initial";
    const pending = task.tddLoop?.pendingRound;
    const protectedTests =
      task.redCheckpointPaths.length > 0 ? task.redCheckpointPaths : task.testPaths;
    const testCommand = this.resolvedTestCommand(task);
    const fullImplementerInput = task.tdd
      ? {
          task: taskForPacket(task),
          round: pendingRoundNumber(task.tddLoop),
          testPathsAdded: pending?.testPathsAdded ?? [],
          allProtectedTestPaths: protectedTests,
          behaviorsAdded: pending?.behaviorsAdded ?? [],
          edgeCasesAdded: pending?.edgeCasesAdded ?? [],
          testCommand,
          verifiedCommandOutput: recentEvidenceOutput(task.evidence),
          reviewFeedback: task.reviewSummary,
        }
      : {
          task: taskForPacket(task),
          verifiedCommandOutput: recentEvidenceOutput(task.evidence),
          reviewFeedback: task.reviewSummary,
        };
    const continuationInput = reuseContext
      ? task.tdd
        ? {
            round: pendingRoundNumber(task.tddLoop),
            testPathsAdded: pending?.testPathsAdded ?? [],
            behaviorsAdded: pending?.behaviorsAdded ?? [],
            edgeCasesAdded: pending?.edgeCasesAdded ?? [],
            testCommand,
            lastGreenSummary:
              task.tddLoop?.completedRounds.at(-1)?.outcome === "already-covered"
                ? `Round ${task.tddLoop.completedRounds.at(-1)!.number} already covered`
                : task.tddLoop?.completedRounds.length
                  ? `Round ${task.tddLoop.completedRounds.at(-1)!.number} independently verified`
                  : undefined,
            verifiedCommandOutput: recentEvidenceOutput(task.evidence),
            reviewFeedback: task.reviewSummary,
            instruction: "Implement this round without modifying tests.",
          }
        : {
            verifiedCommandOutput: recentEvidenceOutput(task.evidence),
            reviewFeedback: task.reviewSummary,
            instruction: "Continue from the latest verified command output and review feedback.",
          }
      : undefined;

    state = await this.ctx.store.record(state, "task.green_requested", {
      taskId: task.id,
      round: pendingRoundNumber(task.tddLoop),
      invocationKind,
      reuseContext,
    });

    const invocation = await this.ctx.agents.invokeInEpisode({
      runId: state.runId,
      role: "implementer",
      mode: "agent",
      objective: `Implement or repair the behavior in “${task.title}”`,
      input: fullImplementerInput,
      continuationInput,
      expectedOutput: task.tdd ? GREEN_IMPLEMENTER_EXPECTED_OUTPUT : "{summary,changedFiles}",
      schema: task.tdd ? GreenImplementerOutputSchema : WorkerOutputSchema,
      constraints: ["Do not commit", "Do not weaken tests", "Stop after this one task"],
      knowledgeQuery: [task.title, task.description, ...task.acceptanceCriteria].join(" "),
      knowledgeFallbackQuery: compactDomainSeed(
        state.idea,
        state.reflectBrief?.confirmed,
        task.title,
        task.description,
      ),
      providerSessionId: reuseContext ? episode?.providerSessionId : undefined,
      previousGuidanceFingerprint: reuseContext ? episode?.guidanceFingerprint : undefined,
      signal: this.ctx.signalFor(state.runId),
      causal: {
        taskId: task.id,
        phase: state.phase,
        taskStep: task.step,
        invocationKind,
        trigger: {
          event:
            pendingAttempts > 0 || task.attempts.implementation > 0 || task.reviewSummary
              ? "task.implementation_repair_needed"
              : "task.implementing",
          classification: category,
          summary:
            pendingAttempts > 0 || task.attempts.implementation > 0 || task.reviewSummary
              ? "implementation repair from verification evidence"
              : "initial implementation",
          evidenceFingerprint: task.evidenceFingerprint,
        },
      },
    });
    const result = invocation.value;
    task = {
      ...task,
      tddLoop: withGreenImplementerSession(task.tddLoop, {
        providerSessionId: invocation.providerSessionId,
        guidanceFingerprint: invocation.guidanceFingerprint ?? episode?.guidanceFingerprint,
        turns: (episode?.turns ?? 0) + 1,
      }),
    };

    if (task.tdd) {
      return this.finishTddGreenRound(state, task, result as GreenImplementerOutput);
    }

    const workerResult = result as { summary: string; changedFiles: string[] };
    const integrity = await this.enforceTestIntegrity(state, task, workerResult.changedFiles);
    state = integrity.state;
    task = integrity.task;
    if (integrity.restoredOnly) {
      return state;
    }

    const evidence = await this.runTargetedTest(state.runId, task, "test");
    const attempts = {
      ...task.attempts,
      implementation: task.attempts.implementation + 1,
    };
    if (evidence.passed) {
      const updated: BuildTask = {
        ...task,
        attempts,
        changedFiles: unique([...task.changedFiles, ...workerResult.changedFiles]),
        evidence: [...task.evidence, evidence],
        step: "verifying",
        status: "active",
        failure: undefined,
        reviewSummary: undefined,
      };
      return this.updateTask(
        await this.ctx.withTreeFingerprint(state),
        updated,
        "task.green_observed",
      );
    }

    const fingerprint = await this.fingerprintFor(task, evidence, "verification");
    const exhausted = attempts.implementation >= this.ctx.config.workflow.maxImplementationAttempts;
    const edge = repairEdgeKey(fingerprint, "implementer", "implementer");
    const updated: BuildTask = {
      ...task,
      attempts,
      changedFiles: unique([...task.changedFiles, ...workerResult.changedFiles]),
      evidence: [...task.evidence, evidence],
      evidenceFingerprint: fingerprint,
      seenEvidenceFingerprints: unique([...task.seenEvidenceFingerprints, fingerprint]),
      seenRepairEdges: unique([...task.seenRepairEdges, edge]),
      step: exhausted ? "failed" : "implementing",
      status: exhausted ? "failed" : "active",
      failure: exhausted
        ? `Targeted test failed after ${attempts.implementation} implementation attempts`
        : undefined,
    };
    return this.updateTask(
      await this.ctx.withTreeFingerprint(state),
      updated,
      exhausted ? "task.implementation_exhausted" : "task.implementation_repair_needed",
      { evidenceFingerprint: fingerprint },
    );
  }

  private async finishTddGreenRound(
    state: RunState,
    task: BuildTask,
    result: GreenImplementerOutput,
  ): Promise<RunState> {
    const integrity = await this.enforceTestIntegrity(state, task, result.changedFiles);
    state = integrity.state;
    task = integrity.task;
    if (integrity.restoredOnly) {
      return state;
    }

    const attempts = {
      ...task.attempts,
      implementation: task.attempts.implementation + 1,
    };

    if (result.status === "test_issue") {
      const routeGuard = canRouteTestIssue({ output: result, tddLoop: ensureTddLoop(task) });
      if (!routeGuard.ok) {
        throw new HarnessFailure(routeGuard.reason, "contract", true);
      }
      const issueEvidence = {
        purpose: "tdd:test-issue",
        command: "agent-reported",
        exitCode: 1,
        passed: false,
        stdout: "",
        stderr: `${result.testPath}: ${result.reason}`.slice(0, 500),
        durationMs: 0,
        at: new Date().toISOString(),
      };
      const fingerprint = await this.fingerprintFor(
        { ...task, reviewSummary: result.reason },
        issueEvidence,
        "test-issue",
      );
      if (task.acceptedTestRepairFingerprints.includes(fingerprint)) {
        return this.blockNoProgress(
          state,
          {
            ...task,
            attempts,
            changedFiles: unique([...task.changedFiles, ...result.changedFiles]),
            evidence: [...task.evidence, issueEvidence],
          },
          fingerprint,
          "Identical test issue already repaired once for this task",
        );
      }
      const edge = repairEdgeKey(fingerprint, "implementer", "red-writer");
      const gate = evaluateRepairProgress({
        fingerprint,
        lastFingerprint: task.evidenceFingerprint,
        seenFingerprints: task.seenEvidenceFingerprints,
        seenEdges: task.seenRepairEdges,
        fromRole: "implementer",
        toRole: "red-writer",
      });
      if (!gate.allowed) {
        return this.blockNoProgress(
          state,
          {
            ...task,
            attempts,
            changedFiles: unique([...task.changedFiles, ...result.changedFiles]),
            evidence: [...task.evidence, issueEvidence],
          },
          gate.fingerprint,
          gate.summary,
        );
      }
      const updated: BuildTask = {
        ...task,
        attempts,
        changedFiles: unique([...task.changedFiles, ...result.changedFiles]),
        evidence: [...task.evidence, issueEvidence],
        evidenceFingerprint: fingerprint,
        // Edge tracks the report; acceptedTestRepairFingerprints tracks one accepted repair.
        // Do not put F in seenEvidenceFingerprints or GREEN resume after repair false-blocks.
        seenRepairEdges: unique([...task.seenRepairEdges, edge]),
        tddLoop: withTestRepairPendingRound(ensureTddLoop(task)),
        step: "writing_tests",
        status: "active",
        failure: undefined,
        reviewSummary: `test_issue: ${result.testPath}: ${result.reason}`.slice(0, 500),
      };
      return this.updateTask(
        await this.ctx.withTreeFingerprint(state),
        updated,
        "task.test_issue_reported",
        {
          round: pendingRoundNumber(updated.tddLoop),
          testPath: result.testPath,
          evidenceFingerprint: fingerprint,
        },
      );
    }

    const testPatterns = this.ctx.config.workflow.testPathPatterns;
    const productionChanges = result.changedFiles.filter(
      (file) => !isTestPath(file, testPatterns),
    );
    const alreadyGreenWithProduction =
      result.status === "already_green" && productionChanges.length > 0;
    const claimStatus =
      alreadyGreenWithProduction ? ("green" as const) : result.status;

    const evidence = await this.runTargetedTest(state.runId, task, "tdd:green");
    if (evidence.passed) {
      const loop = ensureTddLoop(task);
      if (loop.finalRepairPending) {
        const updated: BuildTask = {
          ...task,
          attempts,
          changedFiles: unique([...task.changedFiles, ...result.changedFiles]),
          evidence: [...task.evidence, evidence],
          tddLoop: withFinalRepairCleared(loop),
          step: "writing_tests",
          status: "active",
          failure: undefined,
          reviewSummary: undefined,
        };
        return this.updateTask(
          await this.ctx.withTreeFingerprint(state),
          updated,
          "task.green_observed",
          {
            finalRepair: true,
            finalRepairAttempts: loop.finalRepairAttempts,
          },
        );
      }
      const completeGuard = canCompleteTddRound({
        output: { ...result, status: claimStatus },
        tddLoop: loop,
        targetedEvidencePassed: true,
      });
      if (!completeGuard.ok) {
        throw new HarnessFailure(completeGuard.reason, "contract", true);
      }
      const outcome =
        claimStatus === "already_green" ? ("already-covered" as const) : ("implemented" as const);
      const tddLoop = withCompletedTddRound(loop, {
        outcome,
        completedAt: new Date().toISOString(),
      });
      const updated: BuildTask = {
        ...task,
        attempts,
        changedFiles: unique([...task.changedFiles, ...result.changedFiles]),
        evidence: [...task.evidence, evidence],
        tddLoop,
        step: "writing_tests",
        status: "active",
        failure: undefined,
        reviewSummary: alreadyGreenWithProduction
          ? "already_green claimed production changes; treated as green after verification"
          : undefined,
      };
      let nextState = await this.ctx.withTreeFingerprint(state);
      nextState = await this.ctx.store.record(nextState, "task.tdd_round_completed", {
        taskId: updated.id,
        round: loop.pendingRound?.number,
        outcome,
        testPathsAdded: loop.pendingRound?.testPathsAdded ?? [],
      });
      const event =
        claimStatus === "already_green" ? "task.green_already_covered" : "task.green_observed";
      return this.updateTask(nextState, updated, event, {
        round: loop.pendingRound?.number,
        outcome,
      });
    }

    const fingerprint = await this.fingerprintFor(task, evidence, "verification");
    const loop = ensureTddLoop(task);
    const edge = repairEdgeKey(fingerprint, "implementer", "implementer");
    if (loop.finalRepairPending && !loop.pendingRound) {
      const updated: BuildTask = {
        ...task,
        attempts,
        changedFiles: unique([...task.changedFiles, ...result.changedFiles]),
        evidence: [...task.evidence, evidence],
        evidenceFingerprint: fingerprint,
        seenEvidenceFingerprints: unique([...task.seenEvidenceFingerprints, fingerprint]),
        seenRepairEdges: unique([...task.seenRepairEdges, edge]),
        step: "implementing",
        status: "active",
        failure: undefined,
      };
      return this.updateTask(
        await this.ctx.withTreeFingerprint(state),
        updated,
        "task.green_rejected",
        { evidenceFingerprint: fingerprint, finalRepair: true },
      );
    }
    const tddLoop = withIncrementedRoundImplementerAttempt(loop);
    const canRetry = canRetryRoundImplementation(
      tddLoop,
      this.ctx.config.workflow.maxImplementationAttempts,
    );
    const updated: BuildTask = {
      ...task,
      attempts,
      changedFiles: unique([...task.changedFiles, ...result.changedFiles]),
      evidence: [...task.evidence, evidence],
      evidenceFingerprint: fingerprint,
      seenEvidenceFingerprints: unique([...task.seenEvidenceFingerprints, fingerprint]),
      seenRepairEdges: unique([...task.seenRepairEdges, edge]),
      tddLoop,
      step: canRetry ? "implementing" : "failed",
      status: canRetry ? "active" : "failed",
      failure: canRetry
        ? undefined
        : `Targeted test failed after ${tddLoop.pendingRound?.implementerAttempts ?? 0} implementation attempts in round ${pendingRoundNumber(tddLoop)}`,
    };
    return this.updateTask(
      await this.ctx.withTreeFingerprint(state),
      updated,
      canRetry ? "task.green_rejected" : "task.implementation_exhausted",
      { evidenceFingerprint: fingerprint, round: pendingRoundNumber(tddLoop) },
    );
  }

  async verifyTask(state: RunState, task: BuildTask): Promise<RunState> {
    if (task.tdd) {
      const entry = canEnterFinalVerification(task.tddLoop);
      if (!entry.ok) {
        throw new HarnessFailure(entry.reason, "contract", true);
      }
    }
    const evidence = [];
    for (const verification of this.ctx.config.commands.verification) {
      const result = await this.ctx.deps.commands.run(verification.command, {
        cwd: this.ctx.paths.workspaceRoot,
        timeoutMs: verification.timeoutMs,
        signal: this.ctx.signalFor(state.runId),
        ...this.ctx.commandEnvironmentOptions(),
      });
      if (result.cancelled) {
        throw new RunCancelledError(`Verification ${verification.id} cancelled`);
      }
      evidence.push(commandEvidence(`verification:${verification.id}`, result));
    }
    const passed = evidence.every((item) => item.passed);
    const maxAttempts = this.ctx.config.workflow.maxImplementationAttempts;
    const canRepair = task.tdd
      ? canRetryFinalRepair(task.tddLoop, maxAttempts)
      : task.attempts.implementation < maxAttempts;
    const tddLoop =
      !passed && canRepair && task.tdd
        ? withFinalRepairRouting(ensureTddLoop(task))
        : task.tddLoop;
    const updated: BuildTask = {
      ...task,
      evidence: [...task.evidence, ...evidence],
      tddLoop,
      step: passed ? "reviewing" : canRepair ? "implementing" : "failed",
      status: passed || canRepair ? "active" : "failed",
      failure:
        !passed && !canRepair
          ? "Command gates failed and implementation repair budget is exhausted"
          : undefined,
    };
    return this.updateTask(
      await this.ctx.withTreeFingerprint(state),
      updated,
      passed ? "task.gates_passed" : "task.gates_failed",
      task.tdd && !passed
        ? {
            finalRepairAttempts: tddLoop?.finalRepairAttempts,
            finalRepairPending: tddLoop?.finalRepairPending,
          }
        : {},
    );
  }

  async reviewTask(state: RunState, task: BuildTask): Promise<RunState> {
    const reviewBaseSha =
      task.tdd && this.ctx.config.git.enabled ? task.redBaseSha : undefined;
    const changedFiles = !this.ctx.config.git.enabled
      ? task.changedFiles
      : reviewBaseSha
        ? await this.ctx.git.changedFilesVersusRef(reviewBaseSha)
        : await this.ctx.git.changedFiles();
    const diffResult =
      this.ctx.config.git.enabled && changedFiles.length > 0
        ? await this.ctx.git.diffForPaths(
            changedFiles,
            this.ctx.config.workflow.reviewDiffCharacters,
            reviewBaseSha ? { baseRef: reviewBaseSha } : undefined,
          )
        : { diff: "", omittedFiles: [] as string[], truncated: false };
    const completedRounds = task.tddLoop?.completedRounds ?? [];
    const review = await this.ctx.agents.invoke({
      runId: state.runId,
      role: "reviewer",
      objective: `Independently review “${task.title}” against its acceptance criteria`,
      input: {
        task: taskForPacket(task),
        changedFiles,
        commandEvidence: recentEvidenceOutput(task.evidence),
        diff: diffResult.diff,
        diffOmittedFiles: diffResult.omittedFiles,
        ...(task.tdd
          ? {
              coverageAssessment: task.tddLoop?.coverage?.finalAssessment,
              completedRounds: completedRounds.map((round) => ({
                number: round.number,
                outcome: round.outcome,
                behaviorsAdded: round.behaviorsAdded,
                edgeCasesAdded: round.edgeCasesAdded,
                testPathsAdded: round.testPathsAdded,
              })),
              coverageLedger: {
                behaviors: task.tddLoop?.coverage?.behaviors ?? [],
                edgeCases: task.tddLoop?.coverage?.edgeCases ?? [],
              },
              reviewDiffBase: reviewBaseSha,
            }
          : {}),
      },
      expectedOutput: REVIEW_EXPECTED_OUTPUT,
      schema: ReviewOutputSchema,
      knowledgeQuery: [task.title, task.description, ...task.acceptanceCriteria].join(" "),
      signal: this.ctx.signalFor(state.runId),
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
    const reviewBudget = attempts.review < this.ctx.config.workflow.maxReviewAttempts;
    const maxAttempts = this.ctx.config.workflow.maxImplementationAttempts;
    const route = reviewRepairRoute(review.findings);
    const reviewSummary = [
      review.summary,
      ...review.findings.map(
        (finding) => `${finding.severity}/${finding.kind}: ${finding.message}`,
      ),
    ].join("\n");

    let step: BuildTask["step"] = "failed";
    let status: BuildTask["status"] = "failed";
    let failure: string | undefined =
      "Review failed and repair budget is exhausted";
    let tddLoop = task.tddLoop;

    if (approved) {
      step = "committing";
      status = "active";
      failure = undefined;
    } else if (task.tdd) {
      if (route === "test-coverage" && reviewBudget) {
        step = "writing_tests";
        status = "active";
        failure = undefined;
      } else if (route === "production" && reviewBudget && canRetryFinalRepair(tddLoop, maxAttempts)) {
        tddLoop = withFinalRepairRouting(ensureTddLoop(task));
        step = "implementing";
        status = "active";
        failure = undefined;
      } else if (route === "none" && reviewBudget) {
        // approved=false with only advisory findings: treat as production repair when budget remains.
        if (canRetryFinalRepair(tddLoop, maxAttempts)) {
          tddLoop = withFinalRepairRouting(ensureTddLoop(task));
          step = "implementing";
          status = "active";
          failure = undefined;
        }
      }
    } else {
      const canRepair =
        reviewBudget && task.attempts.implementation < maxAttempts;
      if (canRepair) {
        step = "implementing";
        status = "active";
        failure = undefined;
      }
    }

    const updated: BuildTask = {
      ...task,
      attempts,
      reviewSummary,
      tddLoop,
      step,
      status,
      failure,
    };
    // diffForPaths may run `git add --intent-to-add`, which changes porcelain; re-stamp so the
    // next advance does not false-block on workspace divergence.
    return this.updateTask(
      await this.ctx.withTreeFingerprint(state),
      updated,
      approved ? "task.review_passed" : "task.review_failed",
      task.tdd && !approved
        ? {
            reviewRepairRoute: route,
            finalRepairAttempts: tddLoop?.finalRepairAttempts,
            finalRepairPending: tddLoop?.finalRepairPending,
          }
        : {},
    );
  }

  async commitTask(state: RunState, task: BuildTask): Promise<RunState> {
    const fallback: MessageOutput = {
      subject: `feat: ${task.title}`.slice(0, 100),
      body: task.description,
    };
    const message = this.ctx.config.workflow.generateCommitMessages
      ? await this.message(
          state.runId,
          `Write the commit message for completed task “${task.title}”`,
          { task: taskForPacket(task), changedFiles: task.changedFiles, review: task.reviewSummary },
          fallback,
        )
      : MessageOutputSchema.parse(fallback);
    assertCanMarkTaskDone(task);
    const checkpointShas = unique([
      ...task.redCheckpointHistory,
      ...(task.redCheckpointSha ? [task.redCheckpointSha] : []),
    ]);
    const commitSha =
      checkpointShas.length > 0
        ? await this.ctx.git.squashCheckpointsIntoTaskCommit({
            taskId: task.id,
            message,
            reportedPaths: task.changedFiles,
            redCheckpointShas: checkpointShas,
            expectedBranch: state.branchName,
            baseSha: this.ctx.workspace.baseSha,
          })
        : await this.ctx.git.commitTask(task.id, message, task.changedFiles, {
            redCheckpointShas: checkpointShas,
          });
    const graphifyUpdated = includesSourcePath(
      task.changedFiles,
      this.ctx.config.knowledge.graphify.sourceExtensions,
    )
      ? await this.ctx.knowledge.rebuildRepositoryGraph()
      : false;
    return this.updateTask(
      await this.ctx.withTreeFingerprint(state),
      { ...task, status: "done", step: "done", commitSha },
      "task.committed",
      { commitSha, graphifyUpdated, redCheckpointShas: checkpointShas },
    );
  }

  async publish(state: RunState): Promise<RunState> {
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
    let working = state;
    if (this.ctx.config.git.enabled) {
      working = await this.ensureDeliveryBranchForPublish(working);
    }
    const pullRequestUrl =
      working.branchName && this.ctx.config.git.push
        ? await this.ctx.git.publish(working.branchName, message)
        : undefined;
    return this.ctx.store.record(
      { ...working, phase: "completed", pullRequestUrl },
      "run.completed",
      { pullRequestUrl },
    );
  }

  /**
   * Create the delivery branch immediately before push/PR (or at publication when push is off).
   * Retains explicit/legacy branch names; freezes the late-created name against later title edits.
   */
  private async ensureDeliveryBranchForPublish(state: RunState): Promise<RunState> {
    const existing = this.ctx.workspace.branchName ?? state.branchName;
    const title =
      state.reflectBrief?.confirmedStructured?.proposedTitle ??
      state.reflectBrief?.structured?.proposedTitle ??
      state.idea;
    const titleSlug = slugifyFeatureTitle(title);
    const branchName =
      existing ??
      proposeDeliveryBranchName({
        branchPrefix: this.ctx.config.git.branchPrefix,
        title,
        runId: state.runId,
      });

    const ensured = await this.ctx.store.withWorkspaceAdminLock(
      { runId: state.runId, action: "create-delivery-branch" },
      () => this.ctx.git.ensureDeliveryBranch(branchName),
    );

    const workspace = {
      ...this.ctx.workspace,
      branchName: ensured.branchName,
    };
    await writeRunWorkspace(this.ctx.config, state.runId, workspace);
    this.ctx.bindWorkspace(workspace);

    let next: RunState = { ...state, branchName: ensured.branchName };
    // Audit when we first register a delivery branch for this run (create or attach).
    if (!existing || ensured.created) {
      next = await this.ctx.store.record(next, "run.branch_created", {
        titleSlug,
        branchName: ensured.branchName,
        headSha: ensured.headSha,
        created: ensured.created,
        retainedExisting: Boolean(existing),
      });
    }
    return next;
  }

  async message(
    runId: string,
    objective: string,
    input: unknown,
    fallback: MessageOutput,
  ): Promise<MessageOutput> {
    try {
      return await this.ctx.agents.invoke({
        runId,
        role: "message-writer",
        objective,
        input,
        expectedOutput: "{subject,body}",
        schema: MessageOutputSchema,
        buildPrompt: false,
        retrieval: false,
        signal: this.ctx.signalFor(runId),
      });
    } catch (error) {
      if (error instanceof RunCancelledError || this.ctx.signalFor(runId)?.aborted) throw error;
      return MessageOutputSchema.parse(fallback);
    }
  }

  async runTargetedTest(runId: string, task: BuildTask, purpose: string) {
    const primary = this.ctx.config.commands.verification[0]!;
    let command = primary.command;
    if (task.testFilter) {
      const template = this.ctx.config.commands.testTargetTemplate;
      if (!template || !template.includes("{filter}")) {
        throw new HarnessFailure(
          `Task ${task.id} requires test filter ${task.testFilter}, but commands.testTargetTemplate is not configured`,
          "config",
          false,
        );
      }
      if (!/^[A-Za-z0-9_.$*?/:\\[\]{}-]+$/.test(task.testFilter)) {
        throw new HarnessFailure(
          `Task ${task.id} has an unsafe test filter`,
          "config",
          false,
        );
      }
      command = template.replaceAll("{filter}", task.testFilter);
    }
    const result = await this.ctx.deps.commands.run(command, {
      cwd: this.ctx.paths.workspaceRoot,
      timeoutMs: primary.timeoutMs,
      signal: this.ctx.signalFor(runId),
      ...this.ctx.commandEnvironmentOptions(),
    });
    if (result.cancelled) {
      throw new RunCancelledError(`Command cancelled: ${purpose}`);
    }
    return commandEvidence(purpose, result);
  }

  async updateTask(
    state: RunState,
    task: BuildTask,
    event: string,
    detail: Record<string, unknown> = {},
  ): Promise<RunState> {
    const next =
      task.status === "done" || task.status === "failed"
        ? await this.ctx.releaseTaskWorkerSessions(task)
        : task;
    return this.ctx.store.record(
      { ...state, tasks: state.tasks.map((item) => (item.id === next.id ? next : item)) },
      event,
      { taskId: next.id, step: next.step, ...detail },
    );
  }

  async setTdd(runId: string, tdd: boolean, taskId?: string): Promise<RunState> {
    return this.ctx.store.withLock(runId, async () => {
      let state = await this.ctx.store.load(runId);
      if (terminal(state.phase)) {
        throw new Error(`Run ${runId} is already ${state.phase}`);
      }

      if (taskId) {
        const task = state.tasks.find((item) => item.id === taskId);
        if (!task) throw new Error(`Unknown task id: ${taskId}`);
        if (!canToggleTaskTdd(task)) {
          throw new Error(
            `Cannot change TDD for task ${taskId} once past pending (step=${task.step})`,
          );
        }
        state = await this.updateTask(
          state,
          { ...task, tdd },
          "task.tdd_updated",
          { tdd },
        );
        await this.ctx.syncArtifacts(state);
        return state;
      }

      const previous = state.tasks;
      const tasks = previous.map((task) => (canToggleTaskTdd(task) ? { ...task, tdd } : task));
      const tasksUpdated = tasks.filter((task, index) => task.tdd !== previous[index]?.tdd).length;
      if (this.ctx.config.workflow.tdd === tdd) {
        state = await this.ctx.store.record(
          { ...state, tasks },
          "run.tdd_updated",
          { tdd, tasksUpdated },
        );
      } else {
        const result = await updateRunConfig(
          this.ctx,
          state.runId,
          state.configRevision ?? 0,
          { workflow: { tdd } },
          { reason: "tdd", detail: { tdd, tasksUpdated } },
          {
            alreadyLocked: true,
            transformState: (next) => ({ ...next, tasks }),
          },
        );
        state = result.state;
      }
      await this.ctx.syncArtifacts(state);
      return state;
    });
  }

  async setRag(runId: string, rag: boolean): Promise<RunState> {
    return this.ctx.store.withLock(runId, async () => {
      let state = await this.ctx.store.load(runId);
      if (terminal(state.phase)) {
        throw new Error(`Run ${runId} is already ${state.phase}`);
      }
      if (this.ctx.config.workflow.rag === rag) {
        return state;
      }
      const result = await updateRunConfig(
        this.ctx,
        state.runId,
        state.configRevision ?? 0,
        { workflow: { rag } },
        { reason: "rag", detail: { rag } },
        { alreadyLocked: true },
      );
      state = result.state;
      await this.ctx.syncArtifacts(state);
      return state;
    });
  }

  async setGraphify(runId: string, enabled: boolean): Promise<RunState> {
    return this.ctx.store.withLock(runId, async () => {
      let state = await this.ctx.store.load(runId);
      if (terminal(state.phase)) {
        throw new Error(`Run ${runId} is already ${state.phase}`);
      }
      if (this.ctx.config.knowledge.graphify.enabled === enabled) {
        return state;
      }
      const result = await updateRunConfig(
        this.ctx,
        state.runId,
        state.configRevision ?? 0,
        { knowledge: { graphify: { enabled } } },
        { reason: "graphify", detail: { enabled } },
        { alreadyLocked: true },
      );
      state = result.state;
      if (enabled) {
        await prepareGraphifyForRun(this.ctx.config, this.ctx.graphifyRunner, this.ctx.paths);
      }
      await this.ctx.syncArtifacts(state);
      return state;
    });
  }

  async setIgnoredArtifactPatterns(runId: string, patterns: string[]): Promise<RunState> {
    return this.ctx.store.withLock(runId, async () => {
      const state = await this.ctx.store.load(runId);
      if (state.phase === "completed" || state.phase === "cancelled") {
        throw new Error(`Run ${runId} is already ${state.phase}`);
      }
      const result = await updateRunConfig(
        this.ctx,
        state.runId,
        state.configRevision ?? 0,
        { git: { ignoredArtifactPatterns: unique(patterns) } },
        { reason: "ignored-artifacts", detail: { count: unique(patterns).length } },
        { alreadyLocked: true, allowNoChange: true },
      );
      await this.ctx.syncArtifacts(result.state);
      return result.state;
    });
  }

  private async establishRedCheckpoint(
    task: BuildTask,
    candidatePaths: string[],
  ): Promise<BuildTask> {
    if (!this.ctx.config.git.enabled) {
      return {
        ...task,
        redCheckpointPaths: unique([...task.redCheckpointPaths, ...candidatePaths]),
      };
    }
    const existing = await this.ctx.git.findRedCheckpoint(task.id);
    const testPatterns = this.ctx.config.workflow.testPathPatterns;
    const allowed = unique(
      (candidatePaths.length > 0 ? candidatePaths : task.testPaths).filter((file) =>
        isTestPath(file, testPatterns),
      ),
    );
    if (existing && task.redCheckpointSha === existing.sha) {
      // Allow a new checkpoint when dirty test paths advanced past the current HEAD checkpoint.
      const dirty = new Set(await this.ctx.git.changedFiles());
      const dirtyAllowed = allowed.filter((file) => dirty.has(file));
      if (dirtyAllowed.length === 0) {
        return task;
      }
    }
    if (existing && !task.redCheckpointSha) {
      return {
        ...task,
        redBaseSha: task.redBaseSha ?? existing.baseSha,
        redCheckpointSha: existing.sha,
        redCheckpointNumber: (task.redCheckpointNumber ?? 0) + 1,
        redCheckpointPaths: unique([
          ...task.redCheckpointPaths,
          ...(existing.paths.length > 0 ? existing.paths : allowed),
        ]),
        redCheckpointHistory: unique([...task.redCheckpointHistory, existing.sha]),
      };
    }
    const committed = await this.ctx.git.commitRedCheckpoint({
      taskId: task.id,
      taskTitle: task.title,
      paths: allowed.length > 0 ? allowed : task.testPaths,
      round: pendingRoundNumber(task.tddLoop),
    });
    if (!committed) return task;
    return {
      ...task,
      // Oldest checkpoint parent wins; never overwrite after round one.
      redBaseSha: task.redBaseSha ?? committed.baseSha,
      redCheckpointSha: committed.sha,
      redCheckpointNumber: (task.redCheckpointNumber ?? 0) + 1,
      redCheckpointPaths: unique([...task.redCheckpointPaths, ...committed.paths]),
      redCheckpointHistory: unique([...task.redCheckpointHistory, committed.sha]),
      changedFiles: unique([...task.changedFiles, ...committed.paths]),
      testPaths: unique([
        ...task.testPaths,
        ...committed.paths.filter((file) => isTestPath(file, testPatterns)),
      ]),
    };
  }

  private async enforceTestIntegrity(
    state: RunState,
    task: BuildTask,
    reportedChangedFiles: string[],
  ): Promise<{ state: RunState; task: BuildTask; restoredOnly: boolean }> {
    const testPatterns = this.ctx.config.workflow.testPathPatterns;
    // Integrity protects recorded test paths only — scaffolds may be replaced by the implementer.
    const recordedAll =
      task.redCheckpointPaths.length > 0 ? task.redCheckpointPaths : task.testPaths;
    const recorded = recordedAll.filter((file) => isTestPath(file, testPatterns));
    if (recorded.length === 0) {
      return { state, task, restoredOnly: false };
    }
    if (!this.ctx.config.git.enabled || !task.redCheckpointSha) {
      // Legacy / git-disabled fallback: detect reported or porcelain test edits.
      const observedPaths = this.ctx.config.git.enabled
        ? await this.ctx.git.changedFiles()
        : reportedChangedFiles;
      const touchedTests = observedPaths.filter((file) =>
        recorded.some((testPath) => normalizePathKey(testPath) === normalizePathKey(file)),
      );
      if (touchedTests.length === 0) {
        return { state, task, restoredOnly: false };
      }
      const attempts = {
        ...task.attempts,
        implementation: task.attempts.implementation + 1,
      };
      const exhausted = attempts.implementation >= this.ctx.config.workflow.maxImplementationAttempts;
      const failure = `Implementer modified recorded test files: ${touchedTests.join(", ")}`;
      const updated: BuildTask = {
        ...task,
        attempts,
        changedFiles: unique([...task.changedFiles, ...reportedChangedFiles]),
        evidence: [
          ...task.evidence,
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
      const nextState = await this.updateTask(
        await this.ctx.withTreeFingerprint(state),
        updated,
        "task.implementation_test_tamper",
        { passed: false },
      );
      return { state: nextState, task: updated, restoredOnly: true };
    }
    const touched = await this.ctx.git.pathsChangedVersusSha(task.redCheckpointSha, recorded);
    if (touched.length === 0) {
      return { state, task, restoredOnly: false };
    }
    await this.ctx.git.restorePathsFromSha(task.redCheckpointSha, touched);
    const dirtyAfter = await this.ctx.git.changedFiles();
    const productionDirty = dirtyAfter.filter(
      (file) =>
        !recorded.some((testPath) => normalizePathKey(testPath) === normalizePathKey(file)),
    );
    const violationCount = (task.integrityViolationCount ?? 0) + 1;
    const releaseContext = violationCount >= 2;
    let taskAfterRelease = task;
    if (releaseContext) {
      taskAfterRelease = await this.ctx.releaseTaskWorkerSessions(task);
    }
    const failIntegrity = violationCount >= 3 && productionDirty.length === 0;
    if (failIntegrity && !releaseContext) {
      taskAfterRelease = await this.ctx.releaseTaskWorkerSessions(taskAfterRelease);
    }
    const updated: BuildTask = {
      ...taskAfterRelease,
      integrityViolationCount: violationCount,
      tddLoop: taskAfterRelease.tddLoop,
      changedFiles: unique([...task.changedFiles, ...reportedChangedFiles, ...productionDirty]),
      evidence: [
        ...task.evidence,
        {
          purpose: "guard:test-integrity",
          command: "restore-from-red-checkpoint",
          exitCode: failIntegrity ? 1 : 0,
          passed: !failIntegrity,
          stdout: `Restored ${touched.join(", ")} from ${task.redCheckpointSha}`,
          stderr: failIntegrity ? "Repeated test integrity violations without production progress" : "",
          durationMs: 0,
          at: new Date().toISOString(),
        },
      ],
      reviewSummary: `Restored recorded tests from RED checkpoint: ${touched.join(", ")}`,
      step: failIntegrity ? "failed" : "implementing",
      status: failIntegrity ? "failed" : "active",
      failure: failIntegrity
        ? "Repeated test integrity violations without production progress"
        : undefined,
    };
    // Restoration alone does not consume an implementation attempt.
    const nextState = await this.updateTask(
      await this.ctx.withTreeFingerprint(state),
      updated,
      failIntegrity ? "task.test_integrity_exhausted" : "test_integrity.restored",
      {
        restoredPaths: touched,
        redCheckpointSha: task.redCheckpointSha,
        consumedImplementationAttempt: false,
        releasedProviderContext: releaseContext,
        kind: "test_integrity",
      },
    );
    return {
      state: nextState,
      task: updated,
      restoredOnly: failIntegrity || productionDirty.length === 0,
    };
  }

  private resolvedTestCommand(task: BuildTask): string {
    const primary = this.ctx.config.commands.verification[0]?.command ?? "(unconfigured)";
    if (!task.testFilter) return primary;
    const template = this.ctx.config.commands.testTargetTemplate;
    if (!template || !template.includes("{filter}")) return primary;
    return template.replaceAll("{filter}", task.testFilter);
  }

  private async fingerprintFor(
    task: BuildTask,
    evidence: BuildTask["evidence"][number] | undefined,
    fallbackCategory: string,
  ): Promise<string> {
    const gitEnabled = this.ctx.config.git.enabled;
    const sourceTreeState = gitEnabled ? await this.ctx.git.treeFingerprint() : "git-disabled";
    return evidenceFingerprint({
      taskId: task.id,
      step: task.step,
      sourceTreeState,
      redCheckpointSha: task.redCheckpointSha,
      failingTestIds: failingTestIdsFromEvidence(evidence),
      failureCategory:
        fallbackCategory === "test-issue"
          ? "test-issue"
          : failureCategoryFromEvidence(evidence, fallbackCategory),
      reviewFinding: task.reviewSummary,
      frozenConfigHash: this.ctx.config.workflow.maxImplementationAttempts.toString(),
      // Constant git-disabled tree state would otherwise collide across rounds.
      tddRound: gitEnabled ? undefined : pendingRoundNumber(task.tddLoop),
    });
  }

  private async progressGate(
    task: BuildTask,
    fromRole: string,
    toRole: string,
    evidence: BuildTask["evidence"][number] | undefined,
  ) {
    const fingerprint = await this.fingerprintFor(task, evidence, "verification");
    return evaluateRepairProgress({
      fingerprint,
      lastFingerprint: task.evidenceFingerprint,
      seenFingerprints: task.seenEvidenceFingerprints,
      seenEdges: task.seenRepairEdges,
      fromRole,
      toRole,
    });
  }

  private async blockNoProgress(
    state: RunState,
    task: BuildTask,
    fingerprint: string,
    summary: string,
  ): Promise<RunState> {
    const released = await this.ctx.releaseTaskWorkerSessions(task);
    const updated: BuildTask = {
      ...released,
      evidenceFingerprint: fingerprint,
      seenEvidenceFingerprints: unique([...released.seenEvidenceFingerprints, fingerprint]),
      step: "failed",
      status: "failed",
      failure: summary,
    };
    return this.updateTask(await this.ctx.withTreeFingerprint(state), updated, "task.no_progress", {
      evidenceFingerprint: fingerprint,
      kind: "no_progress",
    });
  }

}

