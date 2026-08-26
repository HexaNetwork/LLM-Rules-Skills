import { describe, expect, it } from "vitest";
import { bootHost } from "../../src/boot.js";
import { dashboardRow } from "../../src/plugins/dashboard.js";
import { hostRuntimeRows } from "../../src/plugins/profile.js";
import { createTempDir, createTempRepo } from "../helpers.js";

describe("dashboard agent timeout settings", () => {
  it("edits the global timeout and a project override", async () => {
    const home = await createTempDir("harness-timeout-ui-");
    const repo = await createTempRepo();
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
      const baseUrl = await dashboard.start();
      const token = dashboard.token;

      const global = await request(
        new URL("/api/settings/agent-timeout", baseUrl),
        token,
        { method: "PUT", body: JSON.stringify({ timeoutMinutes: 55 }) },
      );
      expect(global.effectiveMinutes).toBe(55);

      const project = await request(new URL("/api/projects", baseUrl), token, {
        method: "POST",
        body: JSON.stringify({ controlRoot: repo }),
      });
      const projectUrl = new URL("/api/settings/agent-timeout", baseUrl);
      projectUrl.searchParams.set("projectKey", project.projectKey);
      const overridden = await request(projectUrl, token, {
        method: "PUT",
        body: JSON.stringify({ timeoutMinutes: 8 }),
      });
      expect(overridden.projectMinutes).toBe(8);
      expect(overridden.effectiveMinutes).toBe(8);

      const inherited = await request(projectUrl, token, {
        method: "PUT",
        body: JSON.stringify({ timeoutMinutes: null }),
      });
      expect(inherited.projectMinutes).toBeUndefined();
      expect(inherited.effectiveMinutes).toBe(55);
    } finally {
      await host.ctx.dashboard?.stop();
      await host.dispose();
    }
  });
});

async function request(url: URL, token: string, init: RequestInit): Promise<any> {
  const response = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(String(body.error ?? response.statusText));
  return body;
}
