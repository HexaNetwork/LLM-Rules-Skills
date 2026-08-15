import { startWorkerRpcServer, type WorkerRpcServer } from "./rpc-server.js";
import { WORKER_RPC_CONTAINER_PORT } from "./protocol.js";
import { HARNESS_RPC_URL_ENV, HARNESS_WORKER_TOKEN_ENV } from "../sandbox/types.js";

export type RunWorkerOptions = {
  runId: string;
  /** Bind address inside the container (default 0.0.0.0). */
  host?: string;
  /** Listen port inside the container (default 8787). */
  port?: number;
  /** Host broker origin reachable from the container. */
  stateEndpoint?: string;
  /** Stable identity for capability scoping. */
  workerInstanceId: string;
};

export type RunningWorker = {
  runId: string;
  server: WorkerRpcServer;
  close(): Promise<void>;
};

/**
 * Start the worker liveness server. Workflow, commits, and durable state stay
 * on the host. Credentials arrive only as HARNESS_WORKER_TOKEN / HARNESS_RPC_URL.
 */
export async function runWorker(options: RunWorkerOptions): Promise<RunningWorker> {
  const token = process.env[HARNESS_WORKER_TOKEN_ENV]?.trim();
  if (!token) {
    throw new Error(
      `Worker requires ${HARNESS_WORKER_TOKEN_ENV}; secret files are not a delivery mechanism`,
    );
  }
  const stateEndpoint = process.env[HARNESS_RPC_URL_ENV]?.trim() || options.stateEndpoint;
  if (!stateEndpoint) {
    throw new Error(`Worker requires ${HARNESS_RPC_URL_ENV} or --state-endpoint`);
  }
  if (process.env.CURSOR_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY) {
    throw new Error("Docker worker refuses ambient provider keys; host proxy custody is required");
  }
  void stateEndpoint;
  void options.workerInstanceId;

  const startedAtMs = Date.now();
  let shuttingDown = false;
  let server: WorkerRpcServer;
  server = await startWorkerRpcServer({
    host: options.host ?? "0.0.0.0",
    port: options.port ?? WORKER_RPC_CONTAINER_PORT,
    token,
    handlers: {
      runId: options.runId,
      startedAtMs,
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

  return {
    runId: options.runId,
    server,
    async close() {
      if (!shuttingDown) await server.close();
    },
  };
}
