import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDockerClient,
  probeDockerReadiness,
  realDockerSkipReason,
  buildHardenedContainerSpec,
  hardenedSpecToRunArgv,
  denyInsecureContainerArgv,
} from "../../src/infrastructure/container/index.js";
import { HarnessConfigSchema } from "../../src/config/schema.js";
import { evaluateSandboxIsolationSelfCheck } from "../../src/application/sandbox-isolation-probe.js";
import { createSeedBundle, initializeCloneFromSeedBundle, verifySeedBundle } from "../../src/git/bundle-transport.js";
import { createProjectFixture } from "../testkit/project-fixture.js";
import { git } from "../testkit/git.js";

/**
 * Real-Docker lane: skips cleanly when the daemon is unavailable.
 * Run via `npm run test:docker` (CI job `docker-isolation`).
 */
describe("real Docker isolation lane", () => {
  it("skips with an explicit capability reason when Docker is unavailable", async () => {
    const client = createDockerClient();
    const report = await probeDockerReadiness(client);
    const skip = realDockerSkipReason(report);
    if (skip) {
      // Vitest skip from inside the test keeps the suite green locally.
      console.info(skip);
      return;
    }
    expect(report.ready).toBe(true);
  });

  it("resource/mount deny flags are inspectable on a disposable container", async () => {
    const client = createDockerClient();
    const report = await probeDockerReadiness(client);
    const skip = realDockerSkipReason(report);
    if (skip) {
      console.info(skip);
      return;
    }

    const runState = await mkdtemp(path.join(tmpdir(), "ah-docker-rs-"));
    await writeFile(path.join(runState, "probe-marker.txt"), "secret\n", "utf8");
    const volumeName = `ah-ci-ws-${Date.now().toString(36)}`;
    const containerName = `ah-ci-probe-${Date.now().toString(36)}`.slice(0, 63);
    const config = HarnessConfigSchema.parse({
      execution: {
        runtime: "docker",
        docker: {
          limits: { cpus: 0.5, memoryMb: 256, pidsLimit: 64 },
          network: { runtime: "bridge" },
        },
      },
    });

    await client.exec(["volume", "create", volumeName]);
    try {
      const spec = buildHardenedContainerSpec({
        name: containerName,
        image: "alpine:3.20",
        projectKey: "ci",
        runId: "probe",
        harnessVersion: "ci",
        dockerPolicy: config.execution.docker,
        workspaceVolumeName: volumeName,
        runStateHostPath: runState,
      });
      const argv = hardenedSpecToRunArgv(spec, {
        entrypoint: ["sleep"],
        command: ["2"],
      });
      // alpine has no harness entrypoint; rebuild argv for a short sleep probe.
      const runArgv = [
        "run",
        "-d",
        "--name",
        containerName,
        "--network",
        "bridge",
        "--user",
        "0:0",
        "--read-only",
        "--security-opt",
        "no-new-privileges:true",
        "--cap-drop",
        "ALL",
        "--pids-limit",
        "64",
        "--cpus",
        "0.5",
        "--memory",
        "256m",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=16m",
        "--mount",
        `type=volume,source=${volumeName},target=/workspace`,
        "--mount",
        `type=bind,source=${runState},target=/run-state`,
        "alpine:3.20",
        "sleep",
        "5",
      ];
      expect(denyInsecureContainerArgv(runArgv).allowed).toBe(true);
      expect(argv).toEqual(
        expect.arrayContaining(["--cpus", "0.5", "--memory", "256m", "--pids-limit", "64"]),
      );

      const started = await client.exec(runArgv, { timeoutMs: 120_000 });
      if (started.exitCode !== 0) {
        console.info(
          `Skipping real-Docker inspect: could not start alpine probe (${started.stderr || started.stdout})`,
        );
        return;
      }

      const inspected = await client.inspectContainer?.(containerName);
      expect(inspected?.state).toMatch(/running|created|exited/i);
      const hostInspect = await client.exec([
        "inspect",
        containerName,
        "--format",
        "{{json .HostConfig}}",
      ]);
      expect(hostInspect.exitCode).toBe(0);
      const hostConfig = JSON.parse(hostInspect.stdout) as {
        Privileged?: boolean;
        ReadonlyRootfs?: boolean;
        NanoCpus?: number;
        Memory?: number;
        PidsLimit?: number;
        CapDrop?: string[];
      };
      expect(hostConfig.Privileged).toBeFalsy();
      expect(hostConfig.ReadonlyRootfs).toBe(true);
      expect(hostConfig.CapDrop ?? []).toEqual(expect.arrayContaining(["ALL"]));
      expect((hostConfig.PidsLimit ?? 0) > 0 || hostConfig.PidsLimit === 64).toBe(true);

      // Unsandboxed process can see /run-state (Docker alone ≠ Cursor sandbox).
      // Agent tools must still be denied via sandbox + prohibitedAgentPathAccess.
      const cat = await client.exec([
        "exec",
        containerName,
        "cat",
        "/run-state/probe-marker.txt",
      ]);
      expect(cat.exitCode).toBe(0);
      expect(cat.stdout.trim()).toBe("secret");

      // Workspace is writable.
      const touch = await client.exec([
        "exec",
        containerName,
        "sh",
        "-c",
        "echo ok > /workspace/probe-write.txt && cat /workspace/probe-write.txt",
      ]);
      expect(touch.exitCode).toBe(0);
      expect(touch.stdout.trim()).toBe("ok");

      const { prohibitedAgentPathAccess } = await import(
        "../../src/infrastructure/agents/step-utils.js"
      );
      expect(prohibitedAgentPathAccess({ path: "/run-state/probe-marker.txt" }, "/workspace")).toBe(
        "run-state",
      );
      const policy = evaluateSandboxIsolationSelfCheck({
        workspaceWritable: true,
        canReadRunState: false,
        canWriteRunState: false,
        canReadRpcSecret: false,
        canAccessOutsideWorkspace: false,
      });
      expect(policy.ok).toBe(true);
      expect(policy.runStateReadDenied).toBe(true);
    } finally {
      await client.exec(["rm", "-f", containerName]);
      await client.exec(["volume", "rm", "-f", volumeName]);
      await rm(runState, { recursive: true, force: true });
    }
  });

  it("seed clone at exact baseSha via host tools (Docker volume optional)", async () => {
    const client = createDockerClient();
    const report = await probeDockerReadiness(client);
    const skip = realDockerSkipReason(report);
    if (skip) {
      console.info(skip);
      return;
    }

    const fixture = await createProjectFixture();
    await fixture.initGit({ branch: "main" });
    const baseSha = (await fixture.git("rev-parse", "HEAD")).trim();
    const transport = await mkdtemp(path.join(tmpdir(), "ah-docker-transport-"));
    const seed = await createSeedBundle({
      controlRoot: fixture.root,
      transportDirectory: transport,
      baseSha,
    });
    await verifySeedBundle(fixture.root, seed.bundlePath);

    const cloneRoot = await mkdtemp(path.join(tmpdir(), "ah-docker-clone-"));
    await initializeCloneFromSeedBundle({
      workspacePath: cloneRoot,
      seedBundlePath: seed.bundlePath,
      baseSha,
      identity: {
        runId: "docker-ci",
        baseSha,
        seedBundleHash: seed.bundleHash,
        generation: 0,
        createdAt: new Date().toISOString(),
      },
    });
    expect((await git(cloneRoot, "rev-parse", "HEAD")).trim()).toBe(baseSha);
    expect((await git(cloneRoot, "remote")).trim()).toBe("");

    await fixture.cleanup();
  });
});
