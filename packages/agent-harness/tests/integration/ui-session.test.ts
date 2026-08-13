import path from "node:path";
import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createFakeBackend } from "../../src/infrastructure/agents/fake-backend.js";
import { startUiServer, type UiServer } from "../../src/ui/server.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

describe("dashboard session survives a browser refresh", () => {
  let ui: UiServer | undefined;

  async function start(): Promise<UiServer> {
    ui = await startUiServer({
      config: fixtureConfig(await fixtureRoot()),
      backend: createFakeBackend({}),
      port: 0,
      token: "refresh-token"});
    return ui;
  }

  it("issues a session cookie for the tokenized URL and accepts it alone", async () => {
    const server = await start();
    try {
      // First open: the browser follows the tokenized URL printed by `ui`.
      const shell = await fetch(`${server.origin}/?token=${server.token}`);
      expect(shell.status).toBe(200);
      const cookie = shell.headers.get("set-cookie");
      expect(cookie).toContain("harness_token=refresh-token");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).toContain("Path=/");

      // The client strips ?token= from the address bar. A refresh therefore
      // reloads "/" bare and calls the API with no header — only the cookie.
      const reload = await fetch(`${server.origin}/`);
      expect(reload.status).toBe(200);
      const boot = await fetch(`${server.origin}/api/bootstrap`, {
        headers: { cookie: "harness_token=refresh-token" }});
      expect(boot.status).toBe(200);
      expect((await boot.json()) as { runs: unknown[] }).toHaveProperty("runs");
    } finally {
      await server.close();
      ui = undefined;
    }
  });

  it("keeps a run visible across a refresh that has only the cookie", async () => {
    const server = await start();
    try {
      const created = await fetch(`${server.origin}/api/runs`, {
        method: "POST",
        headers: { "X-Harness-Token": server.token, "Content-Type": "application/json" },
        body: JSON.stringify({ idea: "Build a thing" })});
      expect(created.status).toBe(202);
      const { run } = (await created.json()) as { run: { runId: string } };

      const boot = await fetch(`${server.origin}/api/bootstrap`, {
        headers: { cookie: `harness_token=${server.token}` }});
      expect(boot.status).toBe(200);
      const body = (await boot.json()) as { runs: Array<{ runId: string }> };
      expect(body.runs.map((entry) => entry.runId)).toContain(run.runId);
    } finally {
      await server.close();
      ui = undefined;
    }
  });

  it("does not set a cookie for an unauthenticated shell request", async () => {
    const server = await start();
    try {
      const shell = await fetch(`${server.origin}/`);
      expect(shell.status).toBe(200);
      expect(shell.headers.get("set-cookie")).toBeNull();

      const forged = await fetch(`${server.origin}/api/bootstrap`, {
        headers: { cookie: "harness_token=wrong-token" }});
      expect(forged.status).toBe(401);

      const none = await fetch(`${server.origin}/api/bootstrap`);
      expect(none.status).toBe(401);
    } finally {
      await server.close();
      ui = undefined;
    }
  });
});

describe("unreadable runs are reported, not dropped", () => {
  it("lists a run with a corrupt state.json as a failure instead of hiding it", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root);
    const server = await startUiServer({
      config,
      backend: createFakeBackend({}),
      port: 0,
      token: "corrupt-token"});
    try {
      const created = await fetch(`${server.origin}/api/runs`, {
        method: "POST",
        headers: { "X-Harness-Token": server.token, "Content-Type": "application/json" },
        body: JSON.stringify({ idea: "A run that will be corrupted" })});
      const { run } = (await created.json()) as { run: { runId: string } };

      const statePath = path.join(root, ".agent-harness", "runs", run.runId, "state.json");
      await writeFile(statePath, "{ not valid json", "utf8");

      const boot = await fetch(`${server.origin}/api/bootstrap`, {
        headers: { "X-Harness-Token": server.token }});
      const body = (await boot.json()) as {
        runs: Array<{ runId: string }>;
        unreadableRuns: Array<{ runId: string; error: string }>;
      };
      expect(body.runs.map((entry) => entry.runId)).not.toContain(run.runId);
      expect(body.unreadableRuns.map((entry) => entry.runId)).toContain(run.runId);
      expect(body.unreadableRuns[0]!.error).toBeTruthy();
    } finally {
      await server.close();
    }
  });
});
