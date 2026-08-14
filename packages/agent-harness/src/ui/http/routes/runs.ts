import path from "node:path";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HarnessConfigSchema, ProjectSettingsPatchSchema, type HarnessConfig } from "../../../config/schema.js";
import { loadRunConfig, loadRunWorkspace, writeProjectSettings } from "../../../config/io.js";
import { loadExternalProjectConfig } from "../../../application/external-config.js";
import { openRunHarness, type OpenedRunHarness } from "../../../application/run-engine-factory.js";
import { runInitialSetupThenAdvance } from "../../../application/run-setup.js";
import { HarnessEngine } from "../../../application/harness-engine.js";
import {
  mapHostActionToWorkerRpc,
  resolveDockerMutationProxy,
} from "../../../application/docker-run-proxy.js";
import { isDockerExecutionRuntime } from "../../../application/docker-worker-session.js";
import { completeDockerHostPublish } from "../../../application/docker-publish-service.js";
import { resolveRunBaseBranch } from "../../../application/run-base-branch.js";
import { HighLevelPlanSchema, VerificationSettingsPatchSchema } from "../../../domain.js";
import { HarnessFailure } from "../../../errors.js";
import { GitService, pathToIgnoredArtifactGlob } from "../../../git.js";
import type { UiAppContext } from "../context.js";
import {
  HttpError,
  json,
  optionalBoolean,
  optionalEnum,
  optionalNonNegativeNumber,
  optionalString,
  optionalStringArray,
  parseAnswerBody,
  readJsonBody,
  requiredString,
} from "../request.js";
import {
  allowedArtifact,
  listArtifacts,
  readActivity,
  readAgentActivity,
  readEvents,
  readExecutionImage,
  readInstallLog,
  readSessionDetail,
  readSessionSummaries,
  runSignature,
  summarizeRun,
} from "../run-reads.js";
import { PREFLIGHT_COMMIT_ORDER_VALUES, projectSettings } from "./settings.js";

type DockerImageAllowlistConfig = {
  execution?: {
    docker?: {
      workerImageDigest?: string;
      approvedBaseImages?: readonly string[];
    };
  };
};

/**
 * Dockerfile edits may intentionally adopt a newly prepared project worker while
 * the run/profile still records the previous digest. All three sources are
 * operator-controlled exact refs, so retain their union instead of letting a
 * stale profile replace current policy.
 */
export function executionDockerfileSaveAllowlist(input: {
  runConfig: DockerImageAllowlistConfig;
  projectConfig: DockerImageAllowlistConfig;
  profile?: { workerImage?: string; baseImage?: string };
}): string[] {
  return [
    input.runConfig.execution?.docker?.workerImageDigest,
    ...(input.runConfig.execution?.docker?.approvedBaseImages ?? []),
    input.projectConfig.execution?.docker?.workerImageDigest,
    ...(input.projectConfig.execution?.docker?.approvedBaseImages ?? []),
    input.profile?.workerImage,
    input.profile?.baseImage,
  ].filter(
    (value, index, values): value is string =>
      typeof value === "string" && value.length > 0 && values.indexOf(value) === index,
  );
}

/** Host-only image gate actions — no worker/container yet (workspace.json may be absent). */
const HOST_EXECUTION_IMAGE_ACTIONS = new Set([
  "save_execution_dockerfile",
  "approve_execution_image",
  "build_execution_image",
  "approve_and_build_execution_image",
]);

function runArtifactOptions(ctx: UiAppContext, runId: string) {
  return { runDirectory: ctx.store.runDirectory(runId) };
}

/**
 * `writeProjectSettings` → `loadConfig` resolves external `repositoryRoot: "."` to the
 * config directory (project state), wiping the stamped control root. Reload through
 * the registry merge path, or preserve the previous stamped roots.
 */
async function applyWrittenProjectSettings(
  ctx: UiAppContext,
  written: { config: HarnessConfig; path: string },
): Promise<HarnessConfig> {
  const previous = ctx.getProjectConfig();
  try {
    const reloaded = await loadExternalProjectConfig({
      repository: previous.repositoryRoot,
    });
    ctx.setProjectConfig(reloaded.config);
    return reloaded.config;
  } catch {
    const merged: HarnessConfig = {
      ...written.config,
      repositoryRoot: previous.repositoryRoot,
      stateDirectory: previous.stateDirectory,
      worktreeRoot: previous.worktreeRoot ?? written.config.worktreeRoot,
      knowledge: {
        ...written.config.knowledge,
        guidance: {
          ...written.config.knowledge.guidance,
          projectRoot:
            previous.knowledge.guidance.projectRoot ||
            written.config.knowledge.guidance.projectRoot,
          sharedRoot:
            previous.knowledge.guidance.sharedRoot ||
            written.config.knowledge.guidance.sharedRoot,
        },
      },
    };
    ctx.setProjectConfig(merged);
    return merged;
  }
}

async function isRunWorkspaceMissing(
  ctx: UiAppContext,
  runId: string,
): Promise<boolean> {
  try {
    await loadRunWorkspace(ctx.getProjectConfig(), runId, runArtifactOptions(ctx, runId));
    return false;
  } catch (error) {
    if (error instanceof HarnessFailure && /workspace metadata is missing/i.test(error.message)) {
      return true;
    }
    throw error;
  }
}

