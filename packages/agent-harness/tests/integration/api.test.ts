import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../../src/store.js";
import { ApiServer } from "../../src/api-server.js";

const homes: string[] = [];
afterEach(async () => Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))));

describe("API command boundary", () => {
  it("serves a dashboard that can add projects and start runs", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "harness-ui-")); homes.push(home); const store = await Store.open(home);
    const coordinator = { notify() {} }; const api = new ApiServer(store, coordinator as never, home); const url = await api.listen(0);
    const dashboard = await fetch(url);
    expect(dashboard.status).toBe(200);
    const dashboardHtml = await dashboard.text();
    expect(dashboardHtml).toContain('id="add-project"');
    expect(dashboardHtml).toContain('class="shell"');
    expect(dashboardHtml).toContain('id="run-status"');
    expect(dashboardHtml).toContain('id="usage-summary"');
    expect(dashboardHtml).toContain('id="sessions"');
    expect(dashboardHtml).toContain('id="artifacts"');
    const stylesheet = await fetch(`${url}/ui/style.css`);
    expect(stylesheet.status).toBe(200);
    expect(stylesheet.headers.get("content-type")).toContain("text/css");
    const css = await stylesheet.text();
    expect(css).toContain("--accent: #b6f236");
    expect(css).toContain(".status.awaiting_user");
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
    const coordinator = { notify() {} }; const api = new ApiServer(store, coordinator as never, home); const url = await api.listen(0);
    const project = store.addProject({ name: "p", repositoryPath: path.join(home, "repo"), baseBranch: "main" });
    const run = store.createRun({ projectId: project.id, workflowId: "complete", firstStep: "clarify", input: { idea: "x" }, effectiveConfig: {} });
    const body = JSON.stringify({ kind: "cancel-run", payload: {} });
    const first = await fetch(`${url}/api/runs/${run.id}/commands`, { method: "POST", headers: { "content-type": "application/json" }, body });
    const second = await fetch(`${url}/api/runs/${run.id}/commands`, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(first.status).toBe(202); expect(second.status).toBe(202); expect((await first.json()).id).toBe((await second.json()).id);
    await api.close(); store.close();
  });
});
