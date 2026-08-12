import path from "node:path";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  HarnessConfigSchema,
  ProjectSettingsPatchSchema,
  loadRunConfig,
  loadRunWorkspace,
  writeProjectSettings,
} from "../../../config.js";
import { openRunHarness, type OpenedRunHarness } from "../../../application/run-engine-factory.js";
import { runInitialSetupThenAdvance } from "../../../application/run-setup.js";
import { HarnessEngine } from "../../../engine.js";
import { HighLevelPlanSchema, VerificationSettingsPatchSchema } from "../../../domain.js";
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
  readInstallLog,
  readSessionDetail,
  readSessionSummaries,
  runSignature,
  summarizeRun,
} from "../run-reads.js";
import { PREFLIGHT_COMMIT_ORDER_VALUES, projectSettings } from "./settings.js";

async function resolveBaseBranchOverride(
  projectConfig: ReturnType<UiAppContext["getProjectConfig"]>,
  baseBranch: string | undefined,
): Promise<string> {
  if (baseBranch == null) return projectConfig.git.baseBranch;
  if (!projectConfig.git.enabled) {
    throw new HttpError(400, "baseBranch cannot be set when git is disabled");
  }
  const branches = await new GitService(projectConfig).listLocalBranches();
  if (!branches.includes(baseBranch)) {
    throw new HttpError(400, `Unknown local branch: ${baseBranch}`);
  }
  return baseBranch;
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
    graphifyRunner: ctx.graphifyRunner,
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
    json(response, 200, {
      project: {
        name: path.basename(projectConfig.repositoryRoot),
        root: projectConfig.repositoryRoot,
        configPath: ctx.configPath,
        models: projectConfig.models,
        agent: { provider: projectConfig.agent.provider, ...ctx.agentReadiness },
        graphify: { enabled: projectConfig.knowledge.graphify.enabled },
        git: {
          enabled: projectConfig.git.enabled,
          baseBranch: projectConfig.git.baseBranch,
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
    const graphify = optionalBoolean(body.graphify, "graphify");
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
        graphify: {
          ...projectConfig.knowledge.graphify,
          enabled: graphify ?? projectConfig.knowledge.graphify.enabled,
        },
      },
    });
    const engine = new HarnessEngine(runConfig, {
      backend: ctx.backend,
      graphifyRunner: ctx.graphifyRunner,
    });
    // Creating the durable run must be quick. A first semantic index may
    // take minutes for a large repository, so run it in the visible job
    // queue rather than holding the browser request open.
    // UI already prepares Graphify and refreshes knowledge inside the job
    // queue so the browser request can return immediately.
    const state = await engine.start(idea, runId, false, false);
    if (state.phase !== "blocked" && state.phase !== "cancelled" && state.phase !== "completed") {
      ctx.jobs.enqueue(runId, "index knowledge and reflect", async () => {
        const opened = await openRunHarness(projectConfig, runId, {
          backend: ctx.backend,
          store: ctx.store,
          graphifyRunner: ctx.graphifyRunner,
        });
        await runInitialSetupThenAdvance(initialSetupFromOpened(ctx, runId, opened));
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
    const [events, sessions, agentActivity, artifacts, runConfig, installLog, workspace] =
      await Promise.all([
        readEvents(ctx.store, runId),
        readSessionSummaries(ctx.store, runId),
        readAgentActivity(ctx.store, runId),
        listArtifacts(ctx.store, runId),
        loadRunConfig(projectConfig, runId).catch(() => null),
        readInstallLog(ctx.store, runId),
        loadRunWorkspace(projectConfig, runId).catch(() => null),
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
          maxInvocationTokens: runConfig.workflow.maxInvocationTokens,
          maxTaskTokens: runConfig.workflow.maxTaskTokens,
          maxContextTurns: runConfig.workflow.maxContextTurns,
        }
      : undefined;
    const retrievalPolicy = runConfig
      ? {
          rag: runConfig.workflow.rag,
          graphify: runConfig.knowledge.graphify.enabled,
        }
      : undefined;
    const deliveryWorkspace = workspace
      ? {
          kind: workspace.kind,
          worktreePath: workspace.worktreePath,
          baseBranch: workspace.baseBranch,
          baseSha: workspace.baseSha,
          branchName: workspace.branchName ?? state.branchName,
          removedAt: workspace.removedAt,
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
    const opened = await openRunHarness(
      projectConfig,
      runId,
      { backend: ctx.backend, store: ctx.store, graphifyRunner: ctx.graphifyRunner },
      {
        validateWorktree:
          action !== "cancel" && action !== "note" && action !== "stop",
      },
    );
    const engine = opened.engine;
    if (action === "continue") {
      ctx.jobs.enqueue(runId, action, () => engine.advance(runId));
    } else if (action === "resume") {
      // Jobs are intentionally process-local. A dashboard restart keeps the
      // durable run state but cannot safely assume that an interrupted
      // provider call should be retried. Make recovery an explicit action.
      // Runs still in `new` retry Graphify then the document index; later
      // phases refresh the index in case it was cleared while stopped.
      ctx.jobs.enqueue(runId, "resume run", async () => {
        const latest = await ctx.store.load(runId);
        if (latest.phase === "new") {
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
          ctx.setProjectConfig(updated.config);
          const relative = path
            .relative(updated.config.repositoryRoot, ctx.configPath)
            .replaceAll("\\", "/");
          if (relative && !relative.startsWith("..")) reportPaths = [relative];
        }
        await engine.applyApprovedFix(runId, {
          persistedProjectDefaults: persistProjectDefaults,
          reportPaths,
        });
        // Reload frozen config so the resumed transition sees the applied repair.
        const refreshed = await loadRunConfig(ctx.getProjectConfig(), runId);
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
          await runInitialSetupThenAdvance(initialSetupFromOpened(ctx, runId, opened));
          return;
        }
        await engine.advance(runId);
      });
    } else if (action === "commit_preflight") {
      if (opened.workspace.kind !== "legacy-shared") {
        throw new HttpError(
          400,
          "Preflight commit-order controls are only available for legacy-shared runs. " +
            "Worktree runs start from the committed base and never import control-checkout dirt.",
        );
      }
      const order = optionalEnum(body.order, "order", PREFLIGHT_COMMIT_ORDER_VALUES);
      const message = optionalString(body.message, "message", 500);
      ctx.jobs.enqueue(runId, action, async () => {
        ctx.jobs.setDetail(runId, "Committing the working tree");
        await engine.commitPreflight(runId, { order, message });
        ctx.jobs.setDetail(runId, "Resuming the run");
        await engine.advance(runId);
      });
    } else if (action === "cleanup") {
      const discard = optionalBoolean(body.discard, "discard") ?? false;
      ctx.jobs.enqueue(runId, action, async () => {
        ctx.jobs.setDetail(runId, "Cleaning up run worktree");
        await engine.cleanup(runId, { discard });
      });
    } else if (action === "migrate_workspace") {
      ctx.jobs.enqueue(runId, action, async () => {
        ctx.jobs.setDetail(runId, "Migrating legacy workspace to a worktree");
        await engine.migrateWorkspace(runId);
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
      ctx.setProjectConfig(updated.config);
      const configRelative = path
        .relative(updated.config.repositoryRoot, ctx.configPath)
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
        const refreshed = await loadRunConfig(ctx.getProjectConfig(), runId);
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
        const refreshed = await loadRunConfig(ctx.getProjectConfig(), runId);
        await new HarnessEngine(refreshed, { backend: ctx.backend }).advance(runId);
      });
    } else if (action === "set_rag") {
      const rag = optionalBoolean(body.rag, "rag");
      if (rag == null) throw new HttpError(400, "rag must be a boolean");
      ctx.jobs.enqueue(runId, action, () => engine.setRag(runId, rag));
    } else if (action === "set_graphify") {
      const enabled = optionalBoolean(body.graphify, "graphify");
      if (enabled == null) throw new HttpError(400, "graphify must be a boolean");
      ctx.jobs.enqueue(runId, action, () => engine.setGraphify(runId, enabled));
    } else if (action === "stop") {
      // Stop must not wait behind the work it is pausing after (same as cancel).
      const state = await engine.requestStop(runId);
      json(response, 200, { accepted: true, state });
      return true;
    } else if (action === "cancel") {
      // Cancel must not wait behind the work it is aborting (or 409 on a busy run).
      const result = await engine.cancel(runId);
      json(response, result.pending ? 202 : 200, {
        accepted: true,
        pending: result.pending,
        state: result.state,
      });
      return true;
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
