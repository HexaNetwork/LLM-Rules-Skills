import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { UiAppContext } from "../context.js";
import {
  HttpError,
  json,
  optionalInteger,
  readJsonBody,
  requiredString,
} from "../request.js";

function assertInside(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new HttpError(400, "Path escapes the repository");
  }
}

/** @returns true when the request was handled. */
export async function handleKnowledgeRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  ctx: UiAppContext,
): Promise<boolean> {
  const projectConfig = ctx.getProjectConfig();

  if (request.method === "POST" && url.pathname === "/api/knowledge/search") {
    const body = await readJsonBody(request);
    const query = requiredString(body.query, "query", 10_000);
    const limit = optionalInteger(body.limit, "limit", 1, 20) ?? 8;
    json(response, 200, { results: await ctx.knowledge.search(query, limit) });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/knowledge/status") {
    const embeddings = projectConfig.knowledge.embeddings;
    json(response, 200, {
      lexical: true,
      semantic: {
        enabled: embeddings.enabled,
        provider: embeddings.provider,
        model: embeddings.model,
        endpoint: embeddings.endpoint,
      },
      codegraph: { enabled: projectConfig.knowledge.codegraph.enabled },
      sources: projectConfig.knowledge.sources.map((source) => source.path),
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/knowledge/refresh") {
    const changed = await ctx.store.withSharedIndexLock(
      { runId: "dashboard", action: "refresh-knowledge" },
      () => ctx.knowledge.refresh(),
    );
    json(response, 200, { changed });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/knowledge/add") {
    const body = await readJsonBody(request);
    const relativePath = requiredString(body.path, "path", 2_000);
    const target = path.resolve(projectConfig.repositoryRoot, relativePath);
    assertInside(projectConfig.repositoryRoot, target);
    const changed = await ctx.store.withSharedIndexLock(
      { runId: "dashboard", action: "upsert-knowledge" },
      () => ctx.knowledge.upsertFile(target),
    );
    json(response, 200, { changed });
    return true;
  }

  return false;
}
