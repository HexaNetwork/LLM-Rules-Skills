import path from "node:path";
import { readFile } from "node:fs/promises";
import { createCursorBackend } from "../infrastructure/agents/cursor-backend.js";
import { createFakeBackend } from "../infrastructure/agents/fake-backend.js";
import { HarnessEngine } from "../application/harness-engine.js";
import { normalizeFrozenRunConfig } from "../config/migrations.js";
import type { HarnessConfig } from "../config/schema.js";
import { WORKER_RUN_STATE_PATH, WORKER_WORKSPACE_PATH } from "../application/paths.js";
import { runCancellationRegistry } from "../application/cancellation-registry.js";
import { RunStore } from "../store.js";
import { migrateRunWorkspace } from "../domain/workspace.js";
import { readWorkerRpcToken } from "./auth.js";
import {
  resolveWorkerCursorApiKey,
  CURSOR_API_KEY_SECRET_RELATIVE_PATH,
} from "./cursor-api-key-secret.js";
import { startWorkerRpcServer, type WorkerRpcServer } from "./rpc-server.js";
import {
  WORKER_RPC_CONTAINER_PORT,
  WORKER_RPC_SECRET_CONTAINER_PATH,
  WORKER_RPC_SECRET_RELATIVE_PATH,
} from "./protocol.js";

export type RunWorkerOptions = {
  runId: string;
  /** Bind address inside the container (default 0.0.0.0). */
  host?: string;
  /** Listen port inside the container (default 8787). */
  port?: number;
  /** Absolute path to the RPC secret file. */
  secretFile?: string;
  /** Absolute path to the mounted run-state directory (default /run-state). */
  runStatePath?: string;
  /** When true, use FakeBackend (unit/dev). Production workers use Cursor. */
  fakeBackend?: boolean;
};

export type RunningWorker = {
  runId: string;
  server: WorkerRpcServer;
  engine: HarnessEngine;
  close(): Promise<void>;
};

/**
 * Bootstrap a long-lived per-run worker: load frozen config from /run-state,
 * own HarnessEngine + cancellation registry, serve authenticated RPC.
 */
export async function runWorker(options: RunWorkerOptions): Promise<RunningWorker> {
  const runStatePath = options.runStatePath ?? WORKER_RUN_STATE_PATH;
  const secretFile =
    options.secretFile ??
    path.join(runStatePath, WORKER_RPC_SECRET_RELATIVE_PATH);
  const token = await readWorkerRpcToken(secretFile);
  const config = await loadWorkerConfig(runStatePath);
  const workspace = await loadWorkerWorkspace(runStatePath, config);

  const store = new RunStore(config, runStatePath, { singleRunId: options.runId });
  const cursorApiKey = options.fakeBackend
    ? undefined
    : await resolveWorkerCursorApiKey({
        secretFilePath: path.join(runStatePath, CURSOR_API_KEY_SECRET_RELATIVE_PATH),
        // Container must not rely on CURSOR_API_KEY env; host-dev workers may still use env.
        env: process.env,
      });
  const engine = new HarnessEngine(config, {
    backend: options.fakeBackend
      ? createFakeBackend({})
      : createCursorBackend(cursorApiKey),
    store,
    paths: {
      controlRoot: config.repositoryRoot,
      stateRoot: runStatePath,
      workspaceRoot:
        workspace.kind === "docker-clone" ? WORKER_WORKSPACE_PATH : runStatePath,
      worktreeRoot: runStatePath,
    },
  });
  engine.bindWorkspace(workspace);

  if (
    !options.fakeBackend &&
    (config.execution?.runtime ?? "local") === "docker" &&
    workspace.kind === "docker-clone"
  ) {
    const stampPath = path.join(runStatePath, "sandbox-isolation-probe.json");
    try {
      const stampRaw = await readFile(stampPath, "utf8");
      const stamp = JSON.parse(stampRaw) as {
        ok?: boolean;
        unsupported?: boolean;
        imageDigest?: string;
      };
      const passed =
        stamp.ok === true &&
        stamp.unsupported !== true &&
        (!workspace.imageDigest || stamp.imageDigest === workspace.imageDigest);
      engine.agents.setSandboxIsolationProbePassed(passed);
    } catch {
      engine.agents.setSandboxIsolationProbePassed(false);
    }
  }

  const startedAtMs = Date.now();
  let shuttingDown = false;

  const server = await startWorkerRpcServer({
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

  // Ensure secret path constant stays aligned for operators/docs.
  void WORKER_RPC_SECRET_CONTAINER_PATH;

  return {
    runId: options.runId,
    server,
    engine,
    async close() {
      if (!shuttingDown) await server.close();
    },
  };
}

async function loadWorkerConfig(runStatePath: string): Promise<HarnessConfig> {
  const raw: unknown = JSON.parse(
    await readFile(path.join(runStatePath, "config.json"), "utf8"),
  );
  return normalizeFrozenRunConfig(raw);
}

async function loadWorkerWorkspace(runStatePath: string, config: HarnessConfig) {
  try {
    const raw: unknown = JSON.parse(
      await readFile(path.join(runStatePath, "workspace.json"), "utf8"),
    );
    return migrateRunWorkspace(raw, { controlRoot: config.repositoryRoot });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return migrateRunWorkspace(
        {
          version: 1,
          kind: config.git.enabled ? "docker-clone" : "git-disabled",
          controlRoot: config.repositoryRoot,
          ...(config.git.enabled
            ? {
                containerName: "pending",
                workspaceVolumeName: "pending",
                workspacePath: WORKER_WORKSPACE_PATH,
                imageDigest: "sha256:pending",
                baseSha: "pending",
                seedBundleHash: "pending",
                generation: 0,
              }
            : {}),
          createdAt: new Date().toISOString(),
        },
        { controlRoot: config.repositoryRoot },
      );
    }
    throw error;
  }
}
