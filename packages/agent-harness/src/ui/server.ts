import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { readdir } from "node:fs/promises";
import type { ProjectConfig } from "../schemas/config.js";
import type { AgentPort, GitHubPort } from "../agents/ports.js";
import type { RunEvent, RunState } from "../schemas/reports.js";
import { runLifecycle, type RunLifecycleInput } from "../engine/lifecycle.js";
import { loadRunState } from "../engine/state-machine.js";
import { ensureDir, pathExists, readJson, writeJson } from "../util/fs.js";
import { harnessLog } from "../util/log.js";
import { DASHBOARD_HTML } from "./dashboard.js";

export type UiServerOptions = {
  config: ProjectConfig;
  agent: AgentPort;
  github?: GitHubPort;
  host?: string;
  port?: number;
  openBrowser?: boolean;
  token?: string;
  /** Prefer binding the dashboard to this run on first paint. */
  initialRunId?: string;
  /** Disk poll interval for cross-process runs (CLI execute ↔ UI). */
  pollIntervalMs?: number;
};

type SseClient = {
  res: http.ServerResponse;
  runId?: string;
};

function authOk(req: http.IncomingMessage, token: string): boolean {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const q = url.searchParams.get("token");
  const header = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  return q === token || header === token;
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function buildDashboardUrl(
  host: string,
  port: number,
  token: string,
  runId?: string,
): string {
  const url = new URL(`http://${host}:${port}/`);
  url.searchParams.set("token", token);
  if (runId) url.searchParams.set("runId", runId);
  return url.toString();
}

async function listRunSummaries(
  runRoot: string,
): Promise<Array<{ runId: string; status: string; updatedAt: string }>> {
  if (!(await pathExists(runRoot))) return [];
  const entries = await readdir(runRoot, { withFileTypes: true });
  const runs: Array<{ runId: string; status: string; updatedAt: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const statePath = path.join(runRoot, entry.name, "state.json");
    if (!(await pathExists(statePath))) continue;
    try {
      const state = await loadRunState(path.join(runRoot, entry.name));
      runs.push({
        runId: state.runId,
        status: state.status,
        updatedAt: state.updatedAt,
      });
    } catch {
      // skip corrupt / partial dirs
    }
  }
  runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return runs;
}

async function readOptionalJson(
  directory: string,
  file: string,
): Promise<unknown> {
  const target = path.join(directory, file);
  return (await pathExists(target)) ? readJson(target) : undefined;
}

export async function startUiServer(
  options: UiServerOptions,
): Promise<{
  url: string;
  token: string;
  onEvent: (event: RunEvent, state: RunState) => void;
  urlForRun: (runId: string) => string;
  close: () => Promise<void>;
}> {
  const host = options.host ?? options.config.ui.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("UI server is loopback-only (127.0.0.1 / localhost)");
  }
  const port = options.port ?? options.config.ui.port ?? 8787;
  const token = options.token ?? randomBytes(24).toString("hex");
  const runRoot = path.resolve(
    options.config.repositoryRoot,
    options.config.runDirectory,
  );
  await ensureDir(runRoot);

  const clients = new Set<SseClient>();
  const lastSeenUpdatedAt = new Map<string, string>();
  const lastSeenEventCount = new Map<string, number>();
  /** Lifecycle invocations currently executing inside this process. */
  const inFlight = new Map<string, Promise<unknown>>();
  /** Last background lifecycle failure per run, surfaced on GET detail. */
  const lastErrors = new Map<string, string>();

  const broadcast = (event: RunEvent, state: RunState) => {
    lastSeenUpdatedAt.set(state.runId, state.updatedAt);
    lastSeenEventCount.set(state.runId, state.events.length);
    const payload = `data: ${JSON.stringify({ ...event, runId: state.runId })}\n\n`;
    for (const client of clients) {
      if (client.runId && client.runId !== state.runId) continue;
      client.res.write(payload);
    }
  };

  /**
   * Start or resume a run without holding the HTTP request open: full runs
   * take minutes, so API calls acknowledge immediately and clients follow
   * progress over SSE / polling.
   */
  const launchLifecycle = (
    runId: string,
    input: Omit<RunLifecycleInput, "config" | "deps">,
  ): boolean => {
    if (inFlight.has(runId)) return false;
    lastErrors.delete(runId);
    const promise = runLifecycle({
      ...input,
      runId,
      config: options.config,
      deps: {
        agent: options.agent,
        github: options.github,
        onEvent: broadcast,
      },
    })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        lastErrors.set(runId, message);
        harnessLog("ui.run", `run ${runId} failed: ${message}`);
      })
      .finally(() => {
        inFlight.delete(runId);
      });
    inFlight.set(runId, promise);
    return true;
  };

  const pollDisk = async () => {
    if (clients.size === 0) return;
    const subscribed = new Set(
      [...clients].map((c) => c.runId).filter((id): id is string => Boolean(id)),
    );
    const watchAll = [...clients].some((c) => !c.runId);
    const ids = watchAll
      ? (await listRunSummaries(runRoot)).map((r) => r.runId)
      : [...subscribed];
    for (const runId of ids) {
      const directory = path.join(runRoot, runId);
      if (!(await pathExists(path.join(directory, "state.json")))) continue;
      let state: RunState;
      try {
        state = await loadRunState(directory);
      } catch {
        continue;
      }
      const prevAt = lastSeenUpdatedAt.get(runId);
      const prevCount = lastSeenEventCount.get(runId) ?? 0;
      if (prevAt === state.updatedAt && prevCount === state.events.length) {
        continue;
      }
      const fresh = state.events.slice(prevCount);
      if (fresh.length === 0) {
        broadcast(
          {
            at: state.updatedAt,
            type: "run.created",
            detail: { diskPoll: true, status: state.status },
          },
          state,
        );
      } else {
        for (const event of fresh) broadcast(event, state);
      }
    }
  };

  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const pollTimer = setInterval(() => {
    void pollDisk();
  }, pollIntervalMs);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${host}:${port}`);
      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(DASHBOARD_HTML);
        return;
      }

      if (!authOk(req, token)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      if (url.pathname === "/api/events" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const client: SseClient = {
          res,
          runId: url.searchParams.get("runId") ?? undefined,
        };
        clients.add(client);
        res.write(
          `data: ${JSON.stringify({ at: new Date().toISOString(), type: "run.created", detail: { hello: true } })}\n\n`,
        );
        // Catch up immediately from disk for CLI-started runs.
        void pollDisk();
        req.on("close", () => clients.delete(client));
        return;
      }

      if (url.pathname === "/api/runs" && req.method === "GET") {
        sendJson(res, 200, { runs: await listRunSummaries(runRoot) });
        return;
      }

      if (url.pathname === "/api/runs" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as {
          idea?: string;
          ideaFile?: string;
        };
        if (!body.idea?.trim() && !body.ideaFile) {
          sendJson(res, 400, { error: "idea or ideaFile is required" });
          return;
        }
        const runId = randomUUID();
        launchLifecycle(runId, { idea: body.idea, ideaFile: body.ideaFile });
        sendJson(res, 202, { runId, status: "accepted" });
        return;
      }

      const runMatch = url.pathname.match(
        /^\/api\/runs\/([^/]+)(?:\/(decide|cancel|resume))?$/,
      );
      if (runMatch) {
        const runId = decodeURIComponent(runMatch[1]!);
        const action = runMatch[2];
        const directory = path.join(runRoot, runId);

        if (!action && req.method === "GET") {
          if (!(await pathExists(path.join(directory, "state.json")))) {
            sendJson(res, 404, { error: "run not found" });
            return;
          }
          const state = await loadRunState(directory);
          sendJson(res, 200, {
            state,
            intake: await readOptionalJson(directory, "intake.json"),
            draft: await readOptionalJson(directory, "draft.json"),
            policy: await readOptionalJson(directory, "policy-decision.json"),
            manifest: await readOptionalJson(directory, "manifest.json"),
            report: await readOptionalJson(directory, "report.json"),
            busy: inFlight.has(runId),
            error: lastErrors.get(runId),
          });
          return;
        }

        if (action === "cancel" && req.method === "POST") {
          const result = await runLifecycle({
            runId,
            resume: true,
            cancel: true,
            config: options.config,
            deps: {
              agent: options.agent,
              github: options.github,
              onEvent: broadcast,
            },
          });
          sendJson(res, 200, { runId, status: result.state.status });
          return;
        }

        if (
          (action === "decide" || action === "resume") &&
          req.method === "POST"
        ) {
          if (!(await pathExists(path.join(directory, "state.json")))) {
            sendJson(res, 404, { error: "run not found" });
            return;
          }
          const body = JSON.parse((await readBody(req)) || "{}") as {
            answers?: Array<{ questionId: string; answer: string }>;
            approve?: boolean;
          };
          const started = launchLifecycle(runId, {
            resume: true,
            decisionAnswers: body.answers,
            approveDecision: body.approve !== false,
          });
          if (!started) {
            sendJson(res, 409, { error: "run is already in progress" });
            return;
          }
          sendJson(res, 202, { runId, status: "accepted" });
          return;
        }
      }

      sendJson(res, 404, { error: "not found" });
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, host, () => resolve());
    server.on("error", reject);
  });

  const url = buildDashboardUrl(host, port, token, options.initialRunId);
  harnessLog("ui.listen", `UI on ${url}`);
  await writeJson(path.join(runRoot, "ui-session.json"), {
    host,
    port,
    token,
    url,
    startedAt: new Date().toISOString(),
  });

  if (options.openBrowser) {
    const open =
      process.platform === "win32"
        ? `start "" "${url}"`
        : process.platform === "darwin"
          ? `open "${url}"`
          : `xdg-open "${url}"`;
    const { runShell } = await import("../util/shell.js");
    await runShell(open, { cwd: process.cwd(), timeoutMs: 5_000 });
  }

  return {
    url,
    token,
    onEvent: broadcast,
    urlForRun: (runId: string) => buildDashboardUrl(host, port, token, runId),
    close: async () => {
      clearInterval(pollTimer);
      // Let in-flight lifecycles settle so their state is persisted.
      await Promise.allSettled([...inFlight.values()]);
      for (const client of clients) client.res.end();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
