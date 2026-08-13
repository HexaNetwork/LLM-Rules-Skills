import { describe, expect, it } from "vitest";
import {
  buildDockerRunArgv,
} from "../../src/infrastructure/container/docker-client.js";
import { createFakeDockerClient } from "../../src/infrastructure/container/fake-docker-client.js";
import {
  assertDockerReadiness,
  compareApiVersion,
  probeDockerReadiness,
  realDockerSkipReason,
} from "../../src/infrastructure/container/docker-readiness.js";
import {
  buildHardenedContainerSpec,
  denyMountOrFlag,
  hardenedSpecToRunArgv,
  networkPolicyDocumentation,
} from "../../src/infrastructure/container/container-spec.js";
import { HarnessConfigSchema } from "../../src/config/schema.js";
import { evaluateExecutionRuntimeStatus } from "../../src/application/execution-runtime-status.js";
import { HarnessFailure } from "../../src/errors.js";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const WORKER =
  "ghcr.io/example/worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NODE_BASE =
  "node:22-bookworm@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("fake DockerClient argv behavior", () => {
  it("records argv arrays and never requires a real daemon", async () => {
    const client = createFakeDockerClient({ healthy: true });
    const result = await client.build({
      contextDir: "/tmp/ctx",
      dockerfilePath: "/tmp/ctx/Dockerfile",
      tag: "img:1",
      buildArgs: { UNUSED: "no" },
    });
    expect(result.exitCode).toBe(0);
    expect(client.calls[0]?.args[0]).toBe("build");
    expect(client.calls[0]?.args).toContain("-f");
    expect(client.calls[0]?.args).toContain("/tmp/ctx/Dockerfile");
    expect(client.calls[0]?.args).toEqual(
      expect.arrayContaining(["--build-arg", "UNUSED=no"]),
    );
  });

  it("createDockerClient build argv uses arrays only", () => {
    const args = buildDockerRunArgv({
      image: "img",
      name: "c1",
      labels: { "io.agent-harness.run-id": "r1" },
      network: "bridge",
      cpus: 2,
      memoryMb: 4096,
      pidsLimit: 256,
      workspaceVolume: "vol",
      workspaceMountPath: "/workspace",
      runStateBind: "/state/runs/r1",
      runStateMountPath: "/run-state",
      user: "10001:10001",
    });
    expect(args[0]).toBe("run");
    expect(args).toContain("--read-only");
    expect(args).toContain("--cap-drop");
    expect(args).toContain("ALL");
    expect(args.join(" ")).not.toMatch(/privileged|docker\.sock/);
  });
});

describe("docker readiness", () => {
  it("reports ready for a healthy fake Linux daemon", async () => {
    const client = createFakeDockerClient({ healthy: true, osType: "linux" });
    const report = await probeDockerReadiness(client);
    expect(report.ready).toBe(true);
    expect(realDockerSkipReason(report)).toBeUndefined();
  });

  it("classifies unhealthy daemon as execution failure", async () => {
    const client = createFakeDockerClient({ healthy: false });
    await expect(assertDockerReadiness(client)).rejects.toBeInstanceOf(HarnessFailure);
    try {
      await assertDockerReadiness(client);
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessFailure);
      expect((error as HarnessFailure).kind).toBe("execution");
    }
  });

  it("compares API versions", () => {
    expect(compareApiVersion("1.45", "1.44")).toBeGreaterThan(0);
    expect(compareApiVersion("1.43", "1.44")).toBeLessThan(0);
  });
});

