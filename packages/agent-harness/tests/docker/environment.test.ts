import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ContainerRuntime } from "../../src/container-runtime.js";

function dockerReason(): string | undefined { try { execFileSync("docker", ["info"], { stdio: "ignore" }); execFileSync("docker", ["image", "inspect", "hexanetwork/agent-harness-runner:1.0.0"], { stdio: "ignore" }); return undefined; } catch { return "Docker or the explicitly installed neutral runner image is unavailable"; } }
const reason = dockerReason();
if (reason && process.env.AGENT_HARNESS_DOCKER_REQUIRED === "1") throw new Error(reason);

describe.skipIf(Boolean(reason))("generated environment", () => {
  it("builds an arbitrary generated environment from the neutral runner", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-docker-")); const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace)); await writeFile(path.join(workspace, "preserved.txt"), "yes");
    const runtime = new ContainerRuntime({ runnerImage: "hexanetwork/agent-harness-runner:1.0.0", buildRoot: root });
    const spec = { containerfile: "FROM hexanetwork/agent-harness-runner:1.0.0\nRUN printf healthy > /tmp/health\n", setupCommands: [], healthcheckCommands: ["test -f /tmp/health"], caches: [{ name: "deps", containerPath: "/home/harness/.cache/harness-test" }] };
    try {
      const built = await runtime.buildEnvironment("docker-test", spec); expect(built.digest).toBeTruthy();
      const name = await runtime.createRunContainer("docker-test", built.image, workspace, spec.caches);
      expect((await runtime.exec(name, "test -f /tmp/health && test \"$(cat preserved.txt)\" = yes")).exitCode).toBe(0);
      const mounts = JSON.parse(execFileSync("docker", ["inspect", name, "--format", "{{json .Mounts}}"], { encoding: "utf8" })) as Array<{ Destination: string }>;
      expect(mounts.map((mount) => mount.Destination).sort()).toEqual(["/home/harness/.cache/harness-test", "/workspace"]);
      expect((await runtime.exec(name, "test ! -e /var/run/docker.sock")).exitCode).toBe(0);
      await runtime.destroy("docker-test"); await runtime.createRunContainer("docker-test", built.image, workspace, spec.caches);
      expect((await runtime.exec(name, "test \"$(cat preserved.txt)\" = yes")).exitCode).toBe(0);
    } finally { await runtime.destroy("docker-test"); await rm(root, { recursive: true, force: true }); }
  });
});
