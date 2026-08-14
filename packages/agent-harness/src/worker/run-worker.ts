import { readFile } from "node:fs/promises";
import { createCursorBackend } from "../infrastructure/agents/cursor-backend.js";
import { createFakeBackend } from "../infrastructure/agents/fake-backend.js";
import type { WorkerHarnessRuntime } from "../application/harness-engine.js";
import type { HarnessConfig } from "../config/schema.js";
import { WORKER_WORKSPACE_PATH } from "../application/paths.js";
import { runCancellationRegistry } from "../application/cancellation-registry.js";
import { RunWorkspaceSchema } from "../domain/workspace.js";
import { readWorkerRpcToken } from "./auth.js";
import {
  resolveWorkerCursorApiKey,
  CURSOR_API_KEY_SECRET_CONTAINER_PATH,
} from "./cursor-api-key-secret.js";
import { startWorkerRpcServer, type WorkerRpcServer } from "./rpc-server.js";
import {
  WORKER_RPC_CONTAINER_PORT,
  WORKER_RPC_SECRET_CONTAINER_PATH,
  WORKER_STATE_CREDENTIAL_CONTAINER_PATH,
} from "./protocol.js";
import { RpcRunStatePort } from "../infrastructure/state/rpc-run-state-port.js";
import { RpcRunRepository } from "../infrastructure/state/rpc-run-repository.js";
import { randomUUID } from "node:crypto";
import { bootProfile, type BootedProfile } from "../vnext/boot/boot-profile.js";
import { createWorkerProfile } from "../vnext/profiles/index.js";
import type { WorkerRuntimeControl } from "../vnext/plugins/worker-runtime.js";
import { createDeterministicWorkflowBackend } from "../vnext/plugins/deterministic-provider.js";

export type RunWorkerOptions = {
  runId: string;
  /** Bind address inside the container (default 0.0.0.0). */
  host?: string;
  /** Listen port inside the container (default 8787). */
  port?: number;
  /** Absolute path to the RPC secret file. */
  secretFile?: string;
  /** Host state-service origin reachable from the container. */
  stateEndpoint: string;
  /** Stable identity for lease fencing and credential scoping. */
  workerInstanceId: string;
  /** Read-only scoped state credential file. */
  stateCredentialFile?: string;
  /** Read-only Cursor API key secret file. */
  cursorSecretFile?: string;
  /** When true, use FakeBackend (unit/dev). Production workers use Cursor. */
  fakeBackend?: boolean;
  /** Blocking Docker acceptance profile: deterministic provider with real workspace edits. */
  deterministicTestProfile?: boolean;
};

export type RunningWorker = {
  runId: string;
  server: WorkerRpcServer;
  engine: WorkerHarnessRuntime;
  profile: BootedProfile;
  close(): Promise<void>;
};

/**
 * Bootstrap a long-lived per-run worker from the authenticated host state API.
 */
