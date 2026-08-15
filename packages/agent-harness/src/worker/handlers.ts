import type { WorkerHarnessRuntime } from "../application/harness-engine.js";
import type { CancelResult } from "../application/helpers.js";
import type { RunState } from "../domain.js";
import type {
  WorkerCancelResult,
  WorkerHealthResult,
  WorkerRpcAction,
  WorkerStatusResult,
} from "./protocol.js";
import { HARNESS_PACKAGE_VERSION, WORKER_RPC_PROTOCOL_VERSION } from "./protocol.js";

export type WorkerHandlerContext = {
  runId: string;
  engine: WorkerHarnessRuntime;
  startedAtMs: number;
  /** True while an advance (or long mutation) holds the in-process cancellation slot. */
  isAdvancing: () => boolean;
  isCancelRequested: () => Promise<boolean>;
  /** Request graceful process exit after responding (shutdown). */
  requestShutdown: () => void;
};

/**
 * Dispatch an allowlisted worker-control/workflow action onto the in-container
 * WorkerHarnessRuntime. Runtime operations use /workspace and reach durable
 * state only through the independently authenticated host state service.
 */
export async function dispatchWorkerAction(
  ctx: WorkerHandlerContext,
  action: WorkerRpcAction,
  body: Record<string, unknown>,
): Promise<unknown> {
  switch (action) {
    case "health":
      return healthResult(ctx);
    case "status":
      return statusResult(ctx);
    case "advance":
      return summarizeState(await advanceFromNewIfNeeded(ctx));
    case "initial_setup":
      // Alias for hosts/tests that prefer an explicit name; same as advance-from-new.
      return summarizeState(await runWorkerInitialSetup(ctx));
    case "cancel": {
      const result = await ctx.engine.cancel(ctx.runId);
      return cancelResult(result);
    }
    case "retry": {
      const force = body.force === true;
      const maxRunTokens =
        typeof body.maxRunTokens === "number" ? body.maxRunTokens : undefined;
      const maxRunCostUsd =
        typeof body.maxRunCostUsd === "number" ? body.maxRunCostUsd : undefined;
      const resumed = await ctx.engine.retry(ctx.runId, {
        force,
        maxRunTokens,
        maxRunCostUsd,
      });
      if (resumed.phase === "new") {
        return summarizeState(await runWorkerInitialSetup(ctx));
      }
      return summarizeState(await ctx.engine.advance(ctx.runId));
    }
    case "answer": {
      const answers = Array.isArray(body.answers) ? body.answers : undefined;
      if (!answers) throw badRequest("answers is required");
      await ctx.engine.answerMany(
        ctx.runId,
        answers as Array<{ questionId: string; answer: string; optionId?: string }>,
        Array.isArray(body.parked) ? (body.parked as string[]) : undefined,
        Array.isArray(body.clarifications)
          ? (body.clarifications as Array<{ questionId: string; text: string }>)
          : undefined,
      );
      return summarizeState(await ctx.engine.advance(ctx.runId));
    }
    case "note": {
      const text = requiredString(body.text, "text");
      const asUnknown = body.asUnknown === true;
      return summarizeState(await ctx.engine.addNote(ctx.runId, text, asUnknown));
    }
    case "confirm_grill": {
      const feedback = optionalString(body.feedback);
      await ctx.engine.confirmGrill(ctx.runId, { feedback });
      return summarizeState(await ctx.engine.advance(ctx.runId));
    }
    case "confirm_plan": {
      const feedback = optionalString(body.feedback);
      await ctx.engine.confirmPlan(ctx.runId, {
        feedback,
        plan: body.plan as never,
      });
      return summarizeState(await ctx.engine.advance(ctx.runId));
    }
    case "confirm_verification": {
      await ctx.engine.confirmVerification(ctx.runId, {
        keepCurrent: body.keepCurrent === true,
        patch: body.patch as never,
        persistProjectDefaults: body.persistProjectDefaults === true,
      });
      return summarizeState(await ctx.engine.advance(ctx.runId));
    }
    case "retry_verification_baseline": {
      await ctx.engine.retryVerificationBaseline(ctx.runId, {
        verificationCommand: optionalString(body.verificationCommand),
        persistProjectDefaults: body.persistProjectDefaults === true,
      });
      return summarizeState(await ctx.engine.advance(ctx.runId));
    }
    case "resolve_installs": {
      await ctx.engine.resolveInstalls(ctx.runId, {
        accepted: stringArray(body.accepted),
        denied: stringArray(body.denied),
      });
      return summarizeState(await ctx.engine.advance(ctx.runId));
    }
    case "propose_fix": {
      const guidance = requiredString(body.guidance, "guidance");
      return summarizeState(await ctx.engine.proposeFix(ctx.runId, guidance));
    }
    case "apply_fix": {
      await ctx.engine.applyApprovedFix(ctx.runId, {
        persistedProjectDefaults: body.persistProjectDefaults === true,
        reportPaths: stringArray(body.reportPaths),
      });
      return summarizeState(await ctx.engine.advance(ctx.runId));
    }
    case "accept_tree": {
      await ctx.engine.acceptTree(ctx.runId, {
        reportPaths: stringArray(body.reportPaths),
      });
      return summarizeState(await ctx.engine.advance(ctx.runId));
    }
    case "set_rag": {
      if (typeof body.rag !== "boolean") throw badRequest("rag must be a boolean");
      return summarizeState(await ctx.engine.setRag(ctx.runId, body.rag));
    }
    case "set_repository_intelligence": {
      if (typeof body.repositoryIntelligence !== "boolean") {
        throw badRequest("repositoryIntelligence must be a boolean");
      }
      return summarizeState(
        await ctx.engine.setRepositoryIntelligence(ctx.runId, body.repositoryIntelligence),
      );
    }
    case "stop":
      return summarizeState(await ctx.engine.requestStop(ctx.runId));
    case "prepare-export": {
      const { prepareDockerResultExport } = await import(
        "../application/docker-publish-service.js"
      );
      return prepareDockerResultExport({
        config: ctx.engine.config,
        store: ctx.engine.store,
        runId: ctx.runId,
        workspace: ctx.engine.workspace,
        workspacePath: ctx.engine.paths.workspaceRoot,
      });
    }
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

async function statusResult(ctx: WorkerHandlerContext): Promise<WorkerStatusResult> {
  let phase: string | undefined;
  try {
    const state = await ctx.engine.status(ctx.runId);
    phase = state.phase;
  } catch {
    phase = undefined;
  }
  const cancelRequested = await ctx.isCancelRequested().catch(() => false);
  return {
    runId: ctx.runId,
    phase,
    advancing: ctx.isAdvancing(),
    cancelRequested,
    protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
    harnessVersion: HARNESS_PACKAGE_VERSION,
  };
}

function cancelResult(result: CancelResult): WorkerCancelResult {
  return {
    pending: result.pending,
    phase: result.state.phase,
  };
}

async function advanceFromNewIfNeeded(ctx: WorkerHandlerContext): Promise<RunState> {
  const state = await ctx.engine.status(ctx.runId);
  if (state.phase === "new") {
    return runWorkerInitialSetup(ctx);
  }
  return ctx.engine.advance(ctx.runId);
}

async function runWorkerInitialSetup(ctx: WorkerHandlerContext): Promise<RunState> {
  const { runInitialSetupThenAdvance } = await import("../application/run-setup.js");
  await runInitialSetupThenAdvance({
    runId: ctx.runId,
    config: ctx.engine.config,
    store: ctx.engine.store,
    paths: ctx.engine.paths,
    git: ctx.engine.git,
    knowledge: ctx.engine.knowledge,
    advance: () => ctx.engine.advance(ctx.runId),
  });
  return ctx.engine.status(ctx.runId);
}

function summarizeState(state: RunState): { runId: string; phase: string; revision: number } {
  return { runId: state.runId, phase: state.phase, revision: state.revision };
}

function badRequest(message: string): Error {
  const error = new Error(message);
  error.name = "WorkerBadRequest";
  return error;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw badRequest(`${field} is required`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
