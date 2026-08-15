import path from "node:path";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HarnessConfigSchema, type HarnessConfig } from "../../../config/schema.js";
import { loadRunConfig, loadRunWorkspace, writeProjectSettings } from "../../../config/io.js";
import { loadExternalProjectConfig } from "../../../application/external-config.js";
import { openHostRunControl, openWorkerRunRuntime } from "../../../application/run-engine-factory.js";
import { dispatchHostRunAction } from "../../../application/host-run-dispatch.js";
import { resolveRunBaseBranch } from "../../../application/run-base-branch.js";
import { HarnessFailure } from "../../../errors.js";
import { GitService, pathToIgnoredArtifactGlob } from "../../../git.js";
import type { UiAppContext } from "../context.js";
import {
  HttpError,
  json,
  optionalBoolean,
  optionalString,
  optionalStringArray,
  readJsonBody,
  requiredString,
} from "../request.js";
import {
  allowedArtifact,
  listArtifacts,
  readActivity,
  readAgentActivity,
  readEvents,
  readInstallLog,
  readSessionDetail,
  readSessionSummaries,
  runSignature,
  summarizeRun,
} from "../run-reads.js";
import { projectSettings } from "./settings.js";

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
    const config = reloaded.config;
    ctx.setProjectConfig(config);
    return config;
  } catch {
    const merged: HarnessConfig = {
      ...written.config,
      repositoryRoot: previous.repositoryRoot,
      stateDirectory: previous.stateDirectory,
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

function workerStateStartOptions(ctx: UiAppContext) {
  return {
    stateServiceEndpoint: ctx.workerState.endpoint(),
    issueStateCredential: (runId: string, options: { workerInstanceId: string }) =>
      ctx.workerState.issueCredential(runId, options),
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
            runtime: "docker" as const,
            ready: false,
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
    // The HTTP adapter creates durable host state only. The Cordis lifecycle
    // owns every Docker/image/workspace/worker side effect asynchronously.
    const state = await ctx.runLifecycle.createRun(runConfig, idea, runId);
    if (state.phase !== "blocked" && state.phase !== "cancelled" && state.phase !== "completed") {
      ctx.jobs.enqueue(runId, "prepare Docker worker and reflect", async () => {
        await ctx.runLifecycle.enqueue(runId);
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
    const [events, sessions, agentActivity, artifacts, runConfig, installLog, workspace, executionState, importState] =
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
          workspacePath: workspace.kind === "host-worktree" ? workspace.workspacePath : undefined,
          baseBranch: workspace.baseBranch,
          baseSha: workspace.baseSha,
          branchName: workspace.branchName ?? state.branchName,
          removedAt: workspace.removedAt,
          executionLifecycle: executionState?.lifecycle,
          importStatus: importState?.status,
          importRejectionReason: importState?.rejectionReason,
          resultBundleHash: importState?.resultBundleHash,
          frozenRuntime: workspace.kind === "host-worktree" ? "docker" : undefined,
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
    if (
      ![
        "advance",
        "answer",
        "apply_fix",
        "cancel",
        "cleanup",
        "confirm_grill",
        "confirm_plan",
        "confirm_verification",
        "continue",
        "generate_analysis_prompt",
        "ignore_artifacts",
        "note",
        "propose_fix",
        "recover_container",
        "resolve_installs",
        "resume",
        "retry",
        "retry_verification_baseline",
        "set_rag",
        "set_repository_intelligence",
        "stop",
        "accept_tree",
      ].includes(action)
    ) {
      throw new HttpError(400, `Unsupported action: ${action}`);
    }
    const stateForGate = action === "apply_fix" ? await ctx.store.load(runId).catch(() => null) : null;
    const applyFixIsConfigOnly =
      action === "apply_fix" &&
      stateForGate?.fixerRecovery?.role === "config-fixer" &&
      stateForGate.fixerRecovery.status === "proposed";
    if (
      action !== "cancel" &&
      action !== "note" &&
      action !== "stop" &&
      !applyFixIsConfigOnly &&
      !ctx.agentReadiness.ready
    ) {
      throw new HttpError(503, ctx.agentReadiness.message ?? "The configured agent backend is unavailable");
    }
    const workspaceMissing = await isRunWorkspaceMissing(ctx, runId);
    const opened = await openHostRunControl(
      projectConfig,
      runId,
      {
        backend: ctx.backend,
        store: ctx.store,
        repositoryIntelligenceRunner: ctx.repositoryIntelligenceRunner,
        docker: ctx.docker,
      },
      {
        validateWorkspace:
          action !== "cancel" &&
          action !== "note" &&
          action !== "stop" &&
          action !== "generate_analysis_prompt",
        allowMissingWorkspace: workspaceMissing,
      },
    );
    const control = opened.control;

    if (action === "continue" || action === "resume" || action === "advance") {
      const latest = await ctx.store.load(runId);
      if (latest.phase === "publishing") {
        ctx.jobs.enqueue(runId, action, async () => {
          ctx.jobs.setDetail(runId, "Importing result bundle on host");
          await ctx.runLifecycle.enqueue(runId);
        });
        json(response, 202, { accepted: true, job: ctx.jobs.get(runId) });
        return true;
      }
    }

    if (action === "stop" || action === "cancel") {
      const result = await dispatchHostRunAction({
        action,
        runId,
        body,
        control,
        runLifecycle: ctx.runLifecycle,
        openEngine: () =>
          openWorkerRunRuntime(projectConfig, runId, {
            backend: ctx.backend,
            store: ctx.store,
            docker: ctx.docker,
          }).then((openedEngine) => openedEngine.engine),
      });
      json(response, result.pending ? 202 : 200, {
        accepted: true,
        pending: result.pending,
        state: result.state,
      });
      return true;
    }

    ctx.jobs.enqueue(runId, action, async () => {
      ctx.jobs.setDetail(runId, `Dispatching ${action} on the host`);
      if (action === "ignore_artifacts") {
        if (!ctx.configPath) {
          throw new HttpError(400, "Cannot persist ignored artifacts without a config file path");
        }
        const paths = optionalStringArray(body.paths, "paths", 500) ?? [];
        if (paths.length === 0) {
          throw new HttpError(400, "paths must be a non-empty string array");
        }
        const added = paths.map(pathToIgnoredArtifactGlob);
        const merged = [...new Set([...projectConfig.git.ignoredArtifactPatterns, ...added])];
        await writeProjectSettings(ctx.configPath, {
          git: { ignoredArtifactPatterns: merged },
        });
        body.patterns = merged;
      }
      await dispatchHostRunAction({
        action,
        runId,
        body,
        control,
        runLifecycle: ctx.runLifecycle,
        openEngine: () =>
          openWorkerRunRuntime(projectConfig, runId, {
            backend: ctx.backend,
            store: ctx.store,
            docker: ctx.docker,
          }).then((openedEngine) => openedEngine.engine),
      });
    });
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
