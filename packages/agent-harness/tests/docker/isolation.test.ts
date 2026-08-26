import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { containerName } from "../../src/domain/mount-policy.js";
import { bootHost } from "../../src/boot.js";
import { hostRuntimeRows } from "../../src/plugins/profile.js";
import { createTempDir, createTempRepo, currentBranch } from "../helpers.js";

const exec = promisify(execFile);

async function dockerSkipReason(): Promise<string | undefined> {
  try {
    await exec("docker", ["info"], { windowsHide: true });
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (process.env.AGENT_HARNESS_REQUIRE_DOCKER === "1") {
      throw new Error(`Docker is required but unavailable: ${message}`);
    }
    return `Docker is not available: ${message}`;
  }
}

describe("docker isolation", () => {
  it("mounts only the worktree, keeps host secrets out, and leaves the control checkout unchanged", async () => {
    const skip = await dockerSkipReason();
    if (skip) {
      console.warn(skip);
      return;
    }
    const home = await createTempDir("harness-docker-home-");
    const repo = await createTempRepo();
    const canary = path.join(repo, "CONTROL_CANARY.txt");
    await writeFile(canary, "control-untouched\n", "utf8");
    process.env.GITHUB_TOKEN = "should-not-enter";
    process.env.CURSOR_API_KEY = "cursor-test-key";
    const host = await bootHost({
      home,
      extraRows: hostRuntimeRows({
        agents: { mode: "fake" },
        sandbox: { mode: "docker", image: "node:22-bookworm-slim" },
      }),
    });
    const runId = "11111111-2222-4333-8444-555555555555";
    try {
      const project = await host.ctx.projects.add(repo);
      const baseBranch = await currentBranch(repo);
      const { worktreePath, baseSha } = await host.ctx.git.createWorktree(project, runId, baseBranch);
      await host.ctx.store.writeIdentity({
        runId,
        projectKey: project.projectKey,
        workflowBundleId: "default",
        controlRoot: project.controlRoot,
        worktreePath,
        baseSha,
        baseBranch,
        createdAt: new Date().toISOString(),
      });
      await host.ctx.sandbox.ensure(runId);
      const inspected = await host.ctx.sandbox.inspect(runId);
      expect(inspected.mounts.some((mount) => mount.destination === "/workspace")).toBe(true);
      expect(inspected.mounts.some((mount) => mount.source === repo || mount.destination === "/var/run/docker.sock")).toBe(
        false,
      );
      expect(inspected.env.some((entry) => entry.startsWith("GITHUB_TOKEN="))).toBe(false);
      expect(inspected.env.some((entry) => entry.startsWith("CURSOR_API_KEY="))).toBe(true);
      await host.ctx.sandbox.exec(runId, {
        command: ["sh", "-c", "echo isolated > /workspace/SANDBOX_WRITE.txt"],
      });
      const written = await readFile(path.join(worktreePath, "SANDBOX_WRITE.txt"), "utf8");
      expect(written.trim()).toBe("isolated");
      expect(await readFile(canary, "utf8")).toBe("control-untouched\n");
    } finally {
      await host.ctx.sandbox.destroy(runId).catch(() => undefined);
      await exec("docker", ["rm", "-f", containerName(runId)], { windowsHide: true }).catch(() => undefined);
      await host.dispose();
      delete process.env.GITHUB_TOKEN;
    }
  });

  it("reuses an existing worker container when ensure is called again after restart", async () => {
    const skip = await dockerSkipReason();
    if (skip) {
      console.warn(skip);
      return;
    }
    const home = await createTempDir("harness-docker-restart-");
    const repo = await createTempRepo();
    process.env.CURSOR_API_KEY = "cursor-test-key";
    const host = await bootHost({
      home,
      extraRows: hostRuntimeRows({
        agents: { mode: "fake" },
        sandbox: { mode: "docker", image: "node:22-bookworm-slim" },
      }),
    });
    const runId = "22222222-3333-4444-8555-666666666666";
    try {
      const project = await host.ctx.projects.add(repo);
      const baseBranch = await currentBranch(repo);
      const { worktreePath, baseSha } = await host.ctx.git.createWorktree(project, runId, baseBranch);
      await host.ctx.store.writeIdentity({
        runId,
        projectKey: project.projectKey,
        workflowBundleId: "default",
        controlRoot: project.controlRoot,
        worktreePath,
        baseSha,
        baseBranch,
        createdAt: new Date().toISOString(),
      });
      await host.ctx.sandbox.ensure(runId);
      await host.dispose();

      const restarted = await bootHost({
        home,
        extraRows: hostRuntimeRows({
          agents: { mode: "fake" },
          sandbox: { mode: "docker", image: "node:22-bookworm-slim" },
        }),
      });
      await expect(restarted.ctx.sandbox.ensure(runId)).resolves.toBeDefined();
      const inspected = await restarted.ctx.sandbox.inspect(runId);
      expect(inspected.status).toBe("running");
      await restarted.dispose();
    } finally {
      await exec("docker", ["rm", "-f", containerName(runId)], { windowsHide: true }).catch(() => undefined);
    }
  });
});
