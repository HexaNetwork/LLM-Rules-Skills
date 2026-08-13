import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakeDockerClient } from "../../src/infrastructure/container/fake-docker-client.js";
import {
  digestPinnedFromInspect,
  prepareMaintainedWorkerImage,
} from "../../src/application/prepare-worker-image.js";
import { HarnessFailure } from "../../src/errors.js";

const PINNED =
  "ghcr.io/example/agent-harness-worker:1@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("prepareMaintainedWorkerImage", () => {
  it("fails closed when Docker is unhealthy", async () => {
    const docker = createFakeDockerClient({ healthy: false });
    await expect(
      prepareMaintainedWorkerImage({
        docker,
        pullImage: PINNED,
        reuseLocalTag: false,
      }),
    ).rejects.toBeInstanceOf(HarnessFailure);
  });

  it("pulls a digest-pinned worker image and returns the same pin", async () => {
    const docker = createFakeDockerClient({ healthy: true });
    const result = await prepareMaintainedWorkerImage({
      docker,
      pullImage: PINNED,
      reuseLocalTag: false,
    });
    expect(result.source).toBe("pulled");
    expect(result.workerImageDigest).toBe(PINNED);
    expect(result.readiness.ready).toBe(true);
    expect(docker.calls.some((call) => call.args[0] === "pull")).toBe(true);
  });

  it("builds from package Dockerfile when no pull image is set", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ah-worker-pkg-"));
    await mkdir(path.join(root, "docker", "worker"), { recursive: true });
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "docker", "worker", "Dockerfile"), "FROM scratch\n", "utf8");
    await writeFile(path.join(root, "dist", "cli.js"), "export {}\n", "utf8");

    const docker = createFakeDockerClient({ healthy: true });
    const result = await prepareMaintainedWorkerImage({
      docker,
      packageRoot: root,
      tag: "agent-harness-worker:test",
      reuseLocalTag: false,
    });
    expect(result.source).toBe("built");
    expect(result.workerImageDigest).toMatch(
      /^agent-harness-worker:test@sha256:[a-f0-9]{64}$/i,
    );
    expect(docker.calls.some((call) => call.args[0] === "build")).toBe(true);
  });

  it("digestPinnedFromInspect builds name@sha256 from image id", () => {
    const ref = digestPinnedFromInspect("agent-harness-worker:local", {
      id: `sha256:${"b".repeat(64)}`,
      repoTags: ["agent-harness-worker:local"],
    });
    expect(ref).toBe(`agent-harness-worker:local@sha256:${"b".repeat(64)}`);
  });
});
