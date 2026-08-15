import http from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import type { AgentBackend } from "../infrastructure/agents/types.js";
import { resolveHarnessPaths } from "../application/paths.js";
import type { HarnessConfig } from "../config/schema.js";
import {
  createRepositoryIntelligenceBroker,
  type ExecutableRunner,
} from "../infrastructure/repository-intelligence/index.js";
import { LocalKnowledgeBase } from "../knowledge.js";
import { RunStore } from "../store.js";
import { renderDashboard } from "./app.js";
import type { UiAppContext } from "./http/context.js";
import {
  HttpError,
  SESSION_COOKIE,
  authorized,
  html,
  httpErrorFromUnknown,
  json,
  setSecurityHeaders,
} from "./http/request.js";
import { handleGuidanceRoutes } from "./http/routes/guidance.js";
import { handleKnowledgeRoutes } from "./http/routes/knowledge.js";
import { handleRunsRoutes } from "./http/routes/runs.js";
import { handleSettingsRoutes } from "./http/routes/settings.js";
import { handleExecutionRoutes } from "./http/routes/execution.js";
import { handleWorkerStateRoutes, type WorkerStateApiContext } from "./http/routes/worker-state.js";
import { RunJobService } from "./run-job-service.js";
import { createDockerClient } from "../infrastructure/container/docker-client.js";
import { evaluateExecutionRuntimeStatus } from "../application/execution-runtime-status.js";
import { reconcileOrphanContainers } from "../application/orphan-reconciler.js";
import { FilesystemRunStatePort } from "../infrastructure/state/filesystem-run-state-port.js";
import {
  WorkerStateCredentialIssuer,
  type IssuedWorkerStateCredential,
} from "../application/worker-state-credentials.js";
import { RUN_STATE_API_PREFIX } from "../worker/state-protocol.js";
import {
  PROVIDER_API_PREFIX,
  PROVIDER_API_PROTOCOL_VERSION,
  type CursorProviderCompatibility,
} from "../worker/provider-protocol.js";
import { WorkerProviderCredentialIssuer } from "../application/worker-provider-credentials.js";
import {
  CursorProviderProxy,
  type CursorProviderAuditRecord,
} from "../infrastructure/provider-proxy/cursor-provider-proxy.js";
import {
  CURSOR_PROVIDER_PROXY_VERSION,
  CURSOR_PROVIDER_UPSTREAM_ORIGINS,
  UNPROVEN_CURSOR_PROVIDER_CONTRACT,
  type CursorProviderContract,
  type CursorProviderUpstream,
} from "../infrastructure/provider-proxy/cursor-provider-contract.js";
import {
  startCursorProviderHttpsListener,
  type CursorProviderHttpsListener,
} from "../infrastructure/provider-proxy/https-listener.js";
import {
  CURSOR_PROVIDER_CA_CONTAINER_PATH,
  ensureCursorProviderTlsMaterial,
} from "../infrastructure/provider-proxy/tls.js";
import { handleWorkerProviderRoutes } from "./http/routes/worker-provider.js";
import { openWorkerRunRuntime } from "../application/run-engine-factory.js";
import { completeDockerHostPublish } from "../application/docker-publish-service.js";
import { loadRunConfig } from "../config/io.js";
import { bootProfile } from "../vnext/boot/boot-profile.js";
import { createHostProfile } from "../vnext/profiles/index.js";
import { createDockerRuntimeService } from "../vnext/plugins/docker-runtime.js";
import type { HostRunLifecycleService } from "../vnext/plugins/host-run-lifecycle.js";
import type { DockerClient } from "../infrastructure/container/types.js";
import { DockerSandboxProvider } from "../sandbox/index.js";
import { SandboxAgentBackend } from "../infrastructure/agents/sandbox-backend.js";

export type { UiJob } from "./run-job-service.js";
export { parseAnswerBody } from "./http/request.js";

export type UiServerOptions = {
  config: HarnessConfig;
  backend: AgentBackend;
  configPath?: string;
  port?: number;
  token?: string;
  openBrowser?: boolean;
  /** Mount dashboard/API adapters. False leaves only health + worker state RPC. */
  dashboard?: boolean;
  repositoryIntelligenceRunner?: ExecutableRunner;
  docker?: DockerClient;
  /**
   * Explicit fake-upstream development seam. HTTP is intentionally accepted
   * only here; production composition remains blocked pending host TLS.
   */
  cursorProviderDevelopment?: {
    upstreamOrigins: Readonly<Record<CursorProviderUpstream, string>>;
    apiKey: string;
    contract: CursorProviderContract;
    tlsIdentity?: string;
    fetch?: typeof fetch;
    audit?: (record: CursorProviderAuditRecord) => void;
    allowInsecureHttp: true;
  };
  /** Host-owned production broker. The contract must already be proven. */
  cursorProviderProduction?: {
    apiKey: string;
    contract: CursorProviderContract;
    port?: number;
    fetch?: typeof fetch;
    audit?: (record: CursorProviderAuditRecord) => void;
  };
};

