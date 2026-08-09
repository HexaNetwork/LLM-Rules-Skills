import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  HarnessConfigSchema,
  loadRunConfig,
  writeProjectSettings,
  type HarnessConfig,
} from "../config.js";
import type { AgentBackend } from "../agent.js";
import { HarnessEngine } from "../engine.js";
import { GitService, pathToIgnoredArtifactGlob } from "../git.js";
import { LocalKnowledgeBase } from "../knowledge.js";
import { prepareGraphifyForRun } from "../graphify.js";
import { RunStore } from "../store.js";
import { ReflectOutputSchema, type ReflectOutput, type RunState, type WorkPacket } from "../domain.js";
import { renderPrompt, renderPromptBuilderPrompt } from "../prompts.js";
import { renderDashboard } from "./app.js";

export type UiJob = {
  runId: string;
  action: string;
  status: "queued" | "running" | "failed";
  detail?: string;
  error?: string;
  queuedAt: string;
  startedAt?: string;
};

/** How long a failed job stays visible so the dashboard can toast the error. */
const FAILED_JOB_TTL_MS = 30_000;

export type UiServerOptions = {
  config: HarnessConfig;
  backend: AgentBackend;
  configPath?: string;
  port?: number;
  token?: string;
  openBrowser?: boolean;
};

export type UiServer = {
  origin: string;
  url: string;
  token: string;
  port: number;
  close(): Promise<void>;
};

type IntegerSettingDefinition = {
  key: string;
  category: string;
  label: string;
  description: string;
  type: "integer";
  minimum: number;
  maximum: number;
};
type BooleanSettingDefinition = {
  key: string;
  category: string;
  label: string;
  description: string;
  type: "boolean";
};
type EnumSettingDefinition = {
  key: string;
  category: string;
  label: string;
  description: string;
  type: "enum";
  options: Array<{ value: string; label: string }>;
};
type SettingDefinition = IntegerSettingDefinition | BooleanSettingDefinition | EnumSettingDefinition;

const PREFLIGHT_COMMIT_ORDER_VALUES = ["branch-then-commit", "commit-then-branch"] as const;

const SESSION_COOKIE = "harness_token";

const PROJECT_SETTING_DEFINITIONS: SettingDefinition[] = [
  {
    key: "workflow.maxGrillQuestionsPerEpisode",
    category: "Context & cost",
    label: "Grill questions per episode",
    description:
      "Reuse one provider session for this many Q→A turns before starting a fresh grill context.",
    type: "integer",
    minimum: 1,
    maximum: 50,
  },
  {
    key: "workflow.staleAnswerMinutes",
    category: "Context & cost",
    label: "Stale answer threshold (minutes)",
    description:
      "If a human answer arrives after this many minutes, continue with a fresh agent using only the question and answer.",
    type: "integer",
    minimum: 1,
    maximum: 1440,
  },
  {
    key: "workflow.grillQuestionsPerBatch",
    category: "Context & cost",
    label: "Grill questions per batch",
    description:
      "Ceiling on how many mutually independent questions the griller may ask in one turn. A ceiling, not a target.",
    type: "integer",
    minimum: 1,
    maximum: 6,
  },
  {
    key: "git.autoCommitPreflight",
    category: "Git",
    label: "Auto-commit a dirty tree before a run",
    description:
      "When on, start() commits a dirty working tree itself instead of blocking. Off by default; the blocked-run card always offers this as an explicit action either way.",
    type: "boolean",
  },
  {
    key: "git.preflightCommitOrder",
    category: "Git",
    label: "Preflight commit order",
    description:
      "Whether a preflight commit lands on the run branch (cut from current HEAD, not baseBranch) or on the current branch before the run branch is created normally.",
    type: "enum",
    options: [
      { value: "branch-then-commit", label: "Commit onto the run branch" },
      { value: "commit-then-branch", label: "Commit onto the current branch" },
    ],
  },
];

