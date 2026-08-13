import http from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import type { AgentBackend } from "../infrastructure/agents/types.js";
import { resolveHarnessPaths } from "../application/paths.js";
import type { HarnessConfig } from "../config/schema.js";
import type { GraphifyRunner } from "../graphify.js";
import { LocalKnowledgeBase } from "../knowledge.js";
import { RunStore } from "../store.js";
import { renderDashboard } from "./app.js";
import type { UiAppContext } from "./http/context.js";
import {
  HttpError,
  SESSION_COOKIE,
  authorized,
  html,
  httpErrorFromUnknown,
  json,
  setSecurityHeaders,
} from "./http/request.js";
import { handleGuidanceRoutes } from "./http/routes/guidance.js";
import { handleKnowledgeRoutes } from "./http/routes/knowledge.js";
import { handleRunsRoutes } from "./http/routes/runs.js";
import { handleSettingsRoutes } from "./http/routes/settings.js";
import { RunJobService } from "./run-job-service.js";

export type { UiJob } from "./run-job-service.js";
export { parseAnswerBody } from "./http/request.js";

export type UiServerOptions = {
  config: HarnessConfig;
  backend: AgentBackend;
  configPath?: string;
  port?: number;
  token?: string;
  openBrowser?: boolean;
  graphifyRunner?: GraphifyRunner;
};

export type UiServer = {
  origin: string;
  url: string;
  token: string;
  port: number;
  close(): Promise<void>;
};

export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const host = "127.0.0.1";
  const token = options.token ?? randomBytes(24).toString("hex");
  let projectConfig = options.config;
  const paths = resolveHarnessPaths(projectConfig);
  const store = new RunStore(projectConfig, paths.stateRoot);
  const knowledge = new LocalKnowledgeBase(projectConfig, undefined, paths, {
    projectRoot: projectConfig.knowledge.guidance.projectRoot,
    sharedRoot: projectConfig.knowledge.guidance.sharedRoot,
    runsRoot: path.join(paths.stateRoot, "runs"),
  });
  const agentReadiness = options.backend.readiness?.() ?? { ready: true };
  const jobs = new RunJobService();
  await store.initialize();

  const ctx: UiAppContext = {
    getProjectConfig: () => projectConfig,
    setProjectConfig: (config) => {
      projectConfig = config;
    },
    store,
    knowledge,
    backend: options.backend,
    configPath: options.configPath,
    agentReadiness,
    jobs,
    graphifyRunner: options.graphifyRunner,
  };

  const server = http.createServer(async (request, response) => {
    try {
      setSecurityHeaders(response);
      const url = new URL(request.url ?? "/", `http://${host}`);
      if (url.pathname === "/health") {
        return json(response, 200, { ok: true });
      }
      // Serve the HTML shell without a query token so browser refresh still works
      // after the client strips ?token= from the address bar into sessionStorage.
      // API routes below still require the header/query/cookie token.
      if (!url.pathname.startsWith("/api/")) {
        if (url.pathname !== "/") throw new HttpError(404, "Not found");
        // A refresh loses the token: the client strips ?token= from the address
        // bar, and per-tab sessionStorage is not reliably carried across every
        // reload path. Bind the token to this origin as an HttpOnly session
        // cookie so reloads stay authenticated without putting it back in the URL.
        if (url.searchParams.get("token") === token) {
          response.setHeader(
            "Set-Cookie",
            `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`,
          );
        }
        return html(response, renderDashboard());
      }
      if (!authorized(request, url, token)) {
        return json(response, 401, { error: "Invalid or missing dashboard token" });
      }

      if (await handleSettingsRoutes(request, response, url, ctx)) return;
      if (await handleRunsRoutes(request, response, url, ctx)) return;
      if (await handleKnowledgeRoutes(request, response, url, ctx)) return;
      if (await handleGuidanceRoutes(request, response, url, ctx)) return;

      throw new HttpError(404, "Not found");
    } catch (error) {
      const { status, message } = httpErrorFromUnknown(error);
      json(response, status, { error: message });
    }
  });

  const port = options.port ?? 8787;
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${port} is already in use on ${host}. Stop the other harness UI, or pass --port <number>.`,
          ),
        );
        return;
      }
      reject(error);
    });
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Dashboard did not bind a TCP port");
  const origin = `http://${host}:${address.port}`;
  const dashboardUrl = `${origin}/?token=${encodeURIComponent(token)}`;
  if (options.openBrowser) openDashboard(dashboardUrl);

  return {
    origin,
    url: dashboardUrl,
    token,
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function openDashboard(url: string): void {
  const [command, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}
