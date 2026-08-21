import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { renderDashboardPage } from "../../src/ui/page.js";
import { dashboardRow } from "../../src/plugins/dashboard.js";
import { hostRuntimeRows } from "../../src/plugins/profile.js";
import { bootHost } from "../../src/boot.js";
import { createTempDir, createTempRepo } from "../helpers.js";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, windowsHide: true });
  return stdout.trim();
}

describe("dashboard base branch", () => {
  it("lists project branches and starts a run with baseBranch", async () => {
    const home = await createTempDir("harness-ui-base-");
    const repo = await createTempRepo();
    const current = await git(repo, ["branch", "--show-current"]);
    await git(repo, ["branch", "compose-base"]);
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
      const branches = await fetchJson(
        new URL(`/api/projects/${encodeURIComponent(registered.projectKey)}/branches`, url),
        token,
        {},
      );
      expect(branches.branches).toEqual(expect.arrayContaining([current, "compose-base"]));
      expect(branches.current).toBe(current);

      const started = await fetchJson(new URL("/api/runs", url), token, {
        method: "POST",
        body: JSON.stringify({
          idea: "Pick a base branch",
          projectKey: registered.projectKey,
          baseBranch: "compose-base",
        }),
      });
      expect(started.identity.baseBranch).toBe("compose-base");
      expect(started.state.branchName).toBeUndefined();
    } finally {
      await host.ctx.dashboard?.stop();
      await host.dispose();
    }
  });

  it("embeds base-branch compose control and identity Base/Current labels", () => {
    const html = renderDashboardPage();
    expect(html).toContain('id="base-branch"');
    expect(html).toContain("Base branch");
    expect(html).toContain("Current branch");
    expect(html).toContain("data-copy-path");
    expect(html).toContain("copy-path-btn");
    expect(html).toContain("Copy base branch");
    expect(html).toContain("Copy current branch");
    expect(html).toContain("Copy worktree path");
    expect(html).toContain("/api/projects/");
    expect(html).toContain("/branches");
    expect(html).toContain("baseBranch");
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
