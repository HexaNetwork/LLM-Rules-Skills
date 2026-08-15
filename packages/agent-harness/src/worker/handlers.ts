import type {
  WorkerHealthResult,
  WorkerRpcAction,
  WorkerStatusResult,
} from "./protocol.js";
import { HARNESS_PACKAGE_VERSION, WORKER_RPC_PROTOCOL_VERSION } from "./protocol.js";

export type WorkerHandlerContext = {
  runId: string;
  startedAtMs: number;
  /** Request graceful process exit after responding (shutdown). */
  requestShutdown: () => void;
};

/**
 * Dispatch allowlisted liveness actions. Workflow stays on the host.
 */
export async function dispatchWorkerAction(
  ctx: WorkerHandlerContext,
  action: WorkerRpcAction,
  _body: Record<string, unknown>,
): Promise<unknown> {
  switch (action) {
    case "health":
      return healthResult(ctx);
    case "status":
      return statusResult(ctx);
    case "shutdown":
      ctx.requestShutdown();
      return { shuttingDown: true };
    default: {
      const _exhaustive: never = action;
      throw badRequest(`Unsupported action: ${String(_exhaustive)}`);
    }
  }
}

function healthResult(ctx: WorkerHandlerContext): WorkerHealthResult {
  return {
    status: "ok",
    runId: ctx.runId,
    protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
    harnessVersion: HARNESS_PACKAGE_VERSION,
    uptimeMs: Date.now() - ctx.startedAtMs,
  };
}

function statusResult(ctx: WorkerHandlerContext): WorkerStatusResult {
  return {
    runId: ctx.runId,
    advancing: false,
    cancelRequested: false,
    protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
    harnessVersion: HARNESS_PACKAGE_VERSION,
  };
}

function badRequest(message: string): Error {
  const error = new Error(message);
  error.name = "WorkerBadRequest";
  return error;
}
