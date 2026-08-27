import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../../src/store.js";
import { ApiServer } from "../../src/api-server.js";
import { GitRuntime } from "../../src/git-runtime.js";
import { checked } from "../../src/process.js";

const homes: string[] = [];
afterEach(async () => Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))));
function containerRuntime(ready = true) {
  return {
    setupStatus: async () => ({ docker: { cli: true, daemon: ready, version: "Docker test" }, runner: { image: "runner:test", ready, digest: ready ? "sha256:test" : undefined } }),
    installRunner: async () => ({ image: "runner:test", digest: "sha256:test", log: "built in test" }),
  } as never;
}
function apiServer(store: Store, home: string, ready = true) {
  const git = new GitRuntime(path.join(home, "worktrees"));
  return new ApiServer(store, { notify() {} } as never, home, containerRuntime(ready), git);
}
async function initRepo(repo: string, branches: string[] = ["main"]) {
  await mkdir(repo, { recursive: true });
  await checked("git", ["init", "--initial-branch", branches[0]!], { cwd: repo });
  await checked("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  await checked("git", ["config", "user.name", "Test"], { cwd: repo });
  await checked("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repo });
  for (const branch of branches.slice(1)) {
    await checked("git", ["branch", branch], { cwd: repo });
  }
}

describe("API command boundary", () => {
  it("serves a dashboard that can add projects and start runs", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "harness-ui-")); homes.push(home); const store = await Store.open(home);
    const api = apiServer(store, home); const url = await api.listen(0);
    const dashboard = await fetch(url);
    expect(dashboard.status).toBe(200);
    const dashboardHtml = await dashboard.text();
    expect(dashboardHtml).toContain('id="add-project"');
    expect(dashboardHtml).toContain('id="projects"');
    expect(dashboardHtml).toContain('class="shell"');
    expect(dashboardHtml).toContain('id="run-status"');
    expect(dashboardHtml).toContain('id="usage-summary"');
    expect(dashboardHtml).toContain('id="sessions"');
    expect(dashboardHtml).toContain('id="artifacts"');
    expect(dashboardHtml).toContain('id="setup-panel"');
    expect(dashboardHtml).toContain('id="base-branch"');
    const stylesheet = await fetch(`${url}/ui/style.css`);
    expect(stylesheet.status).toBe(200);
    expect(stylesheet.headers.get("content-type")).toContain("text/css");
    const css = await stylesheet.text();
    expect(css).toContain("--accent: #b6f236");
    expect(css).toContain(".status.awaiting_user");
    const setup = await (await fetch(`${url}/api/setup`)).json() as { ready: boolean; runner: { image: string } };
    expect(setup).toMatchObject({ ready: true, runner: { image: "runner:test" } });
    expect((await fetch(`${url}/api/setup/runner`, { method: "POST" })).status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await (await fetch(`${url}/api/setup`)).json()).toMatchObject({ build: { status: "succeeded", log: "built in test" } });
    const projectResponse = await fetch(`${url}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Example", repositoryPath: path.join(home, "repo"), baseBranch: "main" }) });
    expect(projectResponse.status).toBe(201);
    const project = await projectResponse.json() as { id: string };
    const runResponse = await fetch(`${url}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id, idea: "Add a health check" }) });
    expect(runResponse.status).toBe(202);
    expect(store.listRuns()).toHaveLength(1);
    const run = await runResponse.json() as { id: string };
    const request = { turnId: "turn-1", role: "specifier", prompt: "Specify it", outputSchema: { type: "object" } };
    store.createTurn(run.id, "specify", "action-1", request);
    store.finishTurn("action-1", { turnId: "turn-1", sessionId: "session-1", output: { specification: true }, usage: { inputTokens: 80, outputTokens: 20 } });
    const detail = await (await fetch(`${url}/api/runs/${run.id}`)).json() as { turns: unknown[]; usage: { total: { usage: { totalTokens: number } } }; outputs: object; artifacts: unknown[] };
    expect(detail.turns).toHaveLength(1);
    expect(detail.usage.total.usage.totalTokens).toBe(100);
    expect(detail).toMatchObject({ outputs: {}, artifacts: [] });
    expect(await (await fetch(`${url}/api/runs/${run.id}/sessions`)).json()).toHaveLength(1);
    expect((await (await fetch(`${url}/api/runs/${run.id}/usage`)).json()).total.sessions).toBe(1);
    await api.close(); store.close();
  });

  it("returns 202 and deduplicates identical operator commands", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "harness-api-")); homes.push(home); const store = await Store.open(home);
    const api = apiServer(store, home); const url = await api.listen(0);
    const project = store.addProject({ name: "p", repositoryPath: path.join(home, "repo"), baseBranch: "main" });
    const run = store.createRun({ projectId: project.id, workflowId: "complete", firstStep: "clarify", input: { idea: "x" }, effectiveConfig: {} });
    const body = JSON.stringify({ kind: "cancel-run", payload: {} });
    const first = await fetch(`${url}/api/runs/${run.id}/commands`, { method: "POST", headers: { "content-type": "application/json" }, body });
    const second = await fetch(`${url}/api/runs/${run.id}/commands`, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(first.status).toBe(202); expect(second.status).toBe(202); expect((await first.json()).id).toBe((await second.json()).id);
    await api.close(); store.close();
  });

  it("requires WebUI Docker and runner setup before accepting a run", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "harness-setup-")); homes.push(home); const store = await Store.open(home);
    const api = apiServer(store, home, false); const url = await api.listen(0);
    const project = store.addProject({ name: "p", repositoryPath: path.join(home, "repo"), baseBranch: "main" });
    const response = await fetch(`${url}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id, idea: "x" }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("WebUI") });
    expect(store.listRuns()).toHaveLength(0);
    await api.close(); store.close();
  });

  it("lists project branches and stores a per-run base branch override", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "harness-branches-")); homes.push(home);
    const repo = path.join(home, "repo");
    await initRepo(repo, ["main", "feature-base"]);
    const store = await Store.open(home);
    const api = apiServer(store, home);
    const url = await api.listen(0);
    const projectResponse = await fetch(`${url}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Example", repositoryPath: repo, baseBranch: "main" }),
    });
    const project = await projectResponse.json() as { id: string };
    const branches = await (await fetch(`${url}/api/projects/${project.id}/branches`)).json() as { branches: string[]; current?: string };
    expect(branches.branches).toEqual(expect.arrayContaining(["main", "feature-base"]));
    expect(branches.current).toBe("main");
    const runResponse = await fetch(`${url}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, idea: "Branch override", baseBranch: "feature-base" }),
    });
    expect(runResponse.status).toBe(202);
    const run = await runResponse.json() as { id: string; input: { baseBranch: string } };
    expect(run.input.baseBranch).toBe("feature-base");
    await api.close(); store.close();
  });
});
