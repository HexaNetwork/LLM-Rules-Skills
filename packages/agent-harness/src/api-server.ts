import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Coordinator } from "./coordinator.js";
import type { ContainerRuntime, DockerSetupStatus } from "./container-runtime.js";
import type { GitRuntime } from "./git-runtime.js";
import type { Store } from "./store.js";
import type { JsonObject, UserAnswers } from "./types.js";
import { mergeConfig, readConfig, writeConfig } from "./config.js";
import { summarizeUsage } from "./telemetry.js";
import { GuidanceService } from "./guidance.js";
import { WORKFLOW_ROLES } from "./roles.js";

type RunnerBuildStatus = { status: "idle" | "building" | "succeeded" | "failed"; startedAt?: string; finishedAt?: string; log?: string; error?: string };

export class ApiServer {
  private readonly server = createServer((request, response) => void this.route(request, response));
  private runnerBuild: RunnerBuildStatus = { status: "idle" };
  private readonly guidance: GuidanceService;
  constructor(private readonly store: Store, private readonly coordinator: Coordinator, private readonly home: string, private readonly containers: ContainerRuntime, private readonly git: GitRuntime) {
    this.guidance = new GuidanceService(home);
  }
  async listen(port: number, host = "127.0.0.1"): Promise<string> { await new Promise<void>((resolve, reject) => { this.server.once("error", reject); this.server.listen(port, host, resolve); }); const address = this.server.address(); const actual = typeof address === "object" && address ? address.port : port; return `http://${host}:${actual}`; }
  async close(): Promise<void> { await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve())); }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/api/health") return send(response, 200, { status: "ok" });
      if (request.method === "GET" && url.pathname === "/api/setup") return send(response, 200, await this.setupStatus());
      if (request.method === "POST" && url.pathname === "/api/setup/runner") {
        if (this.runnerBuild.status !== "building") this.startRunnerBuild();
        return send(response, 202, this.runnerBuild);
      }
      if (request.method === "GET" && url.pathname === "/api/projects") return send(response, 200, this.store.listProjects());
      if (request.method === "POST" && url.pathname === "/api/projects") {
        const body = await bodyJson(request); const project = this.store.addProject({ name: String(body.name), repositoryPath: String(body.repositoryPath), baseBranch: String(body.baseBranch ?? "main"), settings: body.settings as JsonObject | undefined }); return send(response, 201, project);
      }
      const projectBranches = url.pathname.match(/^\/api\/projects\/([^/]+)\/branches$/);
      if (request.method === "GET" && projectBranches) {
        const project = this.store.getProject(projectBranches[1]!);
        return send(response, 200, await this.git.listLocalBranches(project.repositoryPath));
      }
      if (request.method === "GET" && url.pathname === "/api/runs") return send(response, 200, this.store.listRuns());
      if (request.method === "GET" && url.pathname === "/api/telemetry") return send(response, 200, summarizeUsage(this.store.turns()));
      if (request.method === "GET" && url.pathname === "/api/settings") {
        const config = await readConfig(this.home);
        return send(response, 200, { config, roles: WORKFLOW_ROLES, guidanceRoles: await this.guidance.listRoles() });
      }
      if (request.method === "PUT" && url.pathname === "/api/settings") {
        const body = await bodyJson(request);
        const config = await writeConfig(this.home, body.config as JsonObject ?? body);
        return send(response, 200, { config });
      }
      if (request.method === "GET" && url.pathname === "/api/guidance/roles") {
        const projectId = url.searchParams.get("projectId") ?? undefined;
        return send(response, 200, { roles: await this.guidance.listRoles(projectId) });
      }
      const guidanceRole = url.pathname.match(/^\/api\/guidance\/roles\/([^/]+)$/);
      if (guidanceRole) {
        const role = decodeURIComponent(guidanceRole[1]!);
        const projectId = url.searchParams.get("projectId") ?? undefined;
        if (request.method === "GET") return send(response, 200, await this.guidance.read(role, projectId));
        if (request.method === "PUT") {
          const body = await bodyJson(request);
          const scopeProjectId = String(body.scope ?? "home") === "project" ? String(body.projectId ?? projectId ?? "") : undefined;
          if (String(body.scope ?? "home") === "project" && !scopeProjectId) return send(response, 400, { error: "projectId is required for project-scoped guidance" });
          return send(response, 200, await this.guidance.writeOverride(role, String(body.body ?? ""), scopeProjectId));
        }
        if (request.method === "DELETE") {
          const projectIdForReset = url.searchParams.get("projectId") ?? undefined;
          return send(response, 200, await this.guidance.resetOverride(role, projectIdForReset));
        }
      }
      if (request.method === "POST" && url.pathname === "/api/runs") {
        const setup = await this.setupStatus();
        if (!setup.ready) return send(response, 409, { error: setup.build.status === "building" ? "Runner image build is still in progress" : "Complete Docker and runner image setup in the WebUI before starting a run", setup });
        const body = await bodyJson(request); const workflowId = String(body.workflowId ?? "complete");
        const projectId = String(body.projectId);
        const project = this.store.getProject(projectId);
        const baseBranch = String(body.baseBranch ?? project.baseBranch).trim();
        if (!baseBranch) return send(response, 400, { error: "baseBranch is required" });
        const projectConfig = await readConfig(this.home, this.store.projectSettings(projectId));
        const effectiveConfig = mergeConfig(projectConfig, (body.config ?? {}) as JsonObject);
        const run = this.store.createRun({ projectId, workflowId, firstStep: "clarify", input: { idea: body.idea, title: body.title, fresh: Boolean(body.fresh), baseBranch }, effectiveConfig: effectiveConfig as unknown as JsonObject });
        this.store.enqueueCommand(run.id, "start-run", {}, `${run.id}/run/start/0`); this.coordinator.notify(); return send(response, 202, run);
      }
      const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (request.method === "GET" && runMatch) {
        const runId = runMatch[1]!; const turns = this.store.turns(runId);
        return send(response, 200, { ...this.store.getRun(runId), gate: this.store.openGate(runId), events: this.store.events(0, runId), turns, usage: summarizeUsage(turns), outputs: this.store.outputs(runId), artifacts: this.store.artifacts(runId), errors: this.store.runErrors(runId) });
      }
      const detailMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/(activity|sessions|usage|artifacts)$/);
      if (request.method === "GET" && detailMatch) {
        const runId = detailMatch[1]!; this.store.getRun(runId);
        if (detailMatch[2] === "activity") return send(response, 200, this.store.events(0, runId));
        if (detailMatch[2] === "sessions") return send(response, 200, this.store.turns(runId));
        if (detailMatch[2] === "artifacts") return send(response, 200, this.store.artifacts(runId));
        return send(response, 200, summarizeUsage(this.store.turns(runId)));
      }
      const commandMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/commands$/);
      if (request.method === "POST" && commandMatch) {
        const runId = commandMatch[1]!; const body = await bodyJson(request); const kind = String(body.kind);
        if (!new Set(["submit-answers", "retry-turn", "cancel-run", "publish-run"]).has(kind)) return send(response, 400, { error: `Unsupported command: ${kind}` });
        const payload = (body.payload ?? {}) as JsonObject;
        if (kind === "submit-answers") validateAnswers(payload as UserAnswers);
        const supplied = request.headers["idempotency-key"];
        const key = typeof supplied === "string" ? supplied : createHash("sha256").update(JSON.stringify({ runId, kind, payload })).digest("hex");
        const command = this.store.enqueueCommand(runId, kind, payload, `${runId}/operator/${key}`, kind === "cancel-run" ? 100 : 0); this.coordinator.notify(); return send(response, 202, command);
      }
      if (request.method === "GET" && url.pathname === "/api/events") return this.streamEvents(response, Number(url.searchParams.get("after") ?? 0), url.searchParams.get("runId") ?? undefined);
      if (request.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/ui/"))) return this.staticFile(url.pathname, response);
      send(response, 404, { error: "Not found" });
    } catch (error) { send(response, 500, { error: error instanceof Error ? error.message : String(error) }); }
  }

  private async setupStatus(): Promise<DockerSetupStatus & { build: RunnerBuildStatus; ready: boolean }> {
    const status = await this.containers.setupStatus();
    return { ...status, build: this.runnerBuild, ready: status.docker.daemon && status.runner.ready && this.runnerBuild.status !== "building" };
  }

  private startRunnerBuild(): void {
    this.runnerBuild = { status: "building", startedAt: new Date().toISOString() };
    this.store.appendEvent(undefined, "setup", "Building runner image from the WebUI");
    void this.containers.installRunner().then((result) => {
      this.runnerBuild = { status: "succeeded", startedAt: this.runnerBuild.startedAt, finishedAt: new Date().toISOString(), log: result.log };
      this.store.appendEvent(undefined, "setup", `Runner image ready: ${result.image}`, { digest: result.digest });
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.runnerBuild = { status: "failed", startedAt: this.runnerBuild.startedAt, finishedAt: new Date().toISOString(), error: message };
      this.store.appendEvent(undefined, "setup", "Runner image build failed", { error: message });
    });
  }

  private streamEvents(response: ServerResponse, after: number, runId?: string): void {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    let cursor = after;
    const flush = () => { for (const event of this.store.events(cursor, runId)) { cursor = event.id; response.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`); } };
    flush(); const timer = setInterval(flush, 1_000); timer.unref(); response.on("close", () => clearInterval(timer));
  }

  private async staticFile(urlPath: string, response: ServerResponse): Promise<void> {
    const name = urlPath === "/" ? "index.html" : path.basename(urlPath);
    if (!new Set(["index.html", "app.js", "style.css"]).has(name)) return send(response, 404, { error: "Not found" });
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../ui");
    const target = path.join(root, name); const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
    await readFile(target); response.writeHead(200, { "content-type": types[path.extname(name)]! }); createReadStream(target).pipe(response);
  }
}

async function bodyJson(request: IncomingMessage): Promise<JsonObject> { const chunks: Buffer[] = []; let size = 0; for await (const chunk of request) { size += chunk.length; if (size > 1_000_000) throw new Error("Request body too large"); chunks.push(Buffer.from(chunk)); } const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required"); return value as JsonObject; }
function validateAnswers(value: UserAnswers): void { if (typeof value.gateId !== "string" || !value.answers || typeof value.answers !== "object") throw new Error("submit-answers requires gateId and answers"); }
function send(response: ServerResponse, status: number, value: unknown): void { response.writeHead(status, { "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify(value)); }