describe("hardened container spec and mount deny rules", () => {
  it("encodes read-only, non-root, caps, resources, tmpfs, and mounts", () => {
    const config = HarnessConfigSchema.parse({
      execution: {
        runtime: "docker",
        docker: {
          limits: { cpus: 1.5, memoryMb: 2048, pidsLimit: 128 },
          network: { runtime: "bridge" },
        },
      },
    });
    const spec = buildHardenedContainerSpec({
      name: "ah-run-1",
      image: "img@sha256:abc",
      projectKey: "proj",
      runId: "run-1",
      harnessVersion: "0.3.2",
      dockerPolicy: config.execution.docker,
      workspaceVolumeName: "ah-ws-run-1",
      runStateHostPath: "/home/x/.agent-harness/projects/proj/runs/run-1",
      publishHostPort: 4123,
    });
    expect(spec.readOnlyRootfs).toBe(true);
    expect(spec.dropAllCapabilities).toBe(true);
    expect(spec.noNewPrivileges).toBe(true);
    expect(spec.user).toBe("10001:10001");
    expect(spec.network).toBe("bridge");
    expect(spec.mounts).toHaveLength(2);

    const argv = hardenedSpecToRunArgv(spec);
    expect(argv).toEqual(
      expect.arrayContaining([
        "--read-only",
        "--security-opt",
        "no-new-privileges:true",
        "--cap-drop",
        "ALL",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m",
        "--publish",
        "127.0.0.1:4123:8787",
      ]),
    );
    expect(networkPolicyDocumentation("bridge")).toMatch(/not exfiltration-proof/i);
  });

  it("denies privileged, host namespaces, docker.sock, and extra binds", () => {
    expect(denyMountOrFlag({ privileged: true }).allowed).toBe(false);
    expect(denyMountOrFlag({ networkHost: true }).allowed).toBe(false);
    expect(denyMountOrFlag({ pidHost: true }).allowed).toBe(false);
    expect(
      denyMountOrFlag({
        mounts: [{ source: "/var/run/docker.sock", target: "/var/run/docker.sock" }],
      }).allowed,
    ).toBe(false);
    expect(
      denyMountOrFlag({
        mounts: [{ kind: "bind", source: "/repo", target: "/workspace" }],
      }).allowed,
    ).toBe(false);
    expect(
      denyMountOrFlag({
        mounts: [{ kind: "bind", source: "/other-run", target: "/run-state" }],
        allowedBindSources: new Set(["/current-run"]),
      }).allowed,
    ).toBe(false);
    expect(
      denyMountOrFlag({
        mounts: [
          { kind: "volume", source: "ws", target: "/workspace" },
          { kind: "bind", source: "/current-run", target: "/run-state" },
        ],
        allowedBindSources: new Set(["/current-run"]),
      }).allowed,
    ).toBe(true);
  });
});

describe("probeDockerReadiness", () => {
  it("skips the alpine port-binding container when includePortBinding is false", async () => {
    const client = createFakeDockerClient({ healthy: true, osType: "linux" });
    const report = await probeDockerReadiness(client, { includePortBinding: false });
    expect(report.ready).toBe(true);
    expect(report.checks.some((check) => check.id === "port-binding")).toBe(false);
    expect(client.calls.some((call) => call.args[0] === "run")).toBe(false);
  });

  it("runs the alpine port-binding probe by default", async () => {
    const client = createFakeDockerClient({ healthy: true, osType: "linux" });
    const report = await probeDockerReadiness(client);
    expect(report.checks.some((check) => check.id === "port-binding" && check.ok)).toBe(true);
    expect(
      client.calls.some(
        (call) => call.args[0] === "run" && call.args.includes("alpine:3.20"),
      ),
    ).toBe(true);
  });
});

describe("execution runtime status gate", () => {
  it("marks local runtime ready without Docker probes", async () => {
    const config = HarnessConfigSchema.parse({ execution: { runtime: "local" } });
    const status = await evaluateExecutionRuntimeStatus({ config, probeDocker: false });
    expect(status.ready).toBe(true);
    expect(status.runtime).toBe("local");
  });

  it("blocks docker mode when worker/base images are missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ah-rt-"));
    await writeFile(path.join(root, "package.json"), '{"name":"demo"}\n', "utf8");
    const config = HarnessConfigSchema.parse({
      repositoryRoot: root,
      execution: { runtime: "docker", docker: { approvedBaseImages: [] } },
    });
    const client = createFakeDockerClient({ healthy: true });
    const status = await evaluateExecutionRuntimeStatus({
      config,
      docker: client,
      repositoryRoot: root,
      collectEvidence: true,
    });
    expect(status.ready).toBe(false);
    expect(status.blockers.some((b) => b.code === "worker-image-missing")).toBe(true);
    expect(status.blockers.some((b) => b.code === "base-images-empty")).toBe(true);
  });

  it("is ready when docker is healthy and a single stack can generate", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ah-rt-ok-"));
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "package.json"), '{"name":"demo"}\n', "utf8");
    const config = HarnessConfigSchema.parse({
      repositoryRoot: root,
      execution: {
        runtime: "docker",
        docker: {
          workerImageDigest: WORKER,
          approvedBaseImages: [NODE_BASE],
        },
      },
    });
    const client = createFakeDockerClient({ healthy: true, osType: "linux" });
    const status = await evaluateExecutionRuntimeStatus({
      config,
      docker: client,
      repositoryRoot: root,
    });
    expect(status.ready).toBe(true);
    expect(status.image?.canGenerate).toBe(true);
  });
});