export type UiServer = {
  origin: string;
  /** Container-reachable origin for worker state RPC. */
  workerStateEndpoint: string;
  /** Present only for the explicit fake-upstream development broker. */
  workerProviderEndpoint?: string;
  url: string;
  token: string;
  port: number;
  runLifecycle: HostRunLifecycleService;
  /**
   * Mint a per-run worker state credential (plan Phase 3). Actual delivery to
   * the worker (bootstrap secret) is wired in a later slice.
   */
  issueWorkerStateCredential(
    runId: string,
    options?: { workerInstanceId?: string; ttlMs?: number },
  ): Promise<IssuedWorkerStateCredential>;
  close(): Promise<void>;
};

export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const host = "127.0.0.1";
  const listenHost = "0.0.0.0";
  const token = options.token ?? randomBytes(24).toString("hex");
  let projectConfig = options.config;
  const paths = resolveHarnessPaths(projectConfig);
  const store = new RunStore(projectConfig, paths.stateRoot);
  const repositoryIntelligenceRunner = options.repositoryIntelligenceRunner;
  const knowledge = new LocalKnowledgeBase(
    projectConfig,
    createRepositoryIntelligenceBroker({
      config: projectConfig,
      paths,
      runner: repositoryIntelligenceRunner,
    }),
    paths,
    {
      projectRoot: projectConfig.knowledge.guidance.projectRoot,
      sharedRoot: projectConfig.knowledge.guidance.sharedRoot,
      runsRoot: path.join(paths.stateRoot, "runs"),
    },
  );
  const agentReadiness = options.backend.readiness?.() ?? { ready: true };
  const jobs = new RunJobService();
  const docker = options.docker ?? createDockerClient();
  await store.initialize();

  // Conservative orphan pass at startup (report-only; never removes volumes).
  try {
    await reconcileOrphanContainers({ docker, knownRuns: [], apply: false });
  } catch {
    // Orphan inspect failures must not block the dashboard.
  }

  /** Soft Docker status for UI polls — skip alpine port-binding; TTL + in-flight coalesce. */
  const EXECUTION_STATUS_TTL_MS = 30_000;
  let executionStatusCache:
    | {
        at: number;
        status: Awaited<ReturnType<typeof evaluateExecutionRuntimeStatus>>;
      }
    | undefined;
  let executionStatusInflight:
    | Promise<Awaited<ReturnType<typeof evaluateExecutionRuntimeStatus>>>
    | undefined;

  const loadExecutionStatus = async (options?: {
    force?: boolean;
  }): Promise<Awaited<ReturnType<typeof evaluateExecutionRuntimeStatus>>> => {
    const force = options?.force === true;
    const now = Date.now();
    if (
      !force &&
      executionStatusCache &&
      now - executionStatusCache.at < EXECUTION_STATUS_TTL_MS
    ) {
      return executionStatusCache.status;
    }
    if (!force && executionStatusInflight) {
      return executionStatusInflight;
    }

    const probe = evaluateExecutionRuntimeStatus({
      config: projectConfig,
      docker,
      repositoryRoot: paths.controlRoot,
      projectStateRoot: paths.stateRoot,
      collectEvidence: true,
      probeDocker: true,
      // Bootstrap polls must not spawn alpine every ~2s; force=true still runs the bind probe.
      includePortBinding: force,
    }).then((status) => {
      executionStatusCache = { at: Date.now(), status };
      executionStatusInflight = undefined;
      return status;
    });

    if (!force) {
      executionStatusInflight = probe;
    }
    return probe;
  };

  let containerStateEndpoint = "";
  const workerStateCredentials = new WorkerStateCredentialIssuer(
    path.join(paths.stateRoot, "worker-credentials"),
  );
  const workerProviderCredentials = new WorkerProviderCredentialIssuer(
    path.join(paths.stateRoot, "worker-provider-credentials"),
  );
  const hostCursorApiKey = process.env.CURSOR_API_KEY?.trim();
  const cursorProviderProduction =
    options.cursorProviderProduction ??
    (!options.cursorProviderDevelopment && hostCursorApiKey
      ? {
          apiKey: hostCursorApiKey,
          contract: UNPROVEN_CURSOR_PROVIDER_CONTRACT,
        }
      : undefined);
  if (options.cursorProviderDevelopment && cursorProviderProduction) {
    throw new Error("Configure either development or production Cursor provider, not both");
  }
  if (
    cursorProviderProduction &&
    !cursorProviderProduction.contract.productionReady
  ) {
    throw new Error("Production Cursor provider requires a proven SDK contract");
  }
  const cursorProviderOptions = cursorProviderProduction
    ? {
        ...cursorProviderProduction,
        upstreamOrigins: CURSOR_PROVIDER_UPSTREAM_ORIGINS,
      }
    : options.cursorProviderDevelopment;
  let cursorProviderHttpsListener: CursorProviderHttpsListener | undefined;
  const cursorProviderTls = cursorProviderProduction
    ? await ensureCursorProviderTlsMaterial(path.join(paths.stateRoot, "cursor-provider-tls"))
    : undefined;
  const cursorProviderCompatibility: CursorProviderCompatibility | undefined =
    cursorProviderOptions
      ? {
          sdkVersion: cursorProviderOptions.contract.sdkVersion,
          contractVersion: cursorProviderOptions.contract.version,
          proxyVersion: CURSOR_PROVIDER_PROXY_VERSION,
          tlsIdentity:
            cursorProviderTls?.tlsIdentity ??
            options.cursorProviderDevelopment?.tlsIdentity ??
            "development-http",
        }
      : undefined;
  const cursorProviderProxy = cursorProviderOptions
    ? new CursorProviderProxy({
        credentials: workerProviderCredentials,
        upstreamOrigins: cursorProviderOptions.upstreamOrigins,
        upstreamApiKey: cursorProviderOptions.apiKey,
        contract: cursorProviderOptions.contract,
        fetch: cursorProviderOptions.fetch,
        audit: cursorProviderOptions.audit,
      })
    : undefined;
  if (cursorProviderProxy && cursorProviderTls && cursorProviderProduction) {
    cursorProviderHttpsListener = await startCursorProviderHttpsListener({
      proxy: cursorProviderProxy,
      tls: cursorProviderTls,
      port: cursorProviderProduction.port,
    });
  }
  const runStatePort = new FilesystemRunStatePort(store);
  const hostProfile = await bootProfile(
    createHostProfile(
      {
        runState: runStatePort,
        runArtifacts: store,
        containerRuntime: createDockerRuntimeService(docker),
        workspaceSource: {},
        environment: {},
        workerControl: {},
        credentials: workerStateCredentials,
        publisher: {},
        webServer: {},
      },
      undefined,
      {
        store,
        runtimeDependencies: {
          backend: options.backend,
          store,
          docker,
          paths,
          repositoryIntelligenceRunner,
        },
        loadRunConfig: (runId) =>
          loadRunConfig(projectConfig, runId, { runDirectory: store.runDirectory(runId) }),
        startWorker: async ({ config, runId, onProgress }) => {
          onProgress("Advancing workflow through a disposable sandbox");
          const sandboxBackend = new SandboxAgentBackend({
            sandboxProvider: new DockerSandboxProvider(docker),
            image: () => config.execution.docker.workerImageDigest,
            dockerPolicy: () => config.execution.docker,
            rpcUrl: () => containerStateEndpoint,
            issueCapability: (issuedRunId, workerInstanceId) =>
              workerStateCredentials.issue(issuedRunId, { workerInstanceId }),
            revokeCapability: async (revokedRunId) => {
              await Promise.all([
                workerStateCredentials.revoke(revokedRunId),
                workerProviderCredentials.revoke(revokedRunId),
              ]);
            },
            publicReadOnlyMounts: () =>
              cursorProviderTls
                ? [
                    {
                      source: cursorProviderTls.caCertificatePath,
                      target: CURSOR_PROVIDER_CA_CONTAINER_PATH,
                    },
                  ]
                : [],
          });
          const opened = await openWorkerRunRuntime(config, runId, {
            backend: sandboxBackend,
            store,
            docker,
            paths,
          });
          await opened.engine.advance(runId);
        },
        stopWorker: async () => undefined,
        publishRun: ({ config, runId }) =>
          completeDockerHostPublish({
            projectConfig,
            runConfig: config,
            runId,
            store,
          }),
        onProgress: (runId, message) => jobs.setDetail(runId, message),
      },
    ),
  );
  const runLifecycle = hostProfile.ctx.runLifecycle as HostRunLifecycleService;
  const ctx: UiAppContext = {
    getProjectConfig: () => projectConfig,
    setProjectConfig: (config) => {
      projectConfig = config;
      executionStatusCache = undefined;
      executionStatusInflight = undefined;
    },
    store,
    knowledge,
    backend: options.backend,
    configPath: options.configPath,
    agentReadiness,
    jobs,
    runLifecycle,
    repositoryIntelligenceRunner,
    docker,
    getExecutionStatus: loadExecutionStatus,
    workerState: {
      endpoint: () => containerStateEndpoint,
      issueCredential: (runId, issueOptions) =>
        workerStateCredentials.issue(runId, issueOptions),
    },
  };

  const providerBootstrap = (
    runId: string,
    issued: Awaited<ReturnType<WorkerProviderCredentialIssuer["issue"]>>,
  ) => {
    if (!cursorProviderCompatibility) {
      throw new Error("Cursor provider compatibility is unavailable");
    }
    const providerOrigin =
      cursorProviderHttpsListener?.containerOrigin ?? containerStateEndpoint;
    return {
      provider: "cursor" as const,
      endpoint: `${providerOrigin}${PROVIDER_API_PREFIX}/v1/runs/${encodeURIComponent(runId)}/cursor`,
      token: issued.token,
      expiresAt: issued.credential.expiresAt,
      protocolVersion: PROVIDER_API_PROTOCOL_VERSION,
      compatibility: cursorProviderCompatibility,
      ...(cursorProviderTls
        ? {
            tls: {
              caCertificatePath: CURSOR_PROVIDER_CA_CONTAINER_PATH,
              tlsIdentity: cursorProviderTls.tlsIdentity,
            },
          }
        : {}),
    };
  };

  // A sandbox token can only bootstrap or renew a model-provider capability.
  const workerStateApi: WorkerStateApiContext = {
    credentials: workerStateCredentials,
    ...(cursorProviderProxy && cursorProviderCompatibility
      ? {
          issueCursorProviderBootstrap: async (runId: string, workerInstanceId: string) => {
            const issued = await workerProviderCredentials.issue(runId, { workerInstanceId });
            return providerBootstrap(runId, issued);
          },
          renewCursorProviderBootstrap: async (
            runId: string,
            workerInstanceId: string,
            token: string,
          ) => {
            const issued = await workerProviderCredentials.renew({
              runId,
              workerInstanceId,
              token,
            });
            return providerBootstrap(runId, issued);
          },
        }
      : {}),
  };

  const server = http.createServer(async (request, response) => {
    try {
      setSecurityHeaders(response);
      const url = new URL(request.url ?? "/", `http://${host}`);
      if (url.pathname === "/health") {
        return json(response, 200, { ok: true });
      }
      // Worker state API authenticates with its own per-run credential, never
      // the dashboard token; dispatch before the dashboard auth gate.
      if (url.pathname.startsWith(`${RUN_STATE_API_PREFIX}/`)) {
        await handleWorkerStateRoutes(request, response, url, workerStateApi);
        return;
      }
      if (url.pathname.startsWith(`${PROVIDER_API_PREFIX}/`) && cursorProviderProxy) {
        await handleWorkerProviderRoutes(request, response, url, cursorProviderProxy);
        return;
      }
      if (options.dashboard === false) {
        throw new HttpError(404, "Not found");
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

      if (await handleSettingsRoutes(request, response, url, ctx)) return;
      if (await handleExecutionRoutes(request, response, url, ctx)) return;
      if (await handleRunsRoutes(request, response, url, ctx)) return;
      if (await handleKnowledgeRoutes(request, response, url, ctx)) return;
      if (await handleGuidanceRoutes(request, response, url, ctx)) return;

      throw new HttpError(404, "Not found");
    } catch (error) {
      const { status, message } = httpErrorFromUnknown(error);
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
    server.listen(port, listenHost, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Dashboard did not bind a TCP port");
  const origin = `http://${host}:${address.port}`;
  containerStateEndpoint = `http://host.docker.internal:${address.port}`;
  void runLifecycle.recover().catch(() => {
    // Individual runs persist lifecycle failure details. Recovery must not
    // make the control server unavailable for operator remediation.
  });
  const dashboardUrl = `${origin}/?token=${encodeURIComponent(token)}`;
  if (options.openBrowser && options.dashboard !== false) openDashboard(dashboardUrl);

  return {
    origin,
    workerStateEndpoint: containerStateEndpoint,
    ...(cursorProviderProxy ? { workerProviderEndpoint: containerStateEndpoint } : {}),
    url: dashboardUrl,
    token,
    port: address.port,
    runLifecycle,
    issueWorkerStateCredential: (runId, issueOptions) =>
      workerStateCredentials.issue(runId, issueOptions),
    async close() {
      cursorProviderProxy?.close();
      await cursorProviderHttpsListener?.close();
      await Promise.all(
        (await store.listWithFailures()).states.map((state) =>
          workerProviderCredentials.revoke(state.runId),
        ),
      );
      await hostProfile.dispose();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
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