async function resolveBaseBranchOverride(
  projectConfig: ReturnType<UiAppContext["getProjectConfig"]>,
  baseBranch: string | undefined,
): Promise<string> {
  try {
    return await resolveRunBaseBranch(projectConfig, baseBranch);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : String(error));
  }
}

function initialSetupFromOpened(
  ctx: UiAppContext,
  runId: string,
  opened: OpenedRunHarness,
) {
  return {
    runId,
    config: opened.config,
    store: ctx.store,
    paths: opened.paths,
    repositoryIntelligenceRunner: ctx.repositoryIntelligenceRunner,
    git: opened.engine.git,
    knowledge: opened.engine.knowledge,
    advance: () => opened.engine.advance(runId),
    onProgress: (message: string) => ctx.jobs.setDetail(runId, message),
  };
}

/** @returns true when the request was handled. */
export async function handleRunsRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  ctx: UiAppContext,
): Promise<boolean> {
  if (request.method === "GET" && url.pathname === "/api/bootstrap") {
    const projectConfig = ctx.getProjectConfig();
    const { states: runs, failures } = await ctx.store.listWithFailures();
    const execution =
      ctx.getExecutionStatus !== undefined
        ? await ctx.getExecutionStatus()
        : {
            runtime: projectConfig.execution?.runtime ?? "local",
            ready: (projectConfig.execution?.runtime ?? "local") === "local",
            blockers: [],
          };
    json(response, 200, {
      project: {
        name: path.basename(projectConfig.repositoryRoot),
        root: projectConfig.repositoryRoot,
        configPath: ctx.configPath,
        models: projectConfig.models,
        agent: { provider: projectConfig.agent.provider, ...ctx.agentReadiness },
        execution,
        repositoryIntelligence: {
          enabled: projectConfig.knowledge.repositoryIntelligence.enabled,
          routes: projectConfig.knowledge.repositoryIntelligence.routes,
          providers: {
            gitnexus: {
              enabled: projectConfig.knowledge.repositoryIntelligence.providers.gitnexus.enabled,
              command: projectConfig.knowledge.repositoryIntelligence.providers.gitnexus.command,
            },
            codegraph: {
              enabled: projectConfig.knowledge.repositoryIntelligence.providers.codegraph.enabled,
              command: projectConfig.knowledge.repositoryIntelligence.providers.codegraph.command,
            },
          },
        },
        git: {
          enabled: projectConfig.git.enabled,
          baseBranch: projectConfig.git.enabled
            ? await resolveRunBaseBranch(projectConfig).catch(() => projectConfig.git.baseBranch)
            : projectConfig.git.baseBranch,
          branches: await new GitService(projectConfig).listLocalBranches(),
        },
        defaults: {
          rag: projectConfig.workflow.rag,
          push: projectConfig.git.push,
          openPullRequest: projectConfig.git.openPullRequest,
        },
        settings: projectSettings(projectConfig, ctx.configPath),
      },
      runs: runs.map((state) => summarizeRun(state, ctx.jobs.get(state.runId))),
      unreadableRuns: failures,
      jobs: ctx.jobs.values(),
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/runs") {
    const { states: runs, failures } = await ctx.store.listWithFailures();
    json(response, 200, {
      runs: runs.map((state) => summarizeRun(state, ctx.jobs.get(state.runId))),
      unreadableRuns: failures,
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/runs") {
    if (!ctx.agentReadiness.ready) {
      throw new HttpError(503, ctx.agentReadiness.message ?? "The configured agent backend is unavailable");
    }
    const projectConfig = ctx.getProjectConfig();
    if ((projectConfig.execution?.runtime ?? "local") === "docker") {
      const execution =
        ctx.getExecutionStatus !== undefined
          ? await ctx.getExecutionStatus({ force: true })
          : { ready: false, blockers: [{ message: "Execution status unavailable" }] };
      if (!execution.ready) {
        const detail = execution.blockers
          .map((blocker) => ("message" in blocker ? blocker.message : String(blocker)))
          .join("; ");
        throw new HttpError(
          503,
          detail || "Docker execution runtime is not ready for new runs",
        );
      }
    }
    const body = await readJsonBody(request);
    const idea = requiredString(body.idea, "idea", 100_000);
    const runId = optionalString(body.runId, "runId", 100) ?? randomUUID();
    const rag = optionalBoolean(body.rag, "rag") ?? projectConfig.workflow.rag;
    const push = optionalBoolean(body.push, "push") ?? projectConfig.git.push;
    const openPullRequest =
      optionalBoolean(body.openPullRequest, "openPullRequest") ??
      projectConfig.git.openPullRequest;
    const smallModel = optionalString(body.smallModel, "smallModel", 200);
    const capableModel = optionalString(body.capableModel, "capableModel", 200);
    const repositoryIntelligence = optionalBoolean(
      body.repositoryIntelligence,
      "repositoryIntelligence",
    );
    const baseBranchOverride = optionalString(body.baseBranch, "baseBranch", 200);
    const baseBranch = await resolveBaseBranchOverride(projectConfig, baseBranchOverride);
    const runConfig = HarnessConfigSchema.parse({
      ...projectConfig,
      workflow: { ...projectConfig.workflow, rag },
      git: {
        ...projectConfig.git,
        baseBranch,
        push: push || openPullRequest,
        openPullRequest,
      },
      models: {
        ...projectConfig.models,
        small: smallModel ?? projectConfig.models.small,
        capable: capableModel ?? projectConfig.models.capable,
      },
      knowledge: {
        ...projectConfig.knowledge,
        repositoryIntelligence: {
          ...projectConfig.knowledge.repositoryIntelligence,
          enabled:
            repositoryIntelligence ??
            projectConfig.knowledge.repositoryIntelligence.enabled,
        },
      },
    });
    const engine = new HarnessEngine(runConfig, {
      backend: ctx.backend,
      repositoryIntelligenceRunner: ctx.repositoryIntelligenceRunner,
    });
    // Creating the durable run must be quick. A first semantic index may
    // take minutes for a large repository, so run it in the visible job
    // queue rather than holding the browser request open.
    // UI already prepares repository intelligence and refreshes knowledge
    // inside the job queue so the browser request can return immediately.
    const state = await engine.start(idea, runId, false, false);
    if (state.phase !== "blocked" && state.phase !== "cancelled" && state.phase !== "completed") {
      ctx.jobs.enqueue(runId, "index knowledge and reflect", async () => {
        const opened = await openRunHarness(projectConfig, runId, {
          backend: ctx.backend,
          store: ctx.store,
          repositoryIntelligenceRunner: ctx.repositoryIntelligenceRunner,
          docker: ctx.docker,
        });
        if ((opened.config.execution?.runtime ?? "local") === "docker") {
          if (!ctx.docker) throw new HttpError(503, "Docker client unavailable");
          const { continueDockerRunAfterWorkspaceReady } = await import(
            "../../../application/docker-initial-setup.js"
          );
          await continueDockerRunAfterWorkspaceReady({
            projectConfig: ctx.getProjectConfig(),
            runId,
            docker: ctx.docker,
            runDirectory: ctx.store.runDirectory(runId),
            onProgress: (message) => ctx.jobs.setDetail(runId, message),
          });
        } else {
          await runInitialSetupThenAdvance(initialSetupFromOpened(ctx, runId, opened));
        }
      });
    }
    json(response, 202, { run: summarizeRun(state, ctx.jobs.get(runId)) });
    return true;
  }

  const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (request.method === "GET" && runMatch) {
    const projectConfig = ctx.getProjectConfig();
    const runId = decodeURIComponent(runMatch[1]!);
    const state = await ctx.store.load(runId);
    const job = ctx.jobs.get(runId);
    const activity = await readActivity(ctx.store, runId);
    const signature = runSignature(state, job, activity);
    const since = url.searchParams.get("since");
    if (since && since === signature) {
      json(response, 200, { unchanged: true, signature });
      return true;
    }
    const [events, sessions, agentActivity, artifacts, runConfig, installLog, workspace, executionState, importState, executionImage] =
      await Promise.all([
        readEvents(ctx.store, runId),
        readSessionSummaries(ctx.store, runId),
        readAgentActivity(ctx.store, runId),
        listArtifacts(ctx.store, runId),
        loadRunConfig(projectConfig, runId, runArtifactOptions(ctx, runId)).catch(() => null),
        readInstallLog(ctx.store, runId),
        loadRunWorkspace(projectConfig, runId, runArtifactOptions(ctx, runId)).catch(() => null),
        (async () => {
          const { loadRunExecutionState } = await import("../../../application/execution-state-io.js");
          return loadRunExecutionState(projectConfig, runId).catch(() => undefined);
        })(),
        (async () => {
          const { loadBundleImportState } = await import("../../../application/bundle-import-io.js");
          return loadBundleImportState(projectConfig, runId).catch(() => undefined);
        })(),
        readExecutionImage(ctx.store, runId),
      ]);
    // git.currentBranch spawns a subprocess; only pay for it when the UI
    // actually needs it (blocked runs), and never fold it into the signature.
    const git =
      state.phase === "blocked"
        ? {
            currentBranch: await new GitService(projectConfig).currentBranch(),
            baseBranch: projectConfig.git.baseBranch,
          }
        : undefined;
    const ceilings = runConfig
      ? {
          maxRunTokens: runConfig.workflow.maxRunTokens,
          maxRunCostUsd: runConfig.workflow.maxRunCostUsd,
        }
      : undefined;
    const retrievalPolicy = runConfig
      ? {
          rag: runConfig.workflow.rag,
          repositoryIntelligence: runConfig.knowledge.repositoryIntelligence.enabled,
          routes: runConfig.knowledge.repositoryIntelligence.routes,
        }
      : undefined;
    const deliveryWorkspace = workspace
      ? {
          kind: workspace.kind,
          worktreePath: workspace.kind === "git-worktree" ? workspace.worktreePath : undefined,
          containerName: workspace.kind === "docker-clone" ? workspace.containerName : undefined,
          workspaceVolumeName:
            workspace.kind === "docker-clone" ? workspace.workspaceVolumeName : undefined,
          imageDigest: workspace.kind === "docker-clone" ? workspace.imageDigest : undefined,
          workspacePath: workspace.kind === "docker-clone" ? workspace.workspacePath : undefined,
          baseBranch: workspace.kind === "git-worktree" ? workspace.baseBranch : undefined,
          baseSha: workspace.baseSha,
          branchName: workspace.branchName ?? state.branchName,
          removedAt: workspace.removedAt,
          executionLifecycle: executionState?.lifecycle,
          importStatus: importState?.status,
          importRejectionReason: importState?.rejectionReason,
          resultBundleHash: importState?.resultBundleHash,
          // Frozen runtime for this run — never offer switching.
          frozenRuntime:
            runConfig?.execution?.runtime ??
            (workspace.kind === "docker-clone" ? "docker" : "local"),
        }
      : undefined;
    json(response, 200, {
      state,
      job,
      events,
      sessions,
      agentActivity,
      artifacts,
      activity,
      installLog,
      executionImage,
      signature,
      ...(git ? { git } : {}),
      ...(ceilings ? { ceilings } : {}),
      ...(retrievalPolicy ? { retrievalPolicy } : {}),
      ...(deliveryWorkspace ? { workspace: deliveryWorkspace } : {}),
    });
    return true;
  }

  const actionMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/actions$/);
  if (request.method === "POST" && actionMatch) {
    const projectConfig = ctx.getProjectConfig();
    const runId = decodeURIComponent(actionMatch[1]!);
    const body = await readJsonBody(request);
    const action = requiredString(body.action, "action", 40);
    const stateForGate = action === "apply_fix" ? await ctx.store.load(runId).catch(() => null) : null;
    const applyFixIsConfigOnly =
      action === "apply_fix" &&
      stateForGate?.fixerRecovery?.role === "config-fixer" &&
      stateForGate.fixerRecovery.status === "proposed";
    if (
      action !== "cancel" &&
      action !== "note" &&
      action !== "stop" &&
      action !== "save_execution_dockerfile" &&
      action !== "approve_execution_image" &&
      action !== "build_execution_image" &&
      action !== "approve_and_build_execution_image" &&
      !applyFixIsConfigOnly &&
      !ctx.agentReadiness.ready
    ) {
      throw new HttpError(503, ctx.agentReadiness.message ?? "The configured agent backend is unavailable");
    }
    const workspaceMissing = await isRunWorkspaceMissing(ctx, runId);
    const hostExecutionImageAction = HOST_EXECUTION_IMAGE_ACTIONS.has(action);
    const opened = await openRunHarness(
      projectConfig,
      runId,
      {
        backend: ctx.backend,
        store: ctx.store,
        repositoryIntelligenceRunner: ctx.repositoryIntelligenceRunner,
        docker: ctx.docker,
      },
      {
        validateWorktree:
          action !== "cancel" &&
          action !== "note" &&
          action !== "stop" &&
          action !== "generate_analysis_prompt" &&
          !hostExecutionImageAction,
        // Docker runs pause for image approval before workspace.json exists.
        allowMissingWorkspace: workspaceMissing || hostExecutionImageAction,
      },
    );
    // Analysis generation is tool-free and must remain available after a completed
    // run's disposable worktree has been cleaned up. Use the durable control root.
    const engine =
      action === "generate_analysis_prompt"
        ? new HarnessEngine(opened.config, {
            backend: ctx.backend,
            store: ctx.store,
            repositoryIntelligenceRunner: ctx.repositoryIntelligenceRunner,
          })
        : opened.engine;

    // No worker/container until Approve & build creates the Docker clone.
    // Phase `new` Docker runs must start the worker and run initial_setup there —
    // never host-spawn git against the `/workspace` constant (Windows: spawn git ENOENT).
    const stateForDockerSetup =
      action === "resume" || action === "retry" || action === "continue"
        ? await ctx.store.load(runId).catch(() => null)
        : null;
    const dockerNeedsInitialSetup =
      Boolean(stateForDockerSetup) &&
      stateForDockerSetup!.phase === "new" &&
      (action === "resume" || action === "retry" || action === "continue");
    const skipDockerProxy =
      action === "generate_analysis_prompt" ||
      hostExecutionImageAction ||
      workspaceMissing ||
      dockerNeedsInitialSetup;
    const dockerProxy =
      isDockerExecutionRuntime(opened.config) && !skipDockerProxy
        ? await resolveDockerMutationProxy({
            projectConfig,
            runConfig: opened.config,
            runId,
            docker: ctx.docker,
          }).catch((error) => {
            if (action === "cancel" || action === "stop") {
              // Cancel/stop still write durable markers even when RPC is down.
              return undefined;
            }
            throw error;
          })
        : undefined;

    if (action === "stop") {
      if (dockerProxy) {
        const state = await dockerProxy.invoke("stop", {});
        json(response, 200, { accepted: true, state });
        return true;
      }
      const state = await engine.requestStop(runId);
      json(response, 200, { accepted: true, state });
      return true;
    }

    if (action === "cancel") {
      // Durable cancel.request first (visible to the worker via /run-state mount),
      // then RPC so the in-process controller aborts immediately.
      await engine.writeCancelRequest(runId);
      if (dockerProxy) {
        const result = (await dockerProxy.invoke("cancel", {})) as {
          pending?: boolean;
          phase?: string;
        };
        const state = await ctx.store.load(runId);
        json(response, result.pending ? 202 : 200, {
          accepted: true,
          pending: Boolean(result.pending),
          state,
        });
        return true;
      }
      const result = await engine.cancel(runId);
      json(response, result.pending ? 202 : 200, {
        accepted: true,
        pending: result.pending,
        state: result.state,
      });
      return true;
    }

    const workerAction = mapHostActionToWorkerRpc(action);
    if (
      dockerProxy &&
      (action === "continue" || action === "resume" || action === "advance")
    ) {
      const latest = await ctx.store.load(runId);
      if (latest.phase === "publishing") {
        // Host-only: quarantine import + push/PR (never container credentials).
        ctx.jobs.enqueue(runId, action, async () => {
          ctx.jobs.setDetail(runId, "Importing Docker result bundle on host");
          await completeDockerHostPublish({
            projectConfig,
            runConfig: opened.config,
            runId,
            store: ctx.store,
            dockerProxy,
          });
        });
        json(response, 202, { accepted: true, job: ctx.jobs.get(runId) });
        return true;
      }
    }
    if (dockerProxy && workerAction) {
      ctx.jobs.enqueue(runId, action, async () => {
        ctx.jobs.setDetail(runId, `Proxying ${action} to Docker worker`);
        await dockerProxy.invoke(workerAction, body);
      });
      json(response, 202, { accepted: true, job: ctx.jobs.get(runId) });
      return true;
    }

    if (action === "continue") {
      ctx.jobs.enqueue(runId, action, async () => {
        const latest = await ctx.store.load(runId);
        if (
          latest.phase === "new" &&
          (opened.config.execution?.runtime ?? "local") === "docker"
        ) {
          ctx.jobs.setDetail(runId, "Ensuring execution image and Docker workspace");
          await opened.engine.ensureDockerWorkspaceReady(runId);
          if (!ctx.docker) throw new HttpError(503, "Docker client unavailable");
          const { continueDockerRunAfterWorkspaceReady } = await import(
            "../../../application/docker-initial-setup.js"
          );
          await continueDockerRunAfterWorkspaceReady({
            projectConfig: ctx.getProjectConfig(),
            runId,
            docker: ctx.docker,
            runDirectory: ctx.store.runDirectory(runId),
            onProgress: (message) => ctx.jobs.setDetail(runId, message),
          });
          return;
        }
        await engine.advance(runId);
      });
    } else if (action === "generate_analysis_prompt") {
      ctx.jobs.enqueue(runId, "generate analysis prompt", async () => {
        ctx.jobs.setDetail(runId, "Generating a portable run-analysis prompt");
        await engine.generateRunAnalysisPrompt(runId);
      });
    } else if (action === "resume") {
      // Jobs are intentionally process-local. A dashboard restart keeps the
      // durable run state but cannot safely assume that an interrupted
      // provider call should be retried. Make recovery an explicit action.
      // Runs still in `new` retry repository intelligence then the document index; later
      // phases refresh the index in case it was cleared while stopped.
      ctx.jobs.enqueue(runId, "resume run", async () => {
        const latest = await ctx.store.load(runId);
        if (latest.phase === "new") {
          if ((opened.config.execution?.runtime ?? "local") === "docker") {
            ctx.jobs.setDetail(runId, "Ensuring execution image and Docker workspace");
            await opened.engine.ensureDockerWorkspaceReady(runId);
            if (!ctx.docker) throw new HttpError(503, "Docker client unavailable");
            const { continueDockerRunAfterWorkspaceReady } = await import(
              "../../../application/docker-initial-setup.js"
            );
            await continueDockerRunAfterWorkspaceReady({
              projectConfig: ctx.getProjectConfig(),
              runId,
              docker: ctx.docker,
              runDirectory: ctx.store.runDirectory(runId),
              onProgress: (message) => ctx.jobs.setDetail(runId, message),
            });
            return;
          }
          await runInitialSetupThenAdvance(initialSetupFromOpened(ctx, runId, opened));
          return;
        }
        await ctx.store.withSharedIndexLock({ runId, action: "refresh-knowledge" }, () =>
          engine.knowledge.refresh((progress) => {
            ctx.jobs.setDetail(runId, progress.message);
          }),
        );
        await engine.advance(runId);
      });
    } else if (action === "answer") {
      const { answers, parked, clarifications } = parseAnswerBody(body);
      ctx.jobs.enqueue(runId, action, async () => {
        await engine.answerMany(runId, answers, parked, clarifications);
        await engine.advance(runId);
      });
    } else if (action === "note") {
      const text = requiredString(body.text, "text", 20_000);
      const asUnknown = optionalBoolean(body.asUnknown, "asUnknown") ?? false;
      ctx.jobs.enqueue(runId, action, () => engine.addNote(runId, text, asUnknown));
    } else if (action === "propose_fix") {
      const guidance = requiredString(body.guidance, "guidance", 20_000);
      ctx.jobs.enqueue(runId, action, () => engine.proposeFix(runId, guidance));
    } else if (action === "apply_fix") {
      const persistProjectDefaults =
        optionalBoolean(body.persistProjectDefaults, "persistProjectDefaults") ?? false;
      if (persistProjectDefaults && !ctx.configPath) {
        throw new HttpError(400, "Cannot persist project defaults without a config file path");
      }
      ctx.jobs.enqueue(runId, action, async () => {
        let reportPaths: string[] = [];
        const patchForPersist =
          stateForGate?.fixerRecovery?.role === "config-fixer"
            ? ProjectSettingsPatchSchema.parse(stateForGate.fixerRecovery.plan.configPatch)
            : undefined;
        if (persistProjectDefaults && ctx.configPath && patchForPersist) {
          const updated = await writeProjectSettings(ctx.configPath, patchForPersist);
          const config = await applyWrittenProjectSettings(ctx, updated);
          const relative = path
            .relative(config.repositoryRoot, ctx.configPath)
            .replaceAll("\\", "/");
          if (relative && !relative.startsWith("..")) reportPaths = [relative];
        }
        await engine.applyApprovedFix(runId, {
          persistedProjectDefaults: persistProjectDefaults,
          reportPaths,
        });
        // Reload frozen config so the resumed transition sees the applied repair.
        const refreshed = await loadRunConfig(
          ctx.getProjectConfig(),
          runId,
          runArtifactOptions(ctx, runId),
        );
        await new HarnessEngine(refreshed, { backend: ctx.backend }).advance(runId);
      });
    } else if (action === "retry") {
      const force = optionalBoolean(body.force, "force") ?? false;
      const maxRunTokens = optionalNonNegativeNumber(body.maxRunTokens, "maxRunTokens");
      const maxRunCostUsd = optionalNonNegativeNumber(body.maxRunCostUsd, "maxRunCostUsd");
      ctx.jobs.enqueue(runId, action, async () => {
        ctx.jobs.setDetail(runId, "Retrying the blocked transition");
        const resumed = await engine.retry(runId, { force, maxRunTokens, maxRunCostUsd });
        if (resumed.phase === "new") {
          if ((opened.config.execution?.runtime ?? "local") === "docker") {
            ctx.jobs.setDetail(runId, "Ensuring execution image and Docker workspace");
            await opened.engine.ensureDockerWorkspaceReady(runId);
            if (!ctx.docker) throw new HttpError(503, "Docker client unavailable");
            const { continueDockerRunAfterWorkspaceReady } = await import(
              "../../../application/docker-initial-setup.js"
            );
            await continueDockerRunAfterWorkspaceReady({
              projectConfig: ctx.getProjectConfig(),
              runId,
              docker: ctx.docker,
              runDirectory: ctx.store.runDirectory(runId),
              onProgress: (message) => ctx.jobs.setDetail(runId, message),
            });
            return;
          }
          await runInitialSetupThenAdvance(initialSetupFromOpened(ctx, runId, opened));
          return;
        }
        await engine.advance(runId);
      });
    } else if (action === "commit_preflight") {
      throw new HttpError(
        400,
        "Preflight commit-order controls have been removed. " +
          "Worktree runs start from the committed base and never import control-checkout dirt.",
      );
    } else if (action === "cleanup") {
      const discard = optionalBoolean(body.discard, "discard") ?? false;
      ctx.jobs.enqueue(runId, action, async () => {
        ctx.jobs.setDetail(runId, "Cleaning up run workspace");
        await engine.cleanup(runId, { discard });
      });
    } else if (action === "recover_container") {
      ctx.jobs.enqueue(runId, action, async () => {
        ctx.jobs.setDetail(runId, "Recovering Docker worker against retained volume");
        const workspace = await loadRunWorkspace(
          ctx.getProjectConfig(),
          runId,
          runArtifactOptions(ctx, runId),
        );
        if (workspace.kind !== "docker-clone") {
          throw new HttpError(400, "Container recovery only applies to docker-clone runs");
        }
        if (!ctx.docker) throw new HttpError(503, "Docker client unavailable");
        const { ensureDockerWorkerSession } = await import(
          "../../../application/docker-worker-session.js"
        );
        await ensureDockerWorkerSession({
          projectConfig: ctx.getProjectConfig(),
          runId,
          docker: ctx.docker,
          image: workspace.imageDigest,
          workspaceVolumeName: workspace.workspaceVolumeName,
          startIfMissing: true,
        });
      });
    } else if (action === "save_execution_dockerfile") {
      ctx.jobs.enqueue(runId, action, async () => {
        ctx.jobs.setDetail(runId, "Saving execution Dockerfile");
        const dockerfile =
          typeof body.dockerfile === "string"
            ? body.dockerfile
            : typeof (body as { content?: unknown }).content === "string"
              ? (body as { content: string }).content
              : "";
        if (!dockerfile.trim()) {
          throw new HttpError(400, "dockerfile text is required");
        }
        const paths = (await import("../../../application/paths.js")).resolveHarnessPaths(
          ctx.getProjectConfig(),
        );
        const runConfig = await loadRunConfig(ctx.getProjectConfig(), runId, runArtifactOptions(ctx, runId));
        const {
          saveExecutionDockerfile,
          executionImageArtifactPaths,
        } = await import("../../../application/execution-image-service.js");
        const { readFile } = await import("node:fs/promises");
        const artifacts = executionImageArtifactPaths(paths.stateRoot, runId);
        let profile: { workerImage?: string; baseImage?: string } | undefined;
        try {
          profile = JSON.parse(await readFile(artifacts.profilePath, "utf8")) as {
            workerImage?: string;
            baseImage?: string;
          };
        } catch {
          /* config allowlists remain authoritative */
        }
        const allowlist = executionDockerfileSaveAllowlist({
          runConfig,
          projectConfig: ctx.getProjectConfig(),
          profile,
        });
        await saveExecutionDockerfile({
          stateRoot: paths.stateRoot,
          runId,
          dockerfile,
          allowlist,
        });
      });
    } else if (action === "approve_execution_image") {
      ctx.jobs.enqueue(runId, action, async () => {
        ctx.jobs.setDetail(runId, "Approving generated execution image");
        const paths = (await import("../../../application/paths.js")).resolveHarnessPaths(
          ctx.getProjectConfig(),
        );
        const {
          prepareExecutionImage,
          approveExecutionImage,
        } = await import("../../../application/execution-image-service.js");
        const prepared = await prepareExecutionImage({
          config: await loadRunConfig(ctx.getProjectConfig(), runId, runArtifactOptions(ctx, runId)),
          stateRoot: paths.stateRoot,
          runId,
          projectStateRoot: paths.stateRoot,
        });
        if (prepared.status === "blocked") {
          throw new HttpError(409, prepared.reason ?? "Execution image is blocked");
        }
        if (!("generated" in prepared) || !prepared.generated || !("cacheKey" in prepared)) {
          throw new HttpError(409, "No generated execution image to approve");
        }
        await approveExecutionImage({
          stateRoot: paths.stateRoot,
          runId,
          projectStateRoot: paths.stateRoot,
          generated: prepared.generated,
          cacheKey: prepared.cacheKey,
        });
      });
    } else if (action === "build_execution_image") {
      ctx.jobs.enqueue(runId, action, async () => {
        ctx.jobs.setDetail(runId, "Building approved execution image");
        if (!ctx.docker) throw new HttpError(503, "Docker client unavailable");
        const paths = (await import("../../../application/paths.js")).resolveHarnessPaths(
          ctx.getProjectConfig(),
        );
        const runConfig = await loadRunConfig(ctx.getProjectConfig(), runId, runArtifactOptions(ctx, runId));
        const { buildApprovedExecutionImage } = await import(
          "../../../application/execution-image-service.js"
        );
        await buildApprovedExecutionImage({
          stateRoot: paths.stateRoot,
          runId,
          projectStateRoot: paths.stateRoot,
          docker: ctx.docker,
          tag: `agent-harness-run-${runId}`.toLowerCase().slice(0, 128),
          timeoutMs: runConfig.execution?.docker?.buildTimeoutMs,
          dockerPolicy: runConfig.execution?.docker,
        });
      });
    } else if (action === "approve_and_build_execution_image") {
      ctx.jobs.enqueue(runId, action, async () => {
        ctx.jobs.setDetail(runId, "Approving and building execution image");
        if (!ctx.docker) throw new HttpError(503, "Docker client unavailable");
        const paths = (await import("../../../application/paths.js")).resolveHarnessPaths(
          ctx.getProjectConfig(),
        );
        const runConfig = await loadRunConfig(ctx.getProjectConfig(), runId, runArtifactOptions(ctx, runId));
        const { approveAndBuildExecutionImage } = await import(
          "../../../application/execution-image-service.js"
        );
        await approveAndBuildExecutionImage({
          config: runConfig,
          stateRoot: paths.stateRoot,
          runId,
          projectStateRoot: paths.stateRoot,
          repositoryRoot: paths.controlRoot,
          docker: ctx.docker,
          tag: `agent-harness-run-${runId}`.toLowerCase().slice(0, 128),
          timeoutMs: runConfig.execution?.docker?.buildTimeoutMs,
          dockerPolicy: runConfig.execution?.docker,
        });
        ctx.jobs.setDetail(runId, "Creating Docker workspace and continuing setup");
        let latest = await ctx.store.load(runId);
        if (latest.phase === "blocked" && latest.blockedFrom === "new") {
          latest = await engine.retry(runId, { force: true });
        }
        await opened.engine.ensureDockerWorkspaceReady(runId);
        latest = await ctx.store.load(runId);
        if (latest.phase === "new") {
          if ((opened.config.execution?.runtime ?? "local") === "docker") {
            const { continueDockerRunAfterWorkspaceReady } = await import(
              "../../../application/docker-initial-setup.js"
            );
            await continueDockerRunAfterWorkspaceReady({
              projectConfig: ctx.getProjectConfig(),
              runId,
              docker: ctx.docker,
              runDirectory: ctx.store.runDirectory(runId),
              onProgress: (message) => ctx.jobs.setDetail(runId, message),
            });
          } else {
            await runInitialSetupThenAdvance(initialSetupFromOpened(ctx, runId, opened));
          }
        }
      });
    } else if (action === "accept_tree") {
      ctx.jobs.enqueue(runId, action, async () => {
        ctx.jobs.setDetail(runId, "Accepting the current tree");
        await engine.acceptTree(runId);
        ctx.jobs.setDetail(runId, "Resuming the run");
        await engine.advance(runId);
      });
    } else if (action === "ignore_artifacts") {
      if (!ctx.configPath) {
        throw new HttpError(400, "Cannot persist ignored artifacts without a config file path");
      }
      const paths = optionalStringArray(body.paths, "paths", 500) ?? [];
      if (paths.length === 0) {
        throw new HttpError(400, "paths must be a non-empty string array");
      }
      const added = paths.map(pathToIgnoredArtifactGlob);
      const merged = [
        ...new Set([...projectConfig.git.ignoredArtifactPatterns, ...added]),
      ];
      const updated = await writeProjectSettings(ctx.configPath, {
        git: { ignoredArtifactPatterns: merged },
      });
      const config = await applyWrittenProjectSettings(ctx, updated);
      const configRelative = path
        .relative(config.repositoryRoot, ctx.configPath)
        .replaceAll("\\", "/");
      ctx.jobs.enqueue(runId, action, async () => {
        await engine.setIgnoredArtifactPatterns(runId, merged);
        // Persist the config edit as a reported path on the active task so later
        // commitTask / divergence checks treat it as intentional harness work.
        await engine.acceptTree(runId, {
          reportPaths: configRelative && !configRelative.startsWith("..") ? [configRelative] : [],
        });
        await engine.advance(runId);
      });
    } else if (action === "resolve_installs") {
      const accepted = optionalStringArray(body.accepted, "accepted", 200) ?? [];
      const denied = optionalStringArray(body.denied, "denied", 200) ?? [];
      ctx.jobs.enqueue(runId, action, async () => {
        await engine.resolveInstalls(runId, { accepted, denied });
        await engine.advance(runId);
      });
    } else if (action === "confirm_grill") {
      const feedback = optionalString(body.feedback, "feedback", 20_000);
      ctx.jobs.enqueue(runId, action, async () => {
        await engine.confirmGrill(runId, { feedback });
        await engine.advance(runId);
      });
    } else if (action === "confirm_plan") {
      const feedback = optionalString(body.feedback, "feedback", 20_000);
      let plan: ReturnType<typeof HighLevelPlanSchema.parse> | undefined;
      if (body.plan != null) {
        plan = HighLevelPlanSchema.parse(body.plan);
      }
      ctx.jobs.enqueue(runId, action, async () => {
        await engine.confirmPlan(runId, { feedback, plan });
        await engine.advance(runId);
      });
    } else if (action === "confirm_verification") {
      const keepCurrent = optionalBoolean(body.keepCurrent, "keepCurrent") ?? false;
      const persistProjectDefaults =
        optionalBoolean(body.persistProjectDefaults, "persistProjectDefaults") ?? false;
      if (persistProjectDefaults && !ctx.configPath) {
        throw new HttpError(400, "Cannot persist project defaults without a config file path");
      }
      let patch: ReturnType<typeof VerificationSettingsPatchSchema.parse> | undefined;
      if (!keepCurrent && body.patch != null) {
        patch = VerificationSettingsPatchSchema.parse(body.patch);
      }
      ctx.jobs.enqueue(runId, action, async () => {
        await engine.confirmVerification(runId, {
          keepCurrent,
          patch,
          persistProjectDefaults,
          configPath: ctx.configPath,
        });
        // Reload frozen config so the planner sees updated verification policy.
        const refreshed = await loadRunConfig(ctx.getProjectConfig(), runId, runArtifactOptions(ctx, runId));
        await new HarnessEngine(refreshed, { backend: ctx.backend }).advance(runId);
      });
    } else if (action === "retry_verification_baseline") {
      const persistProjectDefaults =
        optionalBoolean(body.persistProjectDefaults, "persistProjectDefaults") ?? false;
      if (persistProjectDefaults && !ctx.configPath) {
        throw new HttpError(400, "Cannot persist project defaults without a config file path");
      }
      const verificationCommand = optionalString(body.verificationCommand, "verificationCommand", 2_000);
      ctx.jobs.enqueue(runId, action, async () => {
        ctx.jobs.setDetail(runId, "Retrying the verification baseline");
        await engine.retryVerificationBaseline(runId, {
          verificationCommand,
          persistProjectDefaults,
          configPath: ctx.configPath,
        });
        // Reload frozen config in case the operator edited verification commands.
        const refreshed = await loadRunConfig(ctx.getProjectConfig(), runId, runArtifactOptions(ctx, runId));
        await new HarnessEngine(refreshed, { backend: ctx.backend }).advance(runId);
      });
    } else if (action === "set_rag") {
      const rag = optionalBoolean(body.rag, "rag");
      if (rag == null) throw new HttpError(400, "rag must be a boolean");
      ctx.jobs.enqueue(runId, action, () => engine.setRag(runId, rag));
    } else if (action === "set_repository_intelligence") {
      const enabled = optionalBoolean(body.repositoryIntelligence, "repositoryIntelligence");
      if (enabled == null) throw new HttpError(400, "repositoryIntelligence must be a boolean");
      ctx.jobs.enqueue(runId, action, () => engine.setRepositoryIntelligence(runId, enabled));
    } else {
      throw new HttpError(400, `Unsupported action: ${action}`);
    }
    json(response, 202, { accepted: true, job: ctx.jobs.get(runId) });
    return true;
  }

  const artifactMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/artifact$/);
  if (request.method === "GET" && artifactMatch) {
    const runId = decodeURIComponent(artifactMatch[1]!);
    const artifactPath = url.searchParams.get("path") ?? "";
    if (!allowedArtifact(artifactPath)) throw new HttpError(400, "Artifact path is not readable");
    const content = await ctx.store.readText(runId, artifactPath);
    json(response, 200, { path: artifactPath, content: content.slice(0, 1_000_000) });
    return true;
  }

  const sessionMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/session$/);
  if (request.method === "GET" && sessionMatch) {
    const runId = decodeURIComponent(sessionMatch[1]!);
    const sessionPath = url.searchParams.get("path") ?? "";
    if (!/^sessions\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(sessionPath)) {
      throw new HttpError(400, "Session path is not readable");
    }
    json(response, 200, await readSessionDetail(ctx.store, runId, sessionPath));
    return true;
  }

  return false;
}
