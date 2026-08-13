import type { HarnessConfig } from "../config/schema.js";
import type { DockerClient } from "../infrastructure/container/types.js";
import type { WorkerRpcClient } from "../infrastructure/worker-rpc/client.js";
import {
  isWorkerRpcAction,
  type WorkerRpcAction,
} from "../worker/protocol.js";
import {
  ensureDockerWorkerSession,
  isDockerExecutionRuntime,
  workerRpcActionForHostAction,
} from "./docker-worker-session.js";

export type DockerMutationProxy = {
  client: WorkerRpcClient;
  invoke(action: WorkerRpcAction, body?: Record<string, unknown>): Promise<unknown>;
};

/**
 * Resolve an authenticated worker RPC client for a Docker-mode run.
 * Local runtime returns undefined so callers keep using the in-process engine.
 */
export async function resolveDockerMutationProxy(input: {
  projectConfig: HarnessConfig;
  runConfig: HarnessConfig;
  runId: string;
  docker?: DockerClient;
}): Promise<DockerMutationProxy | undefined> {
  if (!isDockerExecutionRuntime(input.runConfig)) return undefined;
  if (!input.docker) {
    throw new Error(
      "Docker execution runtime requires a DockerClient on the host control plane",
    );
  }
  const session = await ensureDockerWorkerSession({
    projectConfig: input.projectConfig,
    runId: input.runId,
    docker: input.docker,
    startIfMissing: false,
  });
  return {
    client: session.client,
    invoke: (action, body) => session.client.invoke(action, body),
  };
}

/** Map host UI action → worker RPC action, or undefined when host-local. */
export function mapHostActionToWorkerRpc(action: string): WorkerRpcAction | undefined {
  const mapped = workerRpcActionForHostAction(action);
  if (!mapped || !isWorkerRpcAction(mapped)) return undefined;
  return mapped;
}
