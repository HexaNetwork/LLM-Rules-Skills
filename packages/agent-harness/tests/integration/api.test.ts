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
    expect(await dashboard.text()).toContain('id="add-project"');
    const projectResponse = await fetch(`${url}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Example", repositoryPath: path.join(home, "repo"), baseBranch: "main" }) });
    expect(projectResponse.status).toBe(201);
    const project = await projectResponse.json() as { id: string };
    const runResponse = await fetch(`${url}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id, idea: "Add a health check" }) });
    expect(runResponse.status).toBe(202);
    expect(store.listRuns()).toHaveLength(1);
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
