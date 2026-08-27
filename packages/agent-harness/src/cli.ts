#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { defaultHarnessHome } from "./home.js";
import { createApplication } from "./application.js";
import { readConfig } from "./config.js";
import { checked } from "./process.js";

export function createCli(): Command {
  const program = new Command().name("agent-harness").description("Durable container-only idea-to-pull-request orchestration").option("--home <path>", "harness home", process.env.AGENT_HARNESS_HOME);
  program.command("serve").option("--port <n>", "port", "8787").option("--open", "open the dashboard in the default browser").action(async ({ port, open }: { port: string; open?: boolean }) => {
    const app = await createApplication(homeOf(program)); await app.coordinator.start(); const url = await app.api.listen(Number(port)); process.stdout.write(`${url}\n`);
    if (open) openDashboard(url);
    await signals(); await app.close();
  });
  program.command("reset-home").description("Delete the new development harness database and artifacts").action(async () => { const home = path.resolve(homeOf(program)); assertSafeHome(home); await rm(home, { recursive: true, force: true }); process.stdout.write(`Reset ${home}\n`); });
  program.command("install-runner").description("Explicitly build the neutral runner image").action(async () => { const home = homeOf(program); const config = await readConfig(home); const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); await checked("docker", ["build", "--tag", config.runnerImage, "--file", path.join(root, "docker", "runner", "Dockerfile"), root], { timeoutMs: 20 * 60_000 }); process.stdout.write(`${config.runnerImage}\n`); });
  const project = program.command("project");
  project.command("add").requiredOption("--repository <path>").requiredOption("--name <name>").option("--base-branch <name>", "base branch", "main").action(async (value) => print(await api(program, "/api/projects", { method: "POST", body: { repositoryPath: value.repository, name: value.name, baseBranch: value.baseBranch } })));
  project.command("list").action(async () => print(await api(program, "/api/projects")));
  program.command("start").requiredOption("--project <id>").requiredOption("--idea <text>").option("--workflow <id>", "workflow", "complete").option("--fresh").action(async (value) => print(await api(program, "/api/runs", { method: "POST", body: { projectId: value.project, idea: value.idea, workflowId: value.workflow, fresh: Boolean(value.fresh) } })));
  program.command("status").requiredOption("--run-id <id>").action(async (value) => print(await api(program, `/api/runs/${value.runId}`)));
  program.command("answer").requiredOption("--run-id <id>").requiredOption("--gate-id <id>").requiredOption("--answers <json>").action(async (value) => command(program, value.runId, "submit-answers", { gateId: value.gateId, answers: JSON.parse(value.answers) }));
  for (const [name, kind] of [["retry", "retry-turn"], ["cancel", "cancel-run"], ["publish", "publish-run"]] as const) program.command(name).requiredOption("--run-id <id>").action(async (value) => command(program, value.runId, kind, {}));
  return program;
}

async function command(program: Command, runId: string, kind: string, payload: unknown) { print(await api(program, `/api/runs/${runId}/commands`, { method: "POST", body: { kind, payload } })); }
async function api(program: Command, route: string, options: { method?: string; body?: unknown } = {}) { const config = await readConfig(homeOf(program)); let response: Response; try { response = await fetch(`${config.coordinatorUrl}${route}`, { method: options.method, headers: options.body ? { "content-type": "application/json" } : undefined, body: options.body ? JSON.stringify(options.body) : undefined }); } catch { throw new Error(`Coordinator is not running at ${config.coordinatorUrl}`); } const value = await response.json(); if (!response.ok) throw new Error((value as { error?: string }).error ?? `Coordinator returned ${response.status}`); return value; }
function print(value: unknown) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function homeOf(program: Command): string { return program.opts<{ home?: string }>().home ?? defaultHarnessHome(); }
function assertSafeHome(home: string): void { const root = path.parse(home).root; if (home === root || home.length <= root.length + 2) throw new Error(`Refusing to reset unsafe path: ${home}`); }
function openDashboard(url: string): void {
  const [command, args] = process.platform === "win32" ? ["cmd.exe", ["/d", "/s", "/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.once("error", (error) => process.stderr.write(`Could not open the browser: ${error.message}\nOpen ${url} manually.\n`));
  child.unref();
}
function signals(): Promise<void> { return new Promise((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); }); }
export async function main(argv = process.argv): Promise<void> { await createCli().parseAsync(argv); }
function isCliEntry(): boolean { const entry = process.argv[1]; if (!entry) return false; try { return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url)); } catch { return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url)); } }
if (isCliEntry()) void main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
