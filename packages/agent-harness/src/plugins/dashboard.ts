import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { ProfileRow } from "../boot.js";
import { outputContractFor, roleRulesFor } from "../domain/agent-roles.js";
import { containerName } from "../domain/mount-policy.js";
import { renderDashboardPage } from "../ui/page.js";

const SECRET_ENV_PATTERN = /KEY|TOKEN|SECRET/i;

export function redactEnv(env: string[]): string[] {
  return env.map((entry) => {
    const separator = entry.indexOf("=");
    const name = separator === -1 ? entry : entry.slice(0, separator);
    return SECRET_ENV_PATTERN.test(name) ? `${name}=<redacted>` : entry;
  });
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export type DashboardService = {
  start(): Promise<string>;
  stop(): Promise<void>;
  readonly token: string;
};

export type DashboardConfig = {
  port?: number;
  host?: string;
};

export function createDashboardService(ctx: Context, config: DashboardConfig = {}): DashboardService {
  const token = randomBytes(24).toString("hex");
  const host = config.host ?? "127.0.0.1";
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error(`Dashboard host must be loopback, received "${host}"`);
  }
  const port = config.port ?? 8787;
  const urlHost = host === "::1" ? "[::1]" : host;
  let server: ReturnType<typeof createServer> | undefined;
  const deletingRuns = new Set<string>();

  const deleteInBackground = (runId: string): void => {
    if (deletingRuns.has(runId)) return;
    deletingRuns.add(runId);
    void ctx.runLifecycle.delete(runId).catch(() => undefined).finally(() => {
      deletingRuns.delete(runId);
    });
  };

  const service: DashboardService = {
    token,
    async start() {
      if (server) return `http://${urlHost}:${port}/?token=${token}`;
      server = createServer((req, res) => {
        void handle(ctx, token, deletingRuns, deleteInBackground, req, res);
      });
      await new Promise<void>((resolve, reject) => {
        server!.listen(port, host, () => resolve());
        server!.on("error", reject);
      });
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : port;
      return `http://${urlHost}:${bound}/?token=${token}`;
    },
    async stop() {
      if (!server) return;
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => (error ? reject(error) : resolve()));
      });
      server = undefined;
    },
  };
  return service;
}

