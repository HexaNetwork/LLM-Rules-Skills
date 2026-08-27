import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { containerName } from "../../src/domain/mount-policy.js";
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
      expect(activity.some((event: { kind?: string }) => event.kind === "agent")).toBe(true);
      expect(
        activity.some(
          (event: { kind?: string; status?: string }) =>
            event.kind === "agent" && event.status === "running",
        ),
      ).toBe(true);
      const agentEvent = activity.find(
        (event: { kind?: string; status?: string }) =>
          event.kind === "agent" && event.status === "completed",
      );
      expect(agentEvent).toMatchObject({
        kind: "agent",
        role: "reflector",
        phase: "reflect",
        status: "completed",
        packet: expect.objectContaining({
          model: expect.any(String),
          inputKind: expect.any(String),
        }),
      });
      expect(typeof agentEvent.sessionId).toBe("string");
      expect(activity.every((event: { kind?: string }) => event.kind !== "agent_stream")).toBe(
        true,
      );
      const sessions = await fetchJson(
        new URL(`/api/runs/${started.identity.runId}/sessions`, url),
        token,
        {},
      );
      expect(sessions.length).toBeGreaterThan(0);
      expect(sessions[0]).toMatchObject({
        role: "reflector",
        status: "completed",
      });
      expect(typeof sessions[0].sessionId).toBe("string");
      expect(sessions[0].startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(sessions[0].endedAt).toBe(sessions[0].at);
      expect(sessions[0].packet).toMatchObject({ phase: "reflect", role: "reflector" });
      expect(sessions[0].output).toBeTruthy();
      expect(agentEvent.sessionId).toBe(sessions[0].sessionId);
      const sessionEvents = await fetchJson(
        new URL(
          `/api/runs/${started.identity.runId}/sessions/${sessions[0].sessionId}/events`,
          url,
        ),
        token,
        {},
      );
      expect(Array.isArray(sessionEvents)).toBe(true);
      const usage = await fetchJson(
        new URL(`/api/runs/${started.identity.runId}/usage`, url),
        token,
        {},
      );
      expect(usage.total.sessions).toBe(sessions.length);
      expect(usage.byAgentType).toEqual(
        expect.arrayContaining([expect.objectContaining({ key: "reflector" })]),
      );
      const answered = await fetchJson(
        new URL(`/api/runs/${started.identity.runId}/answer`, url),
        token,
        { method: "POST", body: JSON.stringify({ answers: { restatement: "yes" } }) },
      );
      expect(answered.state.phase).toBe("grill");
      const lifecycleDelete = host.ctx.runLifecycle.delete.bind(host.ctx.runLifecycle);
      let releaseCleanup!: () => void;
      const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
      let finishCleanup!: () => void;
      const cleanupFinished = new Promise<void>((resolve) => { finishCleanup = resolve; });
      host.ctx.runLifecycle.delete = async (runId) => {
        try {
          await cleanupGate;
          return await lifecycleDelete(runId);
        } finally {
          finishCleanup();
        }
      };
      const deleted = await fetchJson(
        new URL(`/api/runs/${started.identity.runId}/delete`, url),
        token,
        { method: "POST", body: JSON.stringify({}) },
      );
      expect(deleted).toEqual({ deleted: started.identity.runId });
      const remaining = await fetchJson(new URL("/api/runs", url), token, {});
      expect(remaining.find((run: { identity: { runId: string } }) => run.identity.runId === started.identity.runId)).toBeUndefined();
      expect(await host.ctx.store.readIdentity(started.identity.runId)).toBeTruthy();
      releaseCleanup();
      await cleanupFinished;
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
      expect(html).toContain("Wait what?");
      expect(html).toContain("Skip for now");
      expect(html).toContain("Accept all recommendations");
      expect(html).toContain("data-batch-choice");
      expect(html).toContain("question-option");
      expect(html).toContain("Chart a new run");
      expect(html).toContain('data-action="delete"');
      expect(html).toContain("Run removed; cleanup is continuing in the background");
      expect(html).toContain("Starting wayfinding…");
      expect(html).toContain("Starting…");
      expect(html).toContain("Submitting answers… continuing the run");
      expect(html).toContain("Submitting…");
      expect(html).toContain("function gateHiddenWhileBusy");
      expect(html).toContain("function focusRunChrome");
      expect(html).toContain('action === "answer"');
      expect(html).toContain("working-line");
      expect(html).toContain("Working");
      expect(html).toContain("Agent contexts");
      expect(html).toContain('id="guidance-toggle"');
      expect(html).toContain("setInterval(() => refresh()");
      expect(html).toContain('class="run-tabs"');
      expect(html).toContain('data-tab="');
      expect(html).toContain('["overview", "Overview"');
      expect(html).toContain('["artifacts", "Artifacts"');
      expect(html).toContain('["tasks", "Tasks"');
      expect(html).toContain('["sessions", "Sessions"');
      expect(html).toContain('["activity", "Activity"');
      expect(html).toContain('["docker", "Docker"');
      expect(html).toContain("function renderOverview");
      expect(html).toContain("needs-input");
      expect(html).toContain("Run identity");
      expect(html).toContain("Copy worktree path");
      expect(html).not.toContain("if (gateHtml) return gateHtml");
      expect(html).not.toContain("gate-banner");
      expect(html).toContain("formatGateScenarios");
      expect(html).toContain('data-session="');
      expect(html).toContain("sessionOpen");
      expect(html).toContain('details.session[data-session]');
      expect(html).toContain('event.kind === "agent"');
      expect(html).toContain("formatTelemetryUsage");
      expect(html).toContain("input budget");
      expect(html).toContain("session-status");
      expect(html).toContain("Usage & cost");
      expect(html).toContain('data-usage-tab="');
      expect(html).toContain('["model", "By model"]');
      expect(html).toContain('["totals", "Cost / tokens"]');
      expect(html).toContain('["agent-type", "By agent type"]');
      expect(html).toContain("Cost / tokens");
      expect(html).toContain("By agent type");
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

  it("exposes sandbox info for a run without failing when the container is absent", async () => {
    const home = await createTempDir("harness-ui-sandbox-");
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
      const started = await fetchJson(new URL("/api/runs", url), token, {
        method: "POST",
        body: JSON.stringify({
          idea: "Inspect sandbox metadata",
          projectKey: registered.projectKey,
          baseBranch,
        }),
      });
      const runId = started.identity.runId;
      const sandbox = await fetchJson(new URL(`/api/runs/${runId}/sandbox`, url), token, {});
      expect(sandbox).toEqual({
        mode: "none",
        containerName: containerName(runId),
      });
      expect(sandbox).not.toHaveProperty("running");

      const missing = await fetch(new URL("/api/runs/no-such-run/sandbox", url), {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: "Unknown run: no-such-run" });
    } finally {
      await host.ctx.dashboard?.stop();
      await host.dispose();
    }
  });

  it("exposes worker image status and repair actions in sandbox mode none", async () => {
    const home = await createTempDir("harness-ui-image-");
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

      const missing = await fetch(new URL("/api/runs/no-such-run/image", url), {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: "Unknown run: no-such-run" });

      const registered = await fetchJson(new URL("/api/projects", url), token, {
        method: "POST",
        body: JSON.stringify({ controlRoot: repo }),
      });
      const started = await fetchJson(new URL("/api/runs", url), token, {
        method: "POST",
        body: JSON.stringify({
          idea: "Inspect worker image status",
          projectKey: registered.projectKey,
          baseBranch,
        }),
      });
      const runId = started.identity.runId;

      const status = await fetchJson(new URL(`/api/runs/${runId}/image`, url), token, {});
      expect(status.mode).toBe("none");
      expect(typeof status.mainImage).toBe("string");
      expect(status.mainImage.length).toBeGreaterThan(0);
      expect(status.hasOverride).toBe(false);
      expect(status.attempts).toBe(0);

      const repaired = await fetchJson(new URL(`/api/runs/${runId}/image/repair`, url), token, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(repaired.attempt.attempted).toBe(false);
      expect(repaired.attempt.repaired).toBe(false);
      expect(String(repaired.attempt.reason)).toMatch(/docker/i);
      expect(repaired.status.mode).toBe("none");

      const applied = await fetch(new URL(`/api/runs/${runId}/image/apply-main`, url), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(applied.status).toBe(400);
      const appliedBody = await applied.json();
      expect(typeof appliedBody.error).toBe("string");
      expect(String(appliedBody.error)).toContain("No run-scoped image repair");
    } finally {
      await host.ctx.dashboard?.stop();
      await host.dispose();
    }
  });

  it("returns running false when docker inspect fails for a known run", async () => {
    const home = await createTempDir("harness-ui-sandbox-docker-");
    const repo = await createTempRepo();
    const baseBranch = (
      await exec("git", ["branch", "--show-current"], { cwd: repo, windowsHide: true })
    ).stdout.trim();
    const host = await bootHost({
      home,
      extraRows: [
        ...hostRuntimeRows({ agents: { mode: "fake" }, sandbox: { mode: "docker" } }),
        dashboardRow({ port: 0 }),
      ],
    });
    try {
      expect(host.ctx.sandbox.mode).toBe("docker");
      host.ctx.sandbox.inspect = async () => {
        throw new Error("No such container");
      };
      const dashboard = host.ctx.dashboard;
      if (!dashboard) throw new Error("dashboard missing");
      const url = await dashboard.start();
      const token = dashboard.token;
      const registered = await fetchJson(new URL("/api/projects", url), token, {
        method: "POST",
        body: JSON.stringify({ controlRoot: repo }),
      });
      const started = await fetchJson(new URL("/api/runs", url), token, {
        method: "POST",
        body: JSON.stringify({
          idea: "Docker sandbox absent container",
          projectKey: registered.projectKey,
          baseBranch,
        }),
      });
      const runId = started.identity.runId;
      const response = await fetch(new URL(`/api/runs/${runId}/sandbox`, url), {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        mode: "docker",
        containerName: containerName(runId),
        running: false,
      });
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
