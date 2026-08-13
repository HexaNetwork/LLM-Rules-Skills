import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveHarnessPaths } from "../../../application/paths.js";
import { evaluateExecutionRuntimeStatus } from "../../../application/execution-runtime-status.js";
import {
  reconcileOrphanContainers,
  type OrphanReconcileKnownRun,
} from "../../../application/orphan-reconciler.js";
import { loadRunWorkspace } from "../../../config/io.js";
import type { UiAppContext } from "../context.js";
import { HttpError, json, optionalBoolean, readJsonBody } from "../request.js";

/** @returns true when the request was handled. */
export async function handleExecutionRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  ctx: UiAppContext,
): Promise<boolean> {
  if (request.method === "GET" && url.pathname === "/api/execution/status") {
    const projectConfig = ctx.getProjectConfig();
    const paths = resolveHarnessPaths(projectConfig);
    const status =
      ctx.getExecutionStatus !== undefined
        ? await ctx.getExecutionStatus()
        : await evaluateExecutionRuntimeStatus({
            config: projectConfig,
            docker: ctx.docker,
            repositoryRoot: paths.controlRoot,
            projectStateRoot: paths.stateRoot,
            collectEvidence: true,
            probeDocker: (projectConfig.execution?.runtime ?? "local") === "docker",
            includePortBinding: false,
          });
    json(response, 200, { execution: status });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/execution/reconcile-orphans") {
    if (!ctx.docker) {
      throw new HttpError(503, "Docker client is not available on this dashboard");
    }
    const body = await readJsonBody(request).catch(() => ({} as Record<string, unknown>));
    const apply = optionalBoolean((body as { apply?: unknown }).apply, "apply") ?? false;
    const knownRuns = await collectKnownDockerRuns(ctx);
    const report = await reconcileOrphanContainers({
      docker: ctx.docker,
      knownRuns,
      apply,
    });
    json(response, 200, { reconcile: report });
    return true;
  }

  return false;
}

async function collectKnownDockerRuns(ctx: UiAppContext): Promise<OrphanReconcileKnownRun[]> {
  const { states } = await ctx.store.listWithFailures();
  const known: OrphanReconcileKnownRun[] = [];
  for (const state of states) {
    try {
      const workspace = await loadRunWorkspace(ctx.getProjectConfig(), state.runId);
      if (workspace.kind !== "docker-clone") continue;
      known.push({
        runId: state.runId,
        phase: state.phase,
        removedAt: workspace.removedAt,
        workspaceVolumeName: workspace.workspaceVolumeName,
        containerName: workspace.containerName,
      });
    } catch {
      // skip unreadable workspace
    }
  }
  return known;
}