async function handle(
  ctx: Context,
  token: string,
  deletingRuns: ReadonlySet<string>,
  deleteInBackground: (runId: string) => void,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderDashboardPage());
    return;
  }
  const auth = req.headers.authorization ?? "";
  const queryToken = url.searchParams.get("token") ?? "";
  if (auth !== `Bearer ${token}` && queryToken !== token) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  try {
    const body = req.method === "POST" || req.method === "PUT" ? await readBody(req) : undefined;
    const payload = await route(ctx, deletingRuns, deleteInBackground, req.method ?? "GET", url, body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.statusCode : 400;
    res.writeHead(statusCode, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}

async function route(
  ctx: Context,
  deletingRuns: ReadonlySet<string>,
  deleteInBackground: (runId: string) => void,
  method: string,
  url: URL,
  body?: unknown,
): Promise<unknown> {
  if (method === "GET" && url.pathname === "/api/projects") {
    return ctx.runLifecycle.listProjects();
  }
  if (method === "POST" && url.pathname === "/api/projects") {
    const input = (body ?? {}) as { controlRoot?: string };
    const controlRoot = String(input.controlRoot ?? "").trim();
    if (!controlRoot) throw new Error("Project path is required");
    return ctx.runLifecycle.addProject(controlRoot);
  }
  const projectBranches = url.pathname.match(/^\/api\/projects\/([^/]+)\/branches$/);
  if (method === "GET" && projectBranches) {
    const projectKey = decodeURIComponent(projectBranches[1]!);
    const projects = await ctx.runLifecycle.listProjects();
    const project = projects.find((row) => row.projectKey === projectKey);
    if (!project) throw new Error(`Unknown project: ${projectKey}`);
    return ctx.git.listLocalBranches(project.controlRoot);
  }
  if (method === "GET" && url.pathname === "/api/runs") {
    const runs = await ctx.runLifecycle.list();
    return runs.filter((run) => !deletingRuns.has(run.identity.runId));
  }
  if (method === "GET" && url.pathname === "/api/guidance/roles") {
    const projectKey = url.searchParams.get("projectKey")?.trim() || undefined;
    const roles = await ctx.roleGuidance.listRoles(projectKey);
    return { roles };
  }
  const guidanceRole = url.pathname.match(/^\/api\/guidance\/roles\/([^/]+)$/);
  if (method === "GET" && guidanceRole) {
    const role = decodeURIComponent(guidanceRole[1]!);
    const projectKey = url.searchParams.get("projectKey")?.trim() || undefined;
    const settings = await ctx.settings.readLive(projectKey);
    const compiled = await ctx.roleGuidance.compileRoleContext(role, {
      projectKey,
      maxCharacters: settings.budgets.guidanceTokens * 4,
    });
    const document = await ctx.roleGuidance.read(role, projectKey);
    return {
      ...document,
      roleRules: [...roleRulesFor(role)],
      contract: outputContractFor(role),
      promptPreview: compiled.text,
      truncated: compiled.truncated,
    };
  }
  if (method === "PUT" && guidanceRole) {
    const role = decodeURIComponent(guidanceRole[1]!);
    const input = (body ?? {}) as { body?: string; projectKey?: string };
    const projectKey = String(input.projectKey ?? "").trim() || undefined;
    return ctx.roleGuidance.writeOverride(role, String(input.body ?? ""), projectKey);
  }
  if (method === "DELETE" && guidanceRole) {
    const role = decodeURIComponent(guidanceRole[1]!);
    const projectKey = url.searchParams.get("projectKey")?.trim() || undefined;
    return ctx.roleGuidance.resetOverride(role, projectKey);
  }
  const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)(?:\/([^/]+))?$/);
  const matchedRunId = runMatch ? decodeURIComponent(runMatch[1]!) : undefined;
  if (method === "GET" && matchedRunId && deletingRuns.has(matchedRunId)) {
    throw new HttpError(404, `Unknown run: ${matchedRunId}`);
  }
  if (method === "GET" && runMatch && !runMatch[2]) {
    return ctx.runLifecycle.status(matchedRunId!);
  }
  if (method === "GET" && runMatch?.[2] === "activity") {
    return ctx.runLifecycle.activity(decodeURIComponent(runMatch[1]!));
  }
  if (method === "GET" && runMatch?.[2] === "sessions") {
    return ctx.runLifecycle.sessions(decodeURIComponent(runMatch[1]!));
  }
  if (method === "GET" && runMatch?.[2] === "usage") {
    return ctx.runLifecycle.usage(decodeURIComponent(runMatch[1]!));
  }
  if (method === "GET" && runMatch?.[2] === "sandbox") {
    const runId = decodeURIComponent(runMatch[1]!);
    const identity = await ctx.store.readIdentity(runId);
    if (!identity) throw new HttpError(404, `Unknown run: ${runId}`);
    const mode = ctx.sandbox.mode;
    const name = containerName(runId);
    if (mode !== "docker") return { mode, containerName: name };
    try {
      const info = await ctx.sandbox.inspect(runId);
      return {
        mode,
        containerName: name,
        running: info.status === "running",
        status: info.status,
        image: info.image,
        mounts: info.mounts,
        env: redactEnv(info.env),
      };
    } catch {
      return { mode, containerName: name, running: false };
    }
  }
  if (method === "POST" && url.pathname === "/api/runs") {
    const input = (body ?? {}) as {
      idea?: string;
      workflowBundleId?: string;
      repository?: string;
      projectKey?: string;
      baseBranch?: string;
    };
    const baseBranch = String(input.baseBranch ?? "").trim();
    if (!baseBranch) throw new Error("baseBranch is required");
    return ctx.runLifecycle.start({
      idea: String(input.idea ?? ""),
      workflowBundleId: input.workflowBundleId,
      repository: input.repository,
      projectKey: input.projectKey,
      baseBranch,
    });
  }
  if (method === "POST" && runMatch?.[2] === "continue") {
    return ctx.runLifecycle.continue(decodeURIComponent(runMatch[1]!));
  }
  if (method === "POST" && runMatch?.[2] === "retry") {
    return ctx.runLifecycle.retry(decodeURIComponent(runMatch[1]!));
  }
  if (method === "POST" && runMatch?.[2] === "cancel") {
    return ctx.runLifecycle.cancel(decodeURIComponent(runMatch[1]!));
  }
  if (method === "POST" && runMatch?.[2] === "delete") {
    const runId = matchedRunId!;
    if (!deletingRuns.has(runId)) {
      const identity = await ctx.store.readIdentity(runId);
      if (!identity && !(await ctx.store.listRunIds()).includes(runId)) {
        throw new HttpError(404, `Unknown run: ${runId}`);
      }
      deleteInBackground(runId);
    }
    return { deleted: runId };
  }
  if (method === "POST" && runMatch?.[2] === "answer") {
    const batch = (body ?? {}) as {
      answers?: Record<string, string>;
      parked?: string[];
      notes?: string;
      clarifications?: Array<{ questionId: string; text: string }>;
    };
    return ctx.runLifecycle.answer(decodeURIComponent(runMatch[1]!), {
      answers: batch.answers ?? {},
      parked: batch.parked,
      notes: batch.notes,
      clarifications: batch.clarifications,
    });
  }
  throw new Error(`Unknown route ${method} ${url.pathname}`);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

export function dashboardPlugin(ctx: Context, config: DashboardConfig = {}): void {
  ctx.provide("dashboard", createDashboardService(ctx, config));
}

Object.assign(dashboardPlugin, {
  inject: ["runLifecycle", "git", "roleGuidance", "settings", "store", "sandbox"],
});

export function dashboardRow(config: DashboardConfig = {}): ProfileRow {
  return {
    id: "host.dashboard",
    plugin: dashboardPlugin,
    config,
    trusted: true,
  };
}
