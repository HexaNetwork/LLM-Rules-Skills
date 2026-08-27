import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkPacket } from "../../src/domain/types.js";
import { LIVE_WORKER_IMAGE, resolveLaunchLiveEnv } from "../../src/domain/launch-live-env.js";
import { bootHost } from "../../src/boot.js";
import { hostRuntimeRows } from "../../src/plugins/profile.js";
import { createTempDir } from "../helpers.js";

const exec = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const LIVE_ENV_KEYS = [
  "AGENT_HARNESS_AGENTS",
  "AGENT_HARNESS_SANDBOX",
  "AGENT_HARNESS_WORKER_IMAGE",
] as const;

const previousEnv = Object.fromEntries(LIVE_ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of LIVE_ENV_KEYS) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function clearLiveEnv(): void {
  for (const key of LIVE_ENV_KEYS) delete process.env[key];
}

function applyLiveEnv(env: Record<string, string>): void {
  Object.assign(process.env, env);
}

function implementPacket(runId: string): WorkPacket {
  return {
    role: "implementer",
    runId,
    phase: "implement",
    input: { idea: "live launch env" },
    guidance: "",
    retrieval: "",
    budget: { graphifyTokens: 0, truncated: [] },
  };
}

describe("resolveLaunchLiveEnv", () => {
  it("exports cursor+docker+worker image when Docker and CURSOR_API_KEY are present", () => {
    expect(resolveLaunchLiveEnv({ dockerReady: true, cursorApiKey: "sk-test" })).toEqual({
      AGENT_HARNESS_AGENTS: "cursor",
      AGENT_HARNESS_SANDBOX: "docker",
      AGENT_HARNESS_WORKER_IMAGE: "agent-harness-worker:local",
    });
    expect(LIVE_WORKER_IMAGE).toBe("agent-harness-worker:local");
  });

  it("keeps fake-agent fallback when Docker is down", () => {
    expect(resolveLaunchLiveEnv({ dockerReady: false, cursorApiKey: "sk-test" })).toBeUndefined();
  });

  it("keeps fake-agent fallback when CURSOR_API_KEY is missing", () => {
    expect(resolveLaunchLiveEnv({ dockerReady: true, cursorApiKey: "" })).toBeUndefined();
    expect(resolveLaunchLiveEnv({ dockerReady: true, cursorApiKey: "   " })).toBeUndefined();
    expect(resolveLaunchLiveEnv({ dockerReady: true })).toBeUndefined();
  });
});

describe("host composition after launch defaults", () => {
  it("boots cursor+docker after applying live launch env", async () => {
    clearLiveEnv();
    const live = resolveLaunchLiveEnv({ dockerReady: true, cursorApiKey: "sk-test" });
    expect(live).toBeDefined();
    applyLiveEnv(live!);

    const home = await createTempDir("harness-launch-live-");
    const host = await bootHost({ home, extraRows: hostRuntimeRows() });
    try {
      expect(host.ctx.sandbox.mode).toBe("docker");
      const runId = "run-launch-live-env";
      await host.ctx.store.writeIdentity({
        runId,
        projectKey: "toy",
        workflowBundleId: "default",
        controlRoot: home,
        worktreePath: home,
        baseSha: "0".repeat(40),
        baseBranch: "main",
        createdAt: new Date().toISOString(),
      });
      const execMock = vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: JSON.stringify({
          stream: "result",
          protocolVersion: 1,
          output: { summary: "from-sandbox" },
          submittedPrompt: "Role: implementer",
          telemetry: {
            provider: "cursor",
            model: "composer-2.5",
            agentId: "agent-1",
            providerRunId: "run-1",
          },
        }),
        stderr: "",
      });
      host.ctx.sandbox.exec = execMock;
      const output = await host.ctx.agents.invoke("implementer", implementPacket(runId));
      expect(execMock).toHaveBeenCalledTimes(1);
      expect(output).toEqual({ summary: "from-sandbox" });
    } finally {
      await host.dispose();
    }
  });

  it("boots fake-agent + sandbox none when live env is not applied", async () => {
    clearLiveEnv();
    const home = await createTempDir("harness-launch-fake-");
    const host = await bootHost({ home, extraRows: hostRuntimeRows() });
    try {
      expect(host.ctx.sandbox.mode).toBe("none");
      const output = await host.ctx.agents.invoke("implementer", implementPacket("run-launch-fake"));
      expect(output).toMatchObject({ note: "fake-agent" });
    } finally {
      await host.dispose();
    }
  });
});

describe("launch and install scripts", () => {
  it("launch scripts prepare live worker images before starting ui", () => {
    const ps1 = readFileSync(path.join(repoRoot, "scripts/launch-agent-harness.ps1"), "utf8");
    const sh = readFileSync(path.join(repoRoot, "scripts/launch-agent-harness.sh"), "utf8");
    expect(ps1).toMatch(/lib\\live-ready\.ps1/);
    expect(ps1).toMatch(/Set-AgentHarnessLiveLaunchEnv/);
    expect(ps1).toMatch(/Invoke-AgentHarnessWorkerPrepare/);
    expect(ps1).toMatch(/Invoke-AgentHarnessWorkerProbe/);
    expect(ps1.indexOf("Invoke-AgentHarnessWorkerPrepare")).toBeLessThan(ps1.lastIndexOf("& node $Cli @uiArgs"));
    expect(sh).toMatch(/lib\/live-ready\.sh/);
    expect(sh).toMatch(/ah_set_live_launch_env/);
    expect(sh).toMatch(/ah_worker_prepare/);
    expect(sh).toMatch(/ah_worker_probe/);
    expect(sh.indexOf("ah_worker_prepare")).toBeLessThan(sh.lastIndexOf('exec node "$CLI" ui'));
  });

  it("install scripts prepare and probe the worker image", () => {
    const ps1 = readFileSync(path.join(repoRoot, "scripts/install-agent-harness.ps1"), "utf8");
    const sh = readFileSync(path.join(repoRoot, "scripts/install-agent-harness.sh"), "utf8");
    expect(ps1).toMatch(/Invoke-AgentHarnessWorkerPrepare/);
    expect(ps1).toMatch(/Invoke-AgentHarnessWorkerProbe/);
    expect(ps1).toMatch(/agent-harness-worker:local/);
    expect(sh).toMatch(/ah_worker_prepare/);
    expect(sh).toMatch(/ah_worker_probe/);
    expect(sh).toMatch(/agent-harness-worker:local/);
  });

  it("PowerShell live-ready helper exports the live env without GITHUB_TOKEN", async () => {
    const helper = path.join(repoRoot, "scripts/lib/live-ready.ps1");
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `. '${helper.replace(/'/g, "''")}'`,
      "$live = Resolve-AgentHarnessLiveLaunchEnv -DockerReady $true -CursorApiKey 'sk-test'",
      "if ($null -eq $live) { throw 'expected live env' }",
      "$live | ConvertTo-Json -Compress",
    ].join("; ");
    const { stdout } = await exec("powershell.exe", ["-NoProfile", "-Command", script], {
      windowsHide: true,
    });
    const parsed = JSON.parse(stdout.trim()) as Record<string, string>;
    expect(parsed.AGENT_HARNESS_AGENTS).toBe("cursor");
    expect(parsed.AGENT_HARNESS_SANDBOX).toBe("docker");
    expect(parsed.AGENT_HARNESS_WORKER_IMAGE).toBe("agent-harness-worker:local");
    expect(parsed).not.toHaveProperty("GITHUB_TOKEN");
    const helperSource = readFileSync(helper, "utf8");
    expect(helperSource).not.toMatch(/GITHUB_TOKEN/);
  });
});
