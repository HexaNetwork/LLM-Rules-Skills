import path from "node:path";
import type { RunManifest, ManifestTask } from "../schemas/manifest.js";
import type { Finding, FinalReport, RunState, VerifierReport } from "../schemas/reports.js";
import type { AgentPort, GitHubPort } from "../agents/ports.js";
import { allDependents } from "./dag.js";
import {
  allGatesPassed,
  runCommandGates,
  validatePathScope,
  writeAllowlistFiles,
} from "./gates.js";
import {
  appendEvent,
  assertResumeInvariants,
  blockTask,
  createInitialRunState,
  getTaskState,
  persistRunState,
  setRunStatus,
  updateTaskState,
} from "./state-machine.js";
import { createRunWorktree } from "./worktree.js";
import { changedFiles, commitAll, gitOk, revParse } from "../util/git.js";
import { ensureDir, writeJson } from "../util/fs.js";
import { FinalReportSchema } from "../schemas/reports.js";
import { formatDurationMs, harnessLog } from "../util/log.js";
import { acquireRunLock } from "../util/run-lock.js";

export type OrchestratorDeps = {
  agent: AgentPort;
  github?: GitHubPort;
  now?: () => Date;
};

function blockingFindings(report: VerifierReport): Finding[] {
  return report.findings.filter((finding) => finding.severity === "BLOCKING");
}

function advisoryFindings(report: VerifierReport): Finding[] {
  return report.findings.filter((finding) => finding.severity === "ADVISORY");
}

function acceptanceComplete(
  task: ManifestTask,
  report: VerifierReport,
): boolean {
  const byId = new Map(
    report.acceptance.map((item) => [item.criterionId, item] as const),
  );
  return task.acceptanceCriteria.every((criterion) => {
    const evidence = byId.get(criterion.id);
    return Boolean(evidence?.satisfied);
  });
}

function browserProbesPassed(
  task: ManifestTask,
  report: VerifierReport,
): boolean {
  if (task.browserProbes.length === 0) return true;
  const byId = new Map(
    report.browserProbeResults.map((item) => [item.probeId, item] as const),
  );
  return task.browserProbes.every((probe) => byId.get(probe.id)?.passed);
}

type ExecuteRunInput = {
  runId: string;
  manifest: RunManifest;
  runRoot: string;
  deps: OrchestratorDeps;
  resumeState?: RunState;
};

export async function executeRun(
  input: ExecuteRunInput,
): Promise<{ state: RunState; report: FinalReport }> {
  const directory = path.join(input.runRoot, input.runId);
  const releaseLock = await acquireRunLock(directory);
  try {
    return await executeRunUnlocked(input);
  } finally {
    await releaseLock();
  }
}

