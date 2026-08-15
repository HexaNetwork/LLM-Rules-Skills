import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveHarnessPaths } from "../../../application/paths.js";
import { evaluateExecutionRuntimeStatus } from "../../../application/execution-runtime-status.js";
import { reconcileOrphanContainers } from "../../../application/orphan-reconciler.js";
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
            probeDocker: true,
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
    const report = await reconcileOrphanContainers({
      docker: ctx.docker,
      knownRuns: [],
      apply,
    });
    json(response, 200, { reconcile: report });
    return true;
  }

  return false;
}

