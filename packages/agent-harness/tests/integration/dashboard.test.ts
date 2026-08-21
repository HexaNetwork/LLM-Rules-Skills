import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dashboardRow } from "../../src/plugins/dashboard.js";
import { hostRuntimeRows } from "../../src/plugins/profile.js";
import { bootHost } from "../../src/boot.js";
import { createTempDir, createTempRepo } from "../helpers.js";

const exec = promisify(execFile);

describe("dashboard as runLifecycle client", () => {
  it("starts and answers a run only through runLifecycle routes", async () => {
    const home = await createTempDir("harness-ui-");
    const repo = await createTempRepo();
    const baseBranch = (
      await exec("git", ["branch", "--show-current"], { cwd: repo, windowsHide: true })
    ).stdout.trim();
    const host = await bootHost({
      home,
      extraRows: [
        ...hostRuntimeRows({ agents: { mode: "fake" }, sandbox: { mode: "none" } }),
        dashboardRow({ port: 0 }),
      ],
    });
    try {
      const dashboard = host.ctx.dashboard;
      if (!dashboard) throw new Error("dashboard missing");
      const url = await dashboard.start();
      const token = dashboard.token;
      const registered = await fetchJson(new URL("/api/projects", url), token, {
        method: "POST",
        body: JSON.stringify({ controlRoot: repo }),
      });
      expect(registered.controlRoot).toBe(repo);
      const projects = await fetchJson(new URL("/api/projects", url), token, {});
      expect(projects).toHaveLength(1);
      const started = await fetchJson(new URL("/api/runs", url), token, {
        method: "POST",
        body: JSON.stringify({
          idea: "Add a ping route",
          projectKey: registered.projectKey,
          baseBranch,
        }),
      });
      expect(started.state.phase).toBe("reflect");
      expect(started.identity.baseBranch).toBe(baseBranch);
      const activity = await fetchJson(
        new URL(`/api/runs/${started.identity.runId}/activity`, url),
        token,
        {},
      );
      expect(activity.at(-1)).toMatchObject({ phase: "reflect", status: "awaiting_input" });
      const sessions = await fetchJson(
        new URL(`/api/runs/${started.identity.runId}/sessions`, url),
        token,
        {},
      );
      expect(sessions.length).toBeGreaterThan(0);
      const answered = await fetchJson(
        new URL(`/api/runs/${started.identity.runId}/answer`, url),
        token,
        { method: "POST", body: JSON.stringify({ answers: { restatement: "yes" } }) },
      );
      expect(answered.state.phase).toBe("grill");
      const deleted = await fetchJson(
        new URL(`/api/runs/${started.identity.runId}/delete`, url),
        token,
        { method: "POST", body: JSON.stringify({}) },
      );
      expect(deleted).toEqual({ deleted: started.identity.runId });
      const remaining = await fetchJson(new URL("/api/runs", url), token, {});
      expect(remaining.find((run: { identity: { runId: string } }) => run.identity.runId === started.identity.runId)).toBeUndefined();
    } finally {
      await host.ctx.dashboard?.stop();
      await host.dispose();
    }
  });

  it("serves the responsive operator shell while protecting lifecycle data", async () => {
    const home = await createTempDir("harness-ui-shell-");
    const host = await bootHost({
      home,
      extraRows: [
        ...hostRuntimeRows({ agents: { mode: "fake" }, sandbox: { mode: "none" } }),
        dashboardRow({ port: 0 }),
      ],
    });
    try {
      const dashboard = host.ctx.dashboard;
      if (!dashboard) throw new Error("dashboard missing");
      const url = await dashboard.start();
      const token = dashboard.token;
      const page = await fetch(url);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("HexAgent Harness");
      expect(html).toContain("Hexa durable operations");
      expect(html).toContain("Operator input required");
      expect(html).toContain("Chart a new run");
      expect(html).toContain('data-action="delete"');
      expect(html).toContain("Deleting run…");
      expect(html).toContain("Deleting…");
      expect(html).toContain("Starting wayfinding…");
      expect(html).toContain("Starting…");
      expect(html).toContain("working-line");
      expect(html).toContain("Working");
      expect(html).toContain("Agent contexts");
      expect(html).toContain('id="guidance-toggle"');
      expect(html).toContain("setInterval(() => refresh()");
      const roles = await fetchJson(new URL("/api/guidance/roles", url), token, {});
      expect(roles.roles.length).toBeGreaterThan(0);
      const reflectorEntry = roles.roles.find((entry: { role: string }) => entry.role === "reflector");
      expect(reflectorEntry.source).toBe("packaged");
      const reflector = await fetchJson(new URL("/api/guidance/roles/reflector", url), token, {});
      expect(reflector.source).toBe("packaged");
      expect(String(reflector.body)).toContain("Reflector guidance");
      expect(String(reflector.promptPreview)).toContain("EXPECTED OUTPUT");
      expect(String(reflector.promptPreview)).toContain("Reflector guidance");
      const sidebar = html.slice(html.indexOf('class="sidebar"'), html.indexOf('class="workspace"'));
      expect(sidebar).toContain("new-run-toggle");
      expect(sidebar).toContain("guidance-toggle");
      expect(sidebar).not.toContain('id="start-form"');
      expect(sidebar).not.toContain('id="idea"');

      const unauthorized = await fetch(new URL("/api/runs", url));
      expect(unauthorized.status).toBe(401);
    } finally {
      await host.ctx.dashboard?.stop();
      await host.dispose();
    }
  });

  it("saves and resets role guidance overrides through the dashboard API", async () => {
    const home = await createTempDir("harness-ui-guidance-");
    const host = await bootHost({
      home,
      extraRows: [
        ...hostRuntimeRows({ agents: { mode: "fake" }, sandbox: { mode: "none" } }),
        dashboardRow({ port: 0 }),
      ],
    });
    try {
      const dashboard = host.ctx.dashboard;
      if (!dashboard) throw new Error("dashboard missing");
      const url = await dashboard.start();
      const token = dashboard.token;
      const before = await fetchJson(new URL("/api/guidance/roles/fixer", url), token, {});
      expect(before.source).toBe("packaged");
      const saved = await fetchJson(new URL("/api/guidance/roles/fixer", url), token, {
        method: "PUT",
        body: JSON.stringify({ body: "Custom fixer guidance from the dashboard." }),
      });
      expect(saved.source).toBe("home");
      expect(String(saved.body)).toContain("Custom fixer guidance from the dashboard.");
      const projectSaved = await fetchJson(new URL("/api/guidance/roles/fixer", url), token, {
        method: "PUT",
        body: JSON.stringify({
          body: "Project-scoped fixer guidance.",
          projectKey: "demo-project",
        }),
      });
      expect(projectSaved.source).toBe("project");
      const projectView = await fetchJson(
        new URL("/api/guidance/roles/fixer?projectKey=demo-project", url),
        token,
        {},
      );
      expect(projectView.source).toBe("project");
      expect(String(projectView.promptPreview)).toContain("Project-scoped fixer guidance.");
      const globalView = await fetchJson(new URL("/api/guidance/roles/fixer", url), token, {});
      expect(globalView.source).toBe("home");
      const resetProject = await fetchJson(
        new URL("/api/guidance/roles/fixer?projectKey=demo-project", url),
        token,
        { method: "DELETE" },
      );
      expect(resetProject.source).toBe("home");
      const resetHome = await fetchJson(new URL("/api/guidance/roles/fixer", url), token, {
        method: "DELETE",
      });
      expect(resetHome.source).toBe("packaged");
      expect(String(resetHome.body)).toContain("Fixer guidance");
    } finally {
      await host.ctx.dashboard?.stop();
      await host.dispose();
    }
  });
});

async function fetchJson(url: URL, token: string, init: RequestInit): Promise<any> {
  const response = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? response.statusText);
  return body;
}