async function executeRunUnlocked(
  input: ExecuteRunInput,
): Promise<{ state: RunState; report: FinalReport }> {
  const started = Date.now();
  const { manifest, deps } = input;
  const config = manifest.configSnapshot;
  const directory = path.join(input.runRoot, input.runId);
  await ensureDir(directory);
  await writeJson(path.join(directory, "manifest.json"), manifest);

  let state =
    input.resumeState ?? createInitialRunState(input.runId, manifest);
  if (input.resumeState) {
    assertResumeInvariants({
      state: input.resumeState,
      manifestHash: manifest.manifestHash,
      worktreePath: input.resumeState.worktreePath,
      branchName: input.resumeState.branchName,
      headSha: input.resumeState.headSha,
    });
  }

  const worktree = await createRunWorktree({
    repoRoot: path.resolve(config.repositoryRoot),
    runDirectory: input.runRoot,
    runId: input.runId,
    baseBranch: config.baseBranch,
    branchPrefix: config.branchPrefix,
  });

  state = {
    ...state,
    status: "running",
    worktreePath: worktree.worktreePath,
    branchName: worktree.branchName,
    baseRef: worktree.baseRef,
    headSha: worktree.headSha,
  };
  state = await appendEvent(directory, state, {
    type: "run.started",
    detail: { branchName: worktree.branchName, worktreePath: worktree.worktreePath },
  });
  harnessLog("run.started", `run ${input.runId}`, {
    branch: worktree.branchName,
    worktree: worktree.worktreePath,
    tasks: manifest.taskOrder.length,
  });

  const allowlist = writeAllowlistFiles(config);
  await writeJson(path.join(directory, "permissions.json"), allowlist.permissions);
  await writeJson(path.join(directory, "sandbox.json"), allowlist.sandbox);

  const taskById = new Map(manifest.tasks.map((task) => [task.id, task]));

  for (const taskId of manifest.taskOrder) {
    const task = taskById.get(taskId)!;
    let runtime = getTaskState(state, taskId);
    if (
      runtime.status === "accepted" ||
      runtime.status === "blocked" ||
      runtime.status === "blocked_dependency" ||
      runtime.status === "skipped"
    ) {
      continue;
    }

    const unfinishedBlockers = task.blockedBy.filter((id) => {
      const status = getTaskState(state, id).status;
      return status !== "accepted";
    });
    if (unfinishedBlockers.length > 0) {
      const failedDeps = unfinishedBlockers.filter((id) => {
        const status = getTaskState(state, id).status;
        return status === "blocked" || status === "blocked_dependency";
      });
      if (failedDeps.length > 0) {
        state = blockTask(
          state,
          taskId,
          "BLOCKED_DEPENDENCY",
          `Blocked by failed dependency: ${failedDeps.join(", ")}`,
        );
        state = await appendEvent(directory, state, {
          type: "task.blocked_dependency",
          taskId,
          detail: { failedDeps },
        });
        await persistRunState(directory, state);
        continue;
      }
      // Dependencies not yet accepted and not failed — should not happen in sequential order
      state = blockTask(
        state,
        taskId,
        "PRECONDITION",
        `Dependencies not accepted: ${unfinishedBlockers.join(", ")}`,
      );
      continue;
    }

    if (deps.github && config.github && task.sourceRef) {
      const match = task.sourceRef.match(/#(\d+)$/) ?? task.id.match(/^gh-(\d+)$/);
      if (match?.[1] && config.github.assigneeLogin) {
        await deps.github.assignIssue(
          config.github.owner,
          config.github.repo,
          Number(match[1]),
          config.github.assigneeLogin,
        );
        await deps.github.setProjectStatus?.({
          owner: config.github.owner,
          repo: config.github.repo,
          issueNumber: Number(match[1]),
          status: config.github.statusInProgress,
        });
      }
    }

    state = updateTaskState(state, taskId, { status: "working" });
    state = await appendEvent(directory, state, { type: "task.working", taskId });
    harnessLog("task.working", task.title, {
      taskId,
      model: manifest.models.worker,
    });

    let accepted = false;
    while (!accepted) {
      runtime = getTaskState(state, taskId);
      harnessLog("worker.start", `launching worker for ${taskId}`, {
        resumeAgentId: runtime.workerAgentId,
        repair: Boolean(
          runtime.lastGateResults.some((g) => !g.passed) ||
            (runtime.lastVerifierReport &&
              blockingFindings(runtime.lastVerifierReport).length > 0),
        ),
      });
      const workerStarted = Date.now();
      const worker = await deps.agent.runWorker({
        model: manifest.models.worker,
        cwd: worktree.worktreePath,
        task,
        manifest,
        resumeAgentId: runtime.workerAgentId,
        repairContext:
          runtime.lastGateResults.some((g) => !g.passed) ||
          (runtime.lastVerifierReport &&
            blockingFindings(runtime.lastVerifierReport).length > 0)
            ? JSON.stringify({
                gateResults: runtime.lastGateResults,
                findings: runtime.lastVerifierReport
                  ? blockingFindings(runtime.lastVerifierReport)
                  : [],
              })
            : undefined,
      });
      harnessLog("worker.done", `worker returned for ${taskId}`, {
        agentId: worker.launch.agentId,
        runId: worker.launch.runId,
        elapsed: formatDurationMs(Date.now() - workerStarted),
        changedPaths: worker.report.changedPaths.length,
        summary: worker.report.summary.slice(0, 120),
      });
      state = {
        ...updateTaskState(state, taskId, {
          workerAgentId: worker.launch.agentId,
          lastWorkerReport: worker.report,
        }),
        cost: {
          ...state.cost,
          agentLaunches: state.cost.agentLaunches + 1,
          inputTokens:
            state.cost.inputTokens + (worker.launch.inputTokens ?? 0),
          outputTokens:
            state.cost.outputTokens + (worker.launch.outputTokens ?? 0),
        },
      };
      state = await appendEvent(directory, state, {
        type: "worker.finished",
        taskId,
        detail: {
          agentId: worker.launch.agentId,
          runId: worker.launch.runId,
          changedPaths: worker.report.changedPaths,
        },
      });

      const dirtyPaths = await changedFiles(worktree.worktreePath);
      harnessLog("paths.changed", `${dirtyPaths.length} dirty path(s)`, {
        taskId,
        sample: dirtyPaths.slice(0, 8),
      });
      const scope = validatePathScope(
        dirtyPaths,
        task.allowedGlobs,
        config.pathPolicy.protectedGlobs,
      );
      if (!scope.ok) {
        harnessLog("paths.fail", scope.detail, { taskId, reason: scope.reason });
        const repairs = runtime.commandRepairsUsed;
        if (repairs >= manifest.retries.commandOrSpecRepairs) {
          state = blockTask(state, taskId, scope.reason, scope.detail);
          await markDependentsBlocked(state, directory, manifest.tasks, taskId);
          state = await loadAndContinue(directory, state);
          break;
        }
        state = updateTaskState(state, taskId, {
          status: "repairing",
          commandRepairsUsed: repairs + 1,
          lastGateResults: [
            {
              gateId: "path-scope",
              command: "path-scope",
              exitCode: 1,
              passed: false,
              stdout: "",
              stderr: scope.detail,
              durationMs: 0,
            },
          ],
        });
        continue;
      }

      harnessLog("gates.start", `command gates for ${taskId}`, {
        count: config.commandGates.length,
      });
      const gateResults = await runCommandGates(
        config.commandGates,
        worktree.worktreePath,
      );
      state = updateTaskState(state, taskId, { lastGateResults: gateResults });
      if (!allGatesPassed(gateResults)) {
        harnessLog("gates.fail", `gates failed for ${taskId}`, {
          failed: gateResults
            .filter((g) => !g.passed)
            .map((g) => `${g.gateId}:${g.exitCode}`),
        });
        const repairs = getTaskState(state, taskId).commandRepairsUsed;
        if (repairs >= manifest.retries.commandOrSpecRepairs) {
          state = blockTask(
            state,
            taskId,
            "COMMAND_GATE_FAILED",
            gateResults
              .filter((g) => !g.passed)
              .map((g) => `${g.gateId}: exit ${g.exitCode}`)
              .join("; "),
          );
          state = await markDependentsBlocked(
            state,
            directory,
            manifest.tasks,
            taskId,
          );
          break;
        }
        state = updateTaskState(state, taskId, {
          status: "repairing",
          commandRepairsUsed: repairs + 1,
        });
        continue;
      }
      harnessLog("gates.pass", `all gates passed for ${taskId}`);

      state = updateTaskState(state, taskId, { status: "verifying" });
      harnessLog("verifier.start", `launching verifier for ${taskId}`);
      const verifierStarted = Date.now();
      const verifier = await deps.agent.runVerifier({
        model: manifest.models.verifier,
        cwd: worktree.worktreePath,
        task,
        changedPaths: dirtyPaths,
        resumeAgentId: getTaskState(state, taskId).verifierAgentId,
        repairFocus: getTaskState(state, taskId).lastVerifierReport
          ? blockingFindings(getTaskState(state, taskId).lastVerifierReport!)
          : undefined,
      });
      harnessLog("verifier.done", `verifier returned for ${taskId}`, {
        agentId: verifier.launch.agentId,
        elapsed: formatDurationMs(Date.now() - verifierStarted),
        blocking: blockingFindings(verifier.report).length,
        advisories: advisoryFindings(verifier.report).length,
      });
      state = {
        ...updateTaskState(state, taskId, {
          verifierAgentId: verifier.launch.agentId,
          lastVerifierReport: verifier.report,
          advisories: advisoryFindings(verifier.report),
        }),
        cost: {
          ...state.cost,
          agentLaunches: state.cost.agentLaunches + 1,
          inputTokens:
            state.cost.inputTokens + (verifier.launch.inputTokens ?? 0),
          outputTokens:
            state.cost.outputTokens + (verifier.launch.outputTokens ?? 0),
        },
      };
      state = await appendEvent(directory, state, {
        type: "verifier.finished",
        taskId,
        detail: {
          agentId: verifier.launch.agentId,
          runId: verifier.launch.runId,
          blocking: blockingFindings(verifier.report).map((f) => f.id),
        },
      });

      const blocking = blockingFindings(verifier.report);
      if (
        !acceptanceComplete(task, verifier.report) ||
        !browserProbesPassed(task, verifier.report) ||
        blocking.length > 0
      ) {
        const reason = !browserProbesPassed(task, verifier.report)
          ? "BROWSER_PROBE_FAILED"
          : !acceptanceComplete(task, verifier.report)
            ? "MISSING_ACCEPTANCE"
            : "BLOCKING_FINDING";
        harnessLog("verifier.reject", `task ${taskId} needs repair`, {
          reason,
          blocking: blocking.map((f) => f.id),
        });
        const repairs = getTaskState(state, taskId).reviewRepairsUsed;
        if (repairs >= manifest.retries.reviewRepairs) {
          state = blockTask(
            state,
            taskId,
            reason === "BLOCKING_FINDING" ? "REPAIR_BUDGET_EXHAUSTED" : reason,
            blocking.map((f) => f.id).join(", ") || reason,
          );
          state = await markDependentsBlocked(
            state,
            directory,
            manifest.tasks,
            taskId,
          );
          break;
        }

        // Fresh repair agent, then resume verifier
        harnessLog("repair.start", `review repair for ${taskId}`, {
          attempt: repairs + 1,
        });
        const repair = await deps.agent.runWorker({
          model: manifest.models.repair,
          cwd: worktree.worktreePath,
          task,
          manifest,
          repairContext: JSON.stringify({ reason, blocking }),
        });
        state = {
          ...updateTaskState(state, taskId, {
            status: "repairing",
            reviewRepairsUsed: repairs + 1,
            lastWorkerReport: repair.report,
          }),
          cost: {
            ...state.cost,
            agentLaunches: state.cost.agentLaunches + 1,
          },
        };
        continue;
      }

      const sha = await commitAll(
        worktree.worktreePath,
        `feat(${task.id}): ${task.title}`,
      );
      harnessLog("task.accepted", task.title, {
        taskId,
        commitSha: sha.slice(0, 12),
      });
      state = updateTaskState(state, taskId, {
        status: "accepted",
        commitSha: sha,
      });
      state = {
        ...state,
        headSha: sha,
      };
      state = await appendEvent(directory, state, {
        type: "task.accepted",
        taskId,
        detail: { commitSha: sha },
      });

      if (deps.github && config.github) {
        const match =
          task.sourceRef?.match(/#(\d+)$/) ?? task.id.match(/^gh-(\d+)$/);
        if (match?.[1]) {
          await deps.github.commentIssue(
            config.github.owner,
            config.github.repo,
            Number(match[1]),
            `Agent Harness accepted task \`${task.id}\` in commit ${sha}.`,
          );
          await deps.github.setProjectStatus?.({
            owner: config.github.owner,
            repo: config.github.repo,
            issueNumber: Number(match[1]),
            status: config.github.statusDone,
          });
        }
      }
      accepted = true;
    }

    await persistRunState(directory, state);
  }

  // Final branch gate
  const acceptedCount = state.tasks.filter((t) => t.status === "accepted").length;
  if (acceptedCount > 0) {
    let finalOk = false;
    while (!finalOk) {
      const gateResults = await runCommandGates(
        config.commandGates,
        worktree.worktreePath,
      );
      const branchPaths = await changedFiles(
        worktree.worktreePath,
        worktree.baseRef,
      );
      const adversarial = await deps.agent.runAdversarial({
        model: manifest.models.adversarial,
        cwd: worktree.worktreePath,
        baseRef: worktree.baseRef,
        changedPaths: branchPaths,
      });
      state = {
        ...state,
        cost: {
          ...state.cost,
          agentLaunches: state.cost.agentLaunches + 1,
        },
      };
      const blocking = blockingFindings(adversarial.report);
      if (allGatesPassed(gateResults) && blocking.length === 0) {
        finalOk = true;
        break;
      }
      if (state.finalBranchRepairsUsed >= manifest.retries.finalBranchRepairs) {
        state = setRunStatus(state, "partial");
        state = await appendEvent(directory, state, {
          type: "final_gate.failed",
          detail: {
            gates: gateResults.filter((g) => !g.passed).map((g) => g.gateId),
            findings: blocking.map((f) => f.id),
          },
        });
        break;
      }
      state = {
        ...state,
        finalBranchRepairsUsed: state.finalBranchRepairsUsed + 1,
      };
      await deps.agent.runWorker({
        model: manifest.models.repair,
        cwd: worktree.worktreePath,
        task: {
          id: "__branch__",
          title: "Final branch repair",
          mode: "AFK",
          body: "Repair final branch findings",
          acceptanceCriteria: [
            { id: "ac-1", text: "Resolve blocking final-gate findings" },
          ],
          blockedBy: [],
          allowedGlobs: config.pathPolicy.defaultAllowedGlobs,
          testSeams: [],
          browserProbes: [],
        },
        manifest,
        repairContext: JSON.stringify({ blocking, gateResults }),
      });
      await commitAll(
        worktree.worktreePath,
        "fix: agent-harness final branch repair",
      );
      state = { ...state, headSha: await revParse(worktree.worktreePath, "HEAD") };
    }

    if (finalOk && deps.github && config.github) {
      state = setRunStatus(state, "running");
      await gitOk(worktree.worktreePath, [
        "push",
        "-u",
        "origin",
        worktree.branchName,
      ]).catch(async (error) => {
        state = setRunStatus(state, "partial");
        state = await appendEvent(directory, state, {
          type: "publish.push_failed",
          detail: { error: String(error) },
        });
      });
      if (state.status !== "partial") {
        try {
          const pr = await deps.github.createPullRequest({
            owner: config.github.owner,
            repo: config.github.repo,
            title: `Agent Harness run ${input.runId}`,
            body: [
              "## Summary",
              `Agent Harness run \`${input.runId}\``,
              "",
              "### Tasks",
              ...state.tasks.map(
                (task) =>
                  `- ${task.taskId}: ${task.status}${task.commitSha ? ` (${task.commitSha.slice(0, 7)})` : ""}`,
              ),
            ].join("\n"),
            head: worktree.branchName,
            base: config.baseBranch,
          });
          state = { ...state, prUrl: pr.url };
          state = setRunStatus(
            state,
            state.tasks.every((t) => t.status === "accepted")
              ? "succeeded"
              : "partial",
          );
        } catch (error) {
          state = setRunStatus(state, "partial");
          state = await appendEvent(directory, state, {
            type: "publish.pr_failed",
            detail: { error: String(error) },
          });
        }
      }
    } else if (finalOk) {
      state = setRunStatus(
        state,
        state.tasks.every((t) => t.status === "accepted")
          ? "succeeded"
          : "partial",
      );
    }
  } else {
    state = setRunStatus(state, "blocked");
  }

  state = await appendEvent(directory, state, {
    type: "run.finished",
    detail: { status: state.status },
  });
  harnessLog("run.finished", `run ${input.runId} → ${state.status}`, {
    duration: formatDurationMs(Date.now() - started),
    agentLaunches: state.cost.agentLaunches,
    accepted: state.tasks.filter((t) => t.status === "accepted").length,
    blocked: state.tasks.filter(
      (t) => t.status === "blocked" || t.status === "blocked_dependency",
    ).length,
  });
  await persistRunState(directory, state);

  const report = FinalReportSchema.parse({
    contractVersion: "1",
    runId: input.runId,
    status: state.status,
    branchName: state.branchName,
    prUrl: state.prUrl,
    durationMs: Date.now() - started,
    tasks: state.tasks.map((task) => ({
      taskId: task.taskId,
      title: taskById.get(task.taskId)?.title,
      status: task.status,
      commitSha: task.commitSha,
      blockedReason: task.blockedReason,
      blockedDetail: task.blockedDetail,
      advisories: task.advisories,
    })),
    cost: state.cost,
    retries: {
      commandOrSpec: state.tasks.reduce(
        (sum, task) => sum + task.commandRepairsUsed,
        0,
      ),
      review: state.tasks.reduce((sum, task) => sum + task.reviewRepairsUsed, 0),
      finalBranch: state.finalBranchRepairsUsed,
      sdkStartup: 0,
    },
  });
  await writeJson(path.join(directory, "report.json"), report);
  await writeJson(
    path.join(directory, "report.md"),
    renderMarkdownReport(report),
  );
  return { state, report };
}

async function markDependentsBlocked(
  state: RunState,
  directory: string,
  tasks: ManifestTask[],
  taskId: string,
): Promise<RunState> {
  let next = state;
  for (const dep of allDependents(tasks, taskId)) {
    next = blockTask(
      next,
      dep,
      "BLOCKED_DEPENDENCY",
      `Upstream task ${taskId} blocked`,
    );
    next = await appendEvent(directory, next, {
      type: "task.blocked_dependency",
      taskId: dep,
      detail: { upstream: taskId },
    });
  }
  await persistRunState(directory, next);
  return next;
}

async function loadAndContinue(
  directory: string,
  state: RunState,
): Promise<RunState> {
  await persistRunState(directory, state);
  return state;
}

function renderMarkdownReport(report: FinalReport): string {
  return [
    `# Agent Harness report — ${report.runId}`,
    "",
    `Status: **${report.status}**`,
    report.branchName ? `Branch: \`${report.branchName}\`` : "",
    report.prUrl ? `PR: ${report.prUrl}` : "",
    `Duration: ${report.durationMs}ms`,
    "",
    "## Tasks",
    ...report.tasks.map(
      (task) =>
        `- ${task.taskId} (${task.status})${task.blockedReason ? ` — ${task.blockedReason}: ${task.blockedDetail ?? ""}` : ""}`,
    ),
    "",
    "## Cost",
    `- Agent launches: ${report.cost.agentLaunches}`,
    `- Tokens in/out: ${report.cost.inputTokens}/${report.cost.outputTokens}`,
    "",
  ]
    .filter(Boolean)
    .join("\n");
}