export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const host = "127.0.0.1";
  const token = options.token ?? randomBytes(24).toString("hex");
  let projectConfig = options.config;
  const store = new RunStore(projectConfig);
  const knowledge = new LocalKnowledgeBase(projectConfig);
  const agentReadiness = options.backend.readiness?.() ?? { ready: true };
  const jobs = new Map<string, UiJob>();
  let queue = Promise.resolve();
  await store.initialize();

  const enqueue = (
    runId: string,
    action: string,
    operation: () => Promise<unknown>,
  ): void => {
    const existing = jobs.get(runId);
    if (existing && existing.status !== "failed") {
      throw new HttpError(409, `Run ${runId} already has queued work`);
    }
    const job: UiJob = {
      runId,
      action,
      status: "queued",
      queuedAt: new Date().toISOString(),
    };
    jobs.set(runId, job);
    const scheduled = queue
      .catch(() => undefined)
      .then(async () => {
        jobs.set(runId, {
          ...job,
          status: "running",
          startedAt: new Date().toISOString(),
        });
        try {
          await operation();
          jobs.delete(runId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          jobs.set(runId, {
            ...job,
            status: "failed",
            startedAt: jobs.get(runId)?.startedAt ?? new Date().toISOString(),
            error: message,
          });
          setTimeout(() => {
            const current = jobs.get(runId);
            if (current?.status === "failed") jobs.delete(runId);
          }, FAILED_JOB_TTL_MS);
        }
      });
    queue = scheduled.catch(() => undefined);
  };

  const server = http.createServer(async (request, response) => {
    try {
      setSecurityHeaders(response);
      const url = new URL(request.url ?? "/", `http://${host}`);
      if (url.pathname === "/health") {
        return json(response, 200, { ok: true });
      }
      // Serve the HTML shell without a query token so browser refresh still works
      // after the client strips ?token= from the address bar into sessionStorage.
      // API routes below still require the header/query/cookie token.
      if (!url.pathname.startsWith("/api/")) {
        if (url.pathname !== "/") throw new HttpError(404, "Not found");
        // A refresh loses the token: the client strips ?token= from the address
        // bar, and per-tab sessionStorage is not reliably carried across every
        // reload path. Bind the token to this origin as an HttpOnly session
        // cookie so reloads stay authenticated without putting it back in the URL.
        if (url.searchParams.get("token") === token) {
          response.setHeader(
            "Set-Cookie",
            `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`,
          );
        }
        return html(response, renderDashboard());
      }
      if (!authorized(request, url, token)) {
        return json(response, 401, { error: "Invalid or missing dashboard token" });
      }

      if (request.method === "GET" && url.pathname === "/api/bootstrap") {
        const { states: runs, failures } = await store.listWithFailures();
        return json(response, 200, {
          project: {
            name: path.basename(projectConfig.repositoryRoot),
            root: projectConfig.repositoryRoot,
            configPath: options.configPath,
            models: projectConfig.models,
            agent: { provider: projectConfig.agent.provider, ...agentReadiness },
            graphify: { enabled: projectConfig.knowledge.graphify.enabled },
            git: {
              enabled: projectConfig.git.enabled,
              baseBranch: projectConfig.git.baseBranch,
              branches: await new GitService(projectConfig).listLocalBranches(),
            },
            defaults: {
              tdd: projectConfig.workflow.tdd,
              push: projectConfig.git.push,
              openPullRequest: projectConfig.git.openPullRequest,
            },
            settings: projectSettings(projectConfig, options.configPath),
          },
          runs: runs.map((state) => summarizeRun(state, jobs.get(state.runId))),
          unreadableRuns: failures,
          jobs: [...jobs.values()],
        });
      }

      if (request.method === "GET" && url.pathname === "/api/settings") {
        return json(response, 200, { settings: projectSettings(projectConfig, options.configPath) });
      }

      if (request.method === "PUT" && url.pathname === "/api/settings") {
        if (!options.configPath) {
          throw new HttpError(409, "This dashboard was started without a writable config path");
        }
        const body = await readJsonBody(request);
        const values = requiredRecord(body.values, "values");
        const known = new Set<string>([
          ...PROJECT_SETTING_DEFINITIONS.map((setting) => setting.key),
          "git.ignoredArtifactPatterns",
        ]);
        const unknown = Object.keys(values).filter((key) => !known.has(key));
        if (unknown.length) throw new HttpError(400, `Unknown setting: ${unknown.join(", ")}`);
        const maxGrillQuestionsPerEpisode = optionalInteger(
          values["workflow.maxGrillQuestionsPerEpisode"],
          "workflow.maxGrillQuestionsPerEpisode",
          1,
          50,
        );
        const staleAnswerMinutes = optionalInteger(
          values["workflow.staleAnswerMinutes"],
          "workflow.staleAnswerMinutes",
          1,
          1440,
        );
        const grillQuestionsPerBatch = optionalInteger(
          values["workflow.grillQuestionsPerBatch"],
          "workflow.grillQuestionsPerBatch",
          1,
          6,
        );
        const autoCommitPreflight = optionalBoolean(
          values["git.autoCommitPreflight"],
          "git.autoCommitPreflight",
        );
        const preflightCommitOrder = optionalEnum(
          values["git.preflightCommitOrder"],
          "git.preflightCommitOrder",
          PREFLIGHT_COMMIT_ORDER_VALUES,
        );
        const ignoredArtifactPatterns = optionalStringArray(
          values["git.ignoredArtifactPatterns"],
          "git.ignoredArtifactPatterns",
          500,
        );
        if (maxGrillQuestionsPerEpisode == null) {
          throw new HttpError(400, "workflow.maxGrillQuestionsPerEpisode is required");
        }
        if (staleAnswerMinutes == null) {
          throw new HttpError(400, "workflow.staleAnswerMinutes is required");
        }
        const updated = await writeProjectSettings(options.configPath, {
          workflow: {
            maxGrillQuestionsPerEpisode,
            staleAnswerMinutes,
            ...(grillQuestionsPerBatch != null ? { grillQuestionsPerBatch } : {}),
          },
          ...(autoCommitPreflight != null ||
          preflightCommitOrder != null ||
          ignoredArtifactPatterns != null
            ? {
                git: {
                  ...(autoCommitPreflight != null ? { autoCommitPreflight } : {}),
                  ...(preflightCommitOrder != null ? { preflightCommitOrder } : {}),
                  ...(ignoredArtifactPatterns != null ? { ignoredArtifactPatterns } : {}),
                },
              }
            : {}),
        });
        projectConfig = updated.config;
        return json(response, 200, {
          settings: projectSettings(projectConfig, options.configPath),
          appliesTo: "new_runs",
        });
      }

      if (request.method === "GET" && url.pathname === "/api/runs") {
        const { states: runs, failures } = await store.listWithFailures();
        return json(response, 200, {
          runs: runs.map((state) => summarizeRun(state, jobs.get(state.runId))),
          unreadableRuns: failures,
        });
      }

      if (request.method === "POST" && url.pathname === "/api/runs") {
        if (!agentReadiness.ready) {
          throw new HttpError(503, agentReadiness.message ?? "The configured agent backend is unavailable");
        }
        const body = await readJsonBody(request);
        const idea = requiredString(body.idea, "idea", 100_000);
        const runId = optionalString(body.runId, "runId", 100) ?? randomUUID();
        const tdd = optionalBoolean(body.tdd, "tdd") ?? projectConfig.workflow.tdd;
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
          workflow: { ...projectConfig.workflow, tdd },
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
        const engine = new HarnessEngine(runConfig, { backend: options.backend });
        // Creating the durable run must be quick. A first semantic index may
        // take minutes for a large repository, so run it in the visible job
        // queue rather than holding the browser request open.
        // UI already prepares Graphify and refreshes knowledge inside the job
        // queue so the browser request can return immediately.
        const state = await engine.start(idea, runId, false, false);
        enqueue(runId, "index knowledge and reflect", async () => {
          const current = jobs.get(runId);
          if (current) jobs.set(runId, { ...current, detail: "Checking Graphify for this project" });
          const graphify = await prepareGraphifyForRun(runConfig);
          const prepared = jobs.get(runId);
          if (prepared && graphify.enabled) {
            jobs.set(runId, {
              ...prepared,
              detail: graphify.setupRan
                ? "Graphify installed and the repository graph is ready"
                : "Graphify repository graph is ready",
            });
          }
          await knowledge.refresh((progress) => {
            const current = jobs.get(runId);
            if (current) jobs.set(runId, { ...current, detail: progress.message });
          });
          await engine.advance(runId);
        });
        return json(response, 202, { run: summarizeRun(state, jobs.get(runId)) });
      }

      const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (request.method === "GET" && runMatch) {
        const runId = decodeURIComponent(runMatch[1]!);
        const state = await store.load(runId);
        const job = jobs.get(runId);
        const activity = await readActivity(store, runId);
        const signature = runSignature(state, job, activity);
        const since = url.searchParams.get("since");
        if (since && since === signature) {
          return json(response, 200, { unchanged: true, signature });
        }
        const [events, sessions, artifacts, runConfig, installLog] = await Promise.all([
          readEvents(store, runId),
          readSessionSummaries(store, runId),
          listArtifacts(store, runId),
          loadRunConfig(projectConfig, runId).catch(() => null),
          readInstallLog(store, runId),
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
              maxStepsPerRun: runConfig.workflow.maxStepsPerRun,
            }
          : undefined;
        return json(response, 200, {
          state,
          job,
          events,
          sessions,
          artifacts,
          activity,
          installLog,
          signature,
          ...(git ? { git } : {}),
          ...(ceilings ? { ceilings } : {}),
        });
      }

      const actionMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/actions$/);
      if (request.method === "POST" && actionMatch) {
        const runId = decodeURIComponent(actionMatch[1]!);
        const body = await readJsonBody(request);
        const action = requiredString(body.action, "action", 40);
        if (action !== "cancel" && action !== "note" && action !== "stop" && !agentReadiness.ready) {
          throw new HttpError(503, agentReadiness.message ?? "The configured agent backend is unavailable");
        }
        const runConfig = await loadRunConfig(projectConfig, runId);
        const engine = new HarnessEngine(runConfig, { backend: options.backend });
        if (action === "continue") {
          enqueue(runId, action, () => engine.advance(runId));
        } else if (action === "resume") {
          // Jobs are intentionally process-local. A dashboard restart keeps the
          // durable run state but cannot safely assume that an interrupted
          // provider call should be retried. Make recovery an explicit action,
          // and rebuild knowledge first in case the index was cleared while
          // the dashboard was stopped.
          enqueue(runId, "resume run", async () => {
            await knowledge.refresh((progress) => {
              const current = jobs.get(runId);
              if (current) jobs.set(runId, { ...current, detail: progress.message });
            });
            await engine.advance(runId);
          });
        } else if (action === "answer") {
          const { answers, parked, clarifications } = parseAnswerBody(body);
          enqueue(runId, action, async () => {
            await engine.answerMany(runId, answers, parked, clarifications);
            await engine.advance(runId);
          });
        } else if (action === "note") {
          const text = requiredString(body.text, "text", 20_000);
          const asUnknown = optionalBoolean(body.asUnknown, "asUnknown") ?? false;
          enqueue(runId, action, () => engine.addNote(runId, text, asUnknown));
        } else if (action === "retry") {
          const force = optionalBoolean(body.force, "force") ?? false;
          const maxRunTokens = optionalNonNegativeNumber(body.maxRunTokens, "maxRunTokens");
          const maxRunCostUsd = optionalNonNegativeNumber(body.maxRunCostUsd, "maxRunCostUsd");
          enqueue(runId, action, async () => {
            await engine.retry(runId, { force, maxRunTokens, maxRunCostUsd });
            await engine.advance(runId);
          });
        } else if (action === "commit_preflight") {
          const order = optionalEnum(body.order, "order", PREFLIGHT_COMMIT_ORDER_VALUES);
          const message = optionalString(body.message, "message", 500);
          enqueue(runId, action, async () => {
            await engine.commitPreflight(runId, { order, message });
            await engine.advance(runId);
          });
        } else if (action === "accept_tree") {
          enqueue(runId, action, async () => {
            await engine.acceptTree(runId);
            await engine.advance(runId);
          });
        } else if (action === "ignore_artifacts") {
          if (!options.configPath) {
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
          const updated = await writeProjectSettings(options.configPath, {
            git: { ignoredArtifactPatterns: merged },
          });
          projectConfig = updated.config;
          const configRelative = path
            .relative(projectConfig.repositoryRoot, options.configPath)
            .replaceAll("\\", "/");
          const liveConfig = await loadRunConfig(projectConfig, runId);
          const liveEngine = new HarnessEngine(liveConfig, { backend: options.backend });
          enqueue(runId, action, async () => {
            // Persist the config edit as a reported path on the active task so later
            // commitTask / divergence checks treat it as intentional harness work.
            await liveEngine.acceptTree(runId, {
              reportPaths: configRelative && !configRelative.startsWith("..") ? [configRelative] : [],
            });
            await liveEngine.advance(runId);
          });
        } else if (action === "resolve_installs") {
          const accepted = optionalStringArray(body.accepted, "accepted", 200) ?? [];
          const denied = optionalStringArray(body.denied, "denied", 200) ?? [];
          enqueue(runId, action, async () => {
            await engine.resolveInstalls(runId, { accepted, denied });
            await engine.advance(runId);
          });
        } else if (action === "set_tdd") {
          const tdd = optionalBoolean(body.tdd, "tdd");
          if (tdd == null) throw new HttpError(400, "tdd must be a boolean");
          const taskId = optionalString(body.taskId, "taskId", 200);
          enqueue(runId, action, () => engine.setTdd(runId, tdd, taskId));
        } else if (action === "stop") {
          // Stop must not wait behind the work it is pausing after (same as cancel).
          const state = await engine.requestStop(runId);
          return json(response, 200, { accepted: true, state });
        } else if (action === "cancel") {
          // Cancel must not wait behind the work it is aborting (or 409 on a busy run).
          const result = await engine.cancel(runId);
          return json(response, result.pending ? 202 : 200, {
            accepted: true,
            pending: result.pending,
            state: result.state,
          });
        } else {
          throw new HttpError(400, `Unsupported action: ${action}`);
        }
        return json(response, 202, { accepted: true, job: jobs.get(runId) });
      }

      const artifactMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/artifact$/);
      if (request.method === "GET" && artifactMatch) {
        const runId = decodeURIComponent(artifactMatch[1]!);
        const artifactPath = url.searchParams.get("path") ?? "";
        if (!allowedArtifact(artifactPath)) throw new HttpError(400, "Artifact path is not readable");
        const content = await store.readText(runId, artifactPath);
        return json(response, 200, { path: artifactPath, content: content.slice(0, 1_000_000) });
      }

      const sessionMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/session$/);
      if (request.method === "GET" && sessionMatch) {
        const runId = decodeURIComponent(sessionMatch[1]!);
        const sessionPath = url.searchParams.get("path") ?? "";
        if (!/^sessions\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(sessionPath)) {
          throw new HttpError(400, "Session path is not readable");
        }
        return json(response, 200, await readSessionDetail(store, runId, sessionPath));
      }

      if (request.method === "POST" && url.pathname === "/api/knowledge/search") {
        const body = await readJsonBody(request);
        const query = requiredString(body.query, "query", 10_000);
        const limit = optionalInteger(body.limit, "limit", 1, 20) ?? 8;
        return json(response, 200, { results: await knowledge.search(query, limit) });
      }

      if (request.method === "GET" && url.pathname === "/api/knowledge/status") {
        const embeddings = projectConfig.knowledge.embeddings;
        return json(response, 200, {
          lexical: true,
          semantic: {
            enabled: embeddings.enabled,
            provider: embeddings.provider,
            model: embeddings.model,
            endpoint: embeddings.endpoint,
          },
          graphify: { enabled: projectConfig.knowledge.graphify.enabled },
          sources: projectConfig.knowledge.sources.map((source) => source.path),
        });
      }

      if (request.method === "POST" && url.pathname === "/api/knowledge/refresh") {
        return json(response, 200, { changed: await knowledge.refresh() });
      }

      if (request.method === "POST" && url.pathname === "/api/knowledge/add") {
        const body = await readJsonBody(request);
        const relativePath = requiredString(body.path, "path", 2_000);
        const target = path.resolve(projectConfig.repositoryRoot, relativePath);
        assertInside(projectConfig.repositoryRoot, target);
        return json(response, 200, { changed: await knowledge.upsertFile(target) });
      }

      throw new HttpError(404, "Not found");
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      json(response, status, { error: message });
    }
  });

  const port = options.port ?? 8787;
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${port} is already in use on ${host}. Stop the other harness UI, or pass --port <number>.`,
          ),
        );
        return;
      }
      reject(error);
    });
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Dashboard did not bind a TCP port");
  const origin = `http://${host}:${address.port}`;
  const dashboardUrl = `${origin}/?token=${encodeURIComponent(token)}`;
  if (options.openBrowser) openDashboard(dashboardUrl);

  return {
    origin,
    url: dashboardUrl,
    token,
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function summarizeRun(state: RunState, job?: UiJob): Record<string, unknown> {
  const activeQuestion = state.questions.find((question) => question.id === state.activeQuestionId);
  const completedTasks = state.tasks.filter((task) => task.status === "done").length;
  return {
    runId: state.runId,
    idea: state.idea,
    destination: state.reflectBrief?.confirmed?.slice(0, 120) ?? state.reflectBrief?.draft?.slice(0, 120),
    phase: state.phase,
    updatedAt: state.updatedAt,
    createdAt: state.createdAt,
    taskProgress: { completed: completedTasks, total: state.tasks.length },
    decisions: {
      resolved: state.grillResolutions.length,
      total: state.grillResolutions.length + (activeQuestion?.purpose === "grill" ? 1 : 0),
    },
    activeQuestion,
    failure: state.failure,
    branchName: state.branchName,
    pullRequestUrl: state.pullRequestUrl,
    job,
  };
}

type UiActivity = {
  sessionId?: string;
  role?: string;
  model?: string;
  startedAt?: string;
  lastStepAt?: string;
  lastStepSummary?: string;
  stepCount?: number;
  truncated?: boolean;
};

/**
 * Cheap change signature for polling clients: state.revision plus job status
 * plus lastEventSequence plus live activity — no events.jsonl read needed to
 * detect "nothing changed". activity.lastStepAt and stepCount must be included
 * or unchanged-poll short-circuiting hides in-flight agent steps.
 */
function runSignature(state: RunState, job?: UiJob, activity?: UiActivity | null): string {
  const activityPart = activity
    ? `${activity.lastStepAt ?? ""}:${activity.stepCount ?? 0}`
    : "none";
  const jobPart = job
    ? `${job.status}:${job.detail ?? ""}:${job.error ?? ""}`
    : "none";
  return `${state.revision}:${state.lastEventSequence}:${jobPart}:${activityPart}`;
}

async function readActivity(store: RunStore, runId: string): Promise<UiActivity | null> {
  try {
    const value = await store.readJson(runId, "activity.json");
    return isRecord(value) ? (value as UiActivity) : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function projectSettings(config: HarnessConfig, configPath?: string): Record<string, unknown> {
  return {
    editable: configPath != null,
    appliesTo: "new_runs",
    definitions: PROJECT_SETTING_DEFINITIONS,
    values: {
      "workflow.maxGrillQuestionsPerEpisode": config.workflow.maxGrillQuestionsPerEpisode,
      "workflow.staleAnswerMinutes": config.workflow.staleAnswerMinutes,
      "workflow.grillQuestionsPerBatch": config.workflow.grillQuestionsPerBatch,
      "git.autoCommitPreflight": config.git.autoCommitPreflight,
      "git.preflightCommitOrder": config.git.preflightCommitOrder,
      "git.ignoredArtifactPatterns": config.git.ignoredArtifactPatterns,
    },
  };
}

async function readEvents(store: RunStore, runId: string): Promise<unknown[]> {
  try {
    const raw = await store.readText(runId, "events.jsonl");
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-200)
      .map((line) => JSON.parse(line) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readSessionSummaries(store: RunStore, runId: string): Promise<unknown[]> {
  // sessions/ also holds <id>.steps.jsonl (NDJSON); only *.json are session records.
  const files = (await store.listFiles(runId, "sessions")).filter((file) => file.endsWith(".json"));
  const sessions = await Promise.all(
    files.map(async (file) => {
      const value = (await store.readJson(runId, file)) as Record<string, unknown>;
      return {
        path: file,
        sessionId: value.sessionId,
        role: value.role,
        model: value.model,
        status: value.status,
        attempt: value.attempt,
        startedAt: value.startedAt,
        endedAt: value.endedAt,
        providerSessionId: value.providerSessionId,
        providerRunId: value.providerRunId,
        providerSessionReused: value.providerSessionReused,
        usage: value.usage,
        handoff: value.handoff,
        error: value.error,
      };
    }),
  );
  return sessions.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

async function readSessionDetail(
  store: RunStore,
  runId: string,
  sessionPath: string,
): Promise<Record<string, unknown>> {
  const session = (await store.readJson(runId, sessionPath)) as Record<string, unknown>;
  const packetPath =
    typeof session.packet === "string" &&
    /^packets\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(session.packet)
      ? session.packet
      : undefined;
  const packet = packetPath
    ? ((await store.readJson(runId, packetPath)) as WorkPacket)
    : undefined;
  const retrievalPath = packetPath?.replace(/\.json$/, ".retrieval.json");
  const retrievalArtifact = retrievalPath
    ? await store.readJson(runId, retrievalPath).catch(() => undefined)
    : undefined;
  // New runs store `{ retrieval, budget }`; older artifacts were a flat audit.
  const retrievalRecord = isRecord(retrievalArtifact) ? retrievalArtifact : undefined;
  const retrieval = retrievalRecord && isRecord(retrievalRecord.retrieval)
    ? {
        ...retrievalRecord.retrieval,
        ...(retrievalRecord.budget != null ? { budget: retrievalRecord.budget } : {}),
      }
    : retrievalArtifact;
  const reconstructed = await submittedPrompt(store, runId, session, packet);
  const handoff = isRecord(session.handoff) ? session.handoff : undefined;
  const artifactRefs = Array.isArray(handoff?.artifactRefs)
    ? handoff.artifactRefs.filter((value): value is string => typeof value === "string")
    : [];

  const stepsPath = sessionPath.replace(/\.json$/, ".steps.jsonl");
  const steps = await readSessionSteps(store, runId, stepsPath);

  return {
    session,
    packet,
    retrieval,
    steps,
    stepsPath: steps ? stepsPath : undefined,
    inputPrompt: reconstructed.prompt,
    inputSource: reconstructed.source,
    relatedArtifacts: [
      ...new Set(
        [sessionPath, packetPath, retrievalPath, steps ? stepsPath : undefined, ...artifactRefs].filter(
          isString,
        ),
      ),
    ],
  };
}

async function readSessionSteps(
  store: RunStore,
  runId: string,
  stepsPath: string,
): Promise<unknown[] | undefined> {
  try {
    const raw = await store.readText(runId, stepsPath);
    const lines = raw
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-500)
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return { type: "invalid", summary: line.slice(0, 200) };
        }
      });
    return lines;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function submittedPrompt(
  store: RunStore,
  runId: string,
  session: Record<string, unknown>,
  packet: WorkPacket | undefined,
): Promise<{ prompt?: string; source: string }> {
  if (typeof session.prompt === "string") {
    return { prompt: session.prompt, source: "stored exact input" };
  }
  if (!packet) return { source: "unavailable: packet missing" };

  const role = String(session.role ?? "");
  const files = (await store.listFiles(runId, "sessions")).filter((file) => file.endsWith(".json"));
  const related = await Promise.all(
    files.map(async (file) => (await store.readJson(runId, file)) as Record<string, unknown>),
  );
  let prompt: string;
  let source: string;
  if (role === "prompt-builder") {
    prompt = renderPromptBuilderPrompt(packet);
    source = "reconstructed deterministic compiler input";
  } else {
    const compiler = related
      .filter(
        (candidate) =>
          candidate.invocationId === session.invocationId &&
          candidate.role === "prompt-builder" &&
          candidate.status === "completed" &&
          isRecord(candidate.output) &&
          typeof candidate.output.prompt === "string",
      )
      .sort((a, b) => Number(b.attempt ?? 0) - Number(a.attempt ?? 0))[0];
    if (compiler && isRecord(compiler.output) && typeof compiler.output.prompt === "string") {
      prompt = compiler.output.prompt;
      source = "reconstructed compiled input";
    } else {
      prompt = renderPrompt(packet);
      source = "reconstructed deterministic input";
    }
  }

  const attempt = Number(session.attempt ?? 0);
  if (attempt > 0) {
    const previous = related.find(
      (candidate) =>
        candidate.invocationId === session.invocationId &&
        candidate.role === session.role &&
        Number(candidate.attempt) === attempt - 1,
    );
    if (previous && typeof previous.error === "string") {
      prompt = [
        prompt,
        "",
        "Your previous response failed the required JSON contract.",
        `Validation error: ${previous.error.slice(0, 4_000)}`,
        "Return one corrected JSON object only.",
      ].join("\n");
      source += " with schema-repair suffix";
    }
  }
  return { prompt, source };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

async function listArtifacts(store: RunStore, runId: string): Promise<string[]> {
  const grouped = await Promise.all(
    ["issues", "tasks", "packets", "sessions"].map((directory) =>
      store.listFiles(runId, directory),
    ),
  );
  const fixed = [
    "idea.md",
    "brief.md",
    "grill.md",
    "unknowns.md",
    "events.jsonl",
    "state.json",
    "config.json",
    "installs.jsonl",
  ];
  const available: string[] = [];
  for (const file of fixed) {
    try {
      await store.readText(runId, file);
      available.push(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return [...available, ...grouped.flat()];
}

function allowedArtifact(value: string): boolean {
  return (
    [
      "idea.md",
      "brief.md",
      "grill.md",
      "unknowns.md",
      "events.jsonl",
      "state.json",
      "config.json",
      "installs.jsonl",
    ].includes(value) ||
    /^(issues|tasks|packets|sessions)\/[A-Za-z0-9._-]+$/.test(value) ||
    /^sessions\/[A-Za-z0-9][A-Za-z0-9._-]*\.steps\.jsonl$/.test(value)
  );
}

async function readInstallLog(
  store: RunStore,
  runId: string,
): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await store.readText(runId, "installs.jsonl");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return { commandSummary: line };
        }
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function authorized(request: IncomingMessage, url: URL, token: string): boolean {
  return (
    request.headers["x-harness-token"] === token ||
    url.searchParams.get("token") === token ||
    readCookie(request, SESSION_COOKIE) === token
  );
}

function readCookie(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new HttpError(413, "Request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "JSON body must be an object");
  }
  return parsed as Record<string, unknown>;
}

const MAX_ANSWER_BATCH = 6;

/**
 * Accepts both the legacy CLI shape {questionId, answer} and the batched
 * dashboard shape {answers: [{questionId, answer, optionId?, structured?}], parked?, clarifications?}.
 * `structured` is validated here since it is untrusted client input.
 */
export function parseAnswerBody(body: Record<string, unknown>): {
  answers: Array<{ questionId: string; answer: string; optionId?: string; structured?: ReflectOutput }>;
  parked: string[];
  clarifications: Array<{ questionId: string; text: string }>;
} {
  if (Array.isArray(body.answers) || Array.isArray(body.parked) || Array.isArray(body.clarifications)) {
    const answerItems = Array.isArray(body.answers) ? body.answers : [];
    if (answerItems.length > MAX_ANSWER_BATCH) {
      throw new HttpError(400, `answers must include at most ${MAX_ANSWER_BATCH} entries`);
    }
    const parked = Array.isArray(body.parked)
      ? body.parked.map((value, index) => requiredString(value, `parked[${index}]`, 200))
      : [];
    if (parked.length > MAX_ANSWER_BATCH) {
      throw new HttpError(400, `parked must include at most ${MAX_ANSWER_BATCH} entries`);
    }
    const clarificationItems = Array.isArray(body.clarifications) ? body.clarifications : [];
    if (clarificationItems.length > MAX_ANSWER_BATCH) {
      throw new HttpError(400, `clarifications must include at most ${MAX_ANSWER_BATCH} entries`);
    }
    const clarifications = clarificationItems.map((item, index) => {
      const record = requiredRecord(item, `clarifications[${index}]`);
      return {
        questionId: requiredString(record.questionId, `clarifications[${index}].questionId`, 200),
        text: requiredString(record.text, `clarifications[${index}].text`, 20_000),
      };
    });
    const answers = answerItems.map((item, index) => {
      const record = requiredRecord(item, `answers[${index}]`);
      let structured: ReflectOutput | undefined;
      if (record.structured != null) {
        const parsed = ReflectOutputSchema.safeParse(record.structured);
        if (!parsed.success) throw new HttpError(400, `answers[${index}].structured is invalid`);
        structured = parsed.data;
      }
      return {
        questionId: requiredString(record.questionId, `answers[${index}].questionId`, 200),
        answer: requiredString(record.answer, `answers[${index}].answer`, 100_000),
        optionId: optionalString(record.optionId, `answers[${index}].optionId`, 200),
        structured,
      };
    });
    if (answers.length === 0 && parked.length === 0 && clarifications.length === 0) {
      throw new HttpError(
        400,
        "answers must include at least one entry, or parked/clarifications must be non-empty",
      );
    }
    const answerIds = new Set(answers.map((entry) => entry.questionId));
    const parkedIds = new Set(parked);
    for (const id of parkedIds) {
      if (answerIds.has(id)) {
        throw new HttpError(400, `question ${id} cannot be both answered and parked`);
      }
    }
    for (const entry of clarifications) {
      if (answerIds.has(entry.questionId) || parkedIds.has(entry.questionId)) {
        throw new HttpError(
          400,
          `question ${entry.questionId} cannot be clarified when it is also answered or parked`,
        );
      }
    }
    return { answers, parked, clarifications };
  }
  const questionId = requiredString(body.questionId, "questionId", 200);
  const answer = requiredString(body.answer, "answer", 100_000);
  return { answers: [{ questionId, answer }], parked: [], clarifications: [] };
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new HttpError(400, `${field} must be an object`);
  return value;
}

function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${field} is required`);
  if (value.length > max) throw new HttpError(400, `${field} is too long`);
  return value.trim();
}

function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (value == null || value === "") return undefined;
  return requiredString(value, field, max);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value == null) return undefined;
  if (typeof value !== "boolean") throw new HttpError(400, `${field} must be boolean`);
  return value;
}

function optionalInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value == null) return undefined;
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new HttpError(400, `${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return Number(value);
}

function optionalNonNegativeNumber(value: unknown, field: string): number | undefined {
  if (value == null || value === "") return undefined;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new HttpError(400, `${field} must be a non-negative number`);
  }
  return number;
}

function optionalEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new HttpError(400, `${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function optionalStringArray(
  value: unknown,
  field: string,
  maxItemLength: number,
): string[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) {
    throw new HttpError(400, `${field} must be an array of strings`);
  }
  return value.map((item, index) => requiredString(item, `${field}[${index}]`, maxItemLength));
}

async function resolveBaseBranchOverride(
  projectConfig: HarnessConfig,
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

function assertInside(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new HttpError(400, "Path escapes the repository");
  }
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
  );
  response.setHeader("Cache-Control", "no-store");
}

function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(value)}\n`);
}

function html(response: ServerResponse, value: string): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(value);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function openDashboard(url: string): void {
  const [command, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}
