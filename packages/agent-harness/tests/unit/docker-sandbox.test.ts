import { describe, expect, it } from "vitest";
import { HarnessConfigSchema } from "../../src/config/schema.js";
import { createFakeDockerClient } from "../../src/infrastructure/container/fake-docker-client.js";
import { DockerSandboxProvider, harnessWorkerEnv } from "../../src/sandbox/index.js";

const IMAGE =
  "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

describe("DockerSandboxProvider", () => {
  const dockerPolicy = HarnessConfigSchema.parse({
    execution: { docker: { limits: { cpus: 1, memoryMb: 512, pidsLimit: 32 } } },
  }).execution.docker;

  it("creates, execs, and destroys a container without touching host state", async () => {
    const docker = createFakeDockerClient({ healthy: true });
    const provider = new DockerSandboxProvider(docker);
    const sandbox = await provider.create({
      name: "ah-sbx-1",
      image: IMAGE,
      projectKey: "p",
      runId: "r1",
      workspace: { kind: "bind", hostPath: "D:/harness/worktrees/r1" },
      dockerPolicy,
      env: harnessWorkerEnv({
        rpcUrl: "https://host.docker.internal:8788",
        token: "opaque-worker-token",
      }),
    });
    expect(sandbox.name).toBe("ah-sbx-1");
    expect(docker.containers.has("ah-sbx-1")).toBe(true);
    const run = docker.calls.find((call) => call.args[0] === "run");
    expect(run?.args.join(" ")).toMatch(/type=bind,source=D:\/harness\/worktrees\/r1,target=\/workspace/);
    expect(run?.args.join(" ")).not.toMatch(/\/run-state|CURSOR_API_KEY|OPENAI_API_KEY|docker\.sock/);
    expect(run?.args).toEqual(
      expect.arrayContaining([
        "--env",
        "HARNESS_RPC_URL=https://host.docker.internal:8788",
        "--env",
        "HARNESS_WORKER_TOKEN=opaque-worker-token",
      ]),
    );

    await sandbox.exec(["git", "status", "--porcelain"]);
    expect(docker.calls.some((call) => call.args[0] === "exec" && call.args[1] === "ah-sbx-1")).toBe(
      true,
    );

    await sandbox.destroy();
    expect(docker.containers.has("ah-sbx-1")).toBe(false);
  });

  it("refuses durable provider credentials in sandbox env", async () => {
    const docker = createFakeDockerClient({ healthy: true });
    const provider = new DockerSandboxProvider(docker);
    await expect(
      provider.create({
        name: "ah-sbx-bad",
        image: IMAGE,
        projectKey: "p",
        runId: "r1",
        workspace: { kind: "bind", hostPath: "D:/harness/worktrees/r1" },
        dockerPolicy,
        env: ["CURSOR_API_KEY=sk-leak"],
      }),
    ).rejects.toThrow(/must not carry durable provider/);
  });
});