export async function runWorker(options: RunWorkerOptions): Promise<RunningWorker> {
  const secretFile = options.secretFile ?? WORKER_RPC_SECRET_CONTAINER_PATH;
  const token = await readWorkerRpcToken(secretFile);
  const stateCredential = (
    await readFile(options.stateCredentialFile ?? WORKER_STATE_CREDENTIAL_CONTAINER_PATH, "utf8")
  ).trim();
  const statePort = new RpcRunStatePort({ endpoint: options.stateEndpoint, credential: stateCredential });
  const bootstrap = await statePort.bootstrap<WorkerBootstrap>(options.runId);
  if (bootstrap.runId !== options.runId || bootstrap.workerInstanceId !== options.workerInstanceId) {
    throw new Error("Worker bootstrap identity does not match the requested run and worker instance");
  }
  const config = workerConfig(bootstrap.config);
  const workspace = workerWorkspace(bootstrap.workspace, config);
  if (workspace.kind !== "docker-clone") {
    throw new Error(`Worker requires a docker-clone workspace; received ${workspace.kind}`);
  }
  const lease = await statePort.acquireLease(options.runId, {
    workerInstanceId: options.workerInstanceId,
    ttlMs: 60_000,
    requestId: randomUUID(),
  });

  const store = new RpcRunRepository({
    runId: options.runId,
    workerInstanceId: options.workerInstanceId,
    fencingToken: lease.fencingToken,
    config,
    port: statePort,
  });
  const cursorApiKey = options.fakeBackend || options.deterministicTestProfile
    ? undefined
    : await resolveWorkerCursorApiKey({
        secretFilePath: options.cursorSecretFile ?? CURSOR_API_KEY_SECRET_CONTAINER_PATH,
        // Container must not rely on CURSOR_API_KEY env; host-dev workers may still use env.
        env: process.env,
      });
  const backend = options.deterministicTestProfile
    ? createDeterministicWorkflowBackend()
    : options.fakeBackend
      ? createFakeBackend({})
      : createCursorBackend(cursorApiKey);
  const workerPaths = {
    controlRoot: config.repositoryRoot,
    stateRoot: "/tmp/agent-harness-state",
    workspaceRoot: WORKER_WORKSPACE_PATH,
    worktreeRoot: WORKER_WORKSPACE_PATH,
  };
  const profile = await bootProfile(
    createWorkerProfile({
      runState: statePort,
      runArtifacts: {
        read: (runId: string, kind: string, id?: string) =>
          statePort.readArtifact(runId, artifactRef(kind, id)),
        write: (runId: string, kind: string, contents: string, id?: string) => {
          const requestId = randomUUID();
          return statePort.writeArtifact(runId, artifactRef(kind, id), contents, {
            requestId,
            idempotencyKey: requestId,
            workerInstanceId: options.workerInstanceId,
            fencingToken: lease.fencingToken,
          });
        },
      },
      credentials: {
        issue: async () => {
          throw new Error("Worker profile cannot issue host credentials");
        },
        revoke: async () => undefined,
      },
    }, {
      config,
      backend,
      store,
      runStatePort: statePort,
      workspace,
      paths: workerPaths,
    }),
  );
  const engine = (profile.ctx.workerControl as WorkerRuntimeControl).engine;
  if (!options.fakeBackend && !options.deterministicTestProfile) {
    engine.agents.setSandboxIsolationProbePassed(bootstrap.sandboxIsolationPassed === true);
  }
  profile.ctx.workflow.validate([
    "new",
    "reflecting",
    "awaiting_input",
    "grilling",
    "planning",
    "executing",
    "scenario_testing",
    "crystallizing",
    "final_review",
    "publishing",
    "blocked",
  ]);

  const heartbeat = setInterval(() => {
    void statePort.renewLease(options.runId, {
      workerInstanceId: options.workerInstanceId,
      fencingToken: lease.fencingToken,
      ttlMs: 60_000,
      requestId: randomUUID(),
    });
  }, 20_000);
  heartbeat.unref();

  const startedAtMs = Date.now();
  let shuttingDown = false;

  let server: WorkerRpcServer;
  try {
    server = await startWorkerRpcServer({
      host: options.host ?? "0.0.0.0",
      port: options.port ?? WORKER_RPC_CONTAINER_PORT,
      token,
      handlers: {
        runId: options.runId,
        engine,
        startedAtMs,
        isAdvancing: () => runCancellationRegistry.has(options.runId),
        isCancelRequested: () => engine.isCancelRequested(options.runId),
        requestShutdown: () => {
          shuttingDown = true;
          setTimeout(() => {
            void server.close().finally(() => {
              process.exit(0);
            });
          }, 50);
        },
      },
    });
  } catch (error) {
    clearInterval(heartbeat);
    await profile.dispose().catch(() => undefined);
    await statePort.releaseLease(options.runId, {
      workerInstanceId: options.workerInstanceId,
      fencingToken: lease.fencingToken,
      requestId: randomUUID(),
    }).catch(() => undefined);
    throw error;
  }

  // Ensure secret path constant stays aligned for operators/docs.
  void WORKER_RPC_SECRET_CONTAINER_PATH;

  return {
    runId: options.runId,
    server,
    engine,
    profile,
    async close() {
      clearInterval(heartbeat);
      await profile.dispose();
      await statePort.releaseLease(options.runId, {
        workerInstanceId: options.workerInstanceId,
        fencingToken: lease.fencingToken,
        requestId: randomUUID(),
      }).catch(() => undefined);
      if (!shuttingDown) await server.close();
    },
  };
}

function artifactRef(kind: string, id?: string) {
  switch (kind) {
    case "activity":
    case "config":
    case "install-log":
    case "transport-import":
    case "sandbox-probe":
      return { kind } as const;
    case "document":
      return { kind, name: id ?? "idea" } as never;
    case "packet":
    case "packet-guidance":
    case "packet-retrieval":
    case "session":
    case "session-steps":
    case "issue":
      if (!id) throw new Error(`Artifact kind "${kind}" requires an id`);
      return { kind, id } as never;
    default:
      throw new Error(`Unsupported worker artifact kind "${kind}"`);
  }
}

type WorkerBootstrap = {
  runId: string;
  workerInstanceId?: string;
  config: HarnessConfig;
  workspace: Record<string, unknown>;
  sandboxIsolationPassed?: boolean;
};

function workerConfig(config: HarnessConfig): HarnessConfig {
  return {
    ...config,
    repositoryRoot: WORKER_WORKSPACE_PATH,
    stateDirectory: "/tmp/agent-harness-state",
  };
}

function workerWorkspace(workspace: Record<string, unknown>, config: HarnessConfig) {
  void config;
  return RunWorkspaceSchema.parse({
    ...workspace,
    controlRoot: WORKER_WORKSPACE_PATH,
    workspacePath: WORKER_WORKSPACE_PATH,
  });
}
