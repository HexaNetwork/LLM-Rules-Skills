import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSandboxIsolationProbePassed,
  defaultSandboxIsolationProbeExecutor,
  ensureSandboxIsolationProbe,
  evaluateSandboxIsolationSelfCheck,
  findCachedSandboxIsolationProbe,
  loadSandboxIsolationProbeCache,
  pruneSandboxIsolationProbeVolumes,
  saveSandboxIsolationProbeCache,
  sandboxIsolationProbeCacheKey,
  sandboxIsolationProbePassed,
  SANDBOX_ISOLATION_PROBE_POLICY_VERSION,
  type SandboxIsolationProbeExecutor,
  type SandboxIsolationProbeReport,
} from "../../src/application/sandbox-isolation-probe.js";
import {
  capabilitiesForBackend,
  checkWorkspaceIsolation,
} from "../../src/application/workspace-isolation.js";
import { reconcileOrphanContainers } from "../../src/application/orphan-reconciler.js";
import { HarnessConfigSchema } from "../../src/config/schema.js";
import {
  buildHardenedContainerSpec,
  denyInsecureContainerArgv,
  denyMountOrFlag,
  hardenedSpecToRunArgv,
} from "../../src/infrastructure/container/index.js";
import { createFakeDockerClient } from "../../src/infrastructure/container/fake-docker-client.js";
import { createFakeBackend } from "../../src/infrastructure/agents/fake-backend.js";
import { buildCommandEnvironment } from "../../src/commands.js";
import { argvLeaksProviderCredential } from "../../src/infrastructure/container/container-spec.js";
import { detectInstallFromToolStep } from "../../src/infrastructure/agents/step-utils.js";
import { WORKER_WORKSPACE_PATH } from "../../src/application/paths.js";
import { HarnessFailure } from "../../src/errors.js";

const DIGEST =
  "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

function passingReport(imageDigest = DIGEST): SandboxIsolationProbeReport {
  return {
    version: 1,
    ok: true,
    unsupported: false,
    imageDigest,
    policyVersion: SANDBOX_ISOLATION_PROBE_POLICY_VERSION,
    probedAt: new Date().toISOString(),
    checks: [
      { id: "workspace-write", ok: true, detail: "ok" },
      { id: "host-state-read-denied", ok: true, detail: "ok" },
      { id: "host-state-write-denied", ok: true, detail: "ok" },
      { id: "credential-mount-absent", ok: true, detail: "ok" },
      { id: "outside-workspace-denied", ok: true, detail: "ok" },
      { id: "sandbox-enabled", ok: true, detail: "ok" },
      { id: "mount-topology", ok: true, detail: "ok" },
      { id: "resource-flags", ok: true, detail: "ok" },
    ],
  };
}

describe("sandbox isolation probe gating", () => {
  it("fail-closed: unsupported or failed probe cannot accept a digest", () => {
    expect(() =>
      assertSandboxIsolationProbePassed(
        {
          ...passingReport(),
          ok: false,
          unsupported: true,
          reason: "no docker",
        },
        DIGEST,
      ),
    ).toThrow(HarnessFailure);

    expect(() =>
      assertSandboxIsolationProbePassed(
        { ...passingReport(), ok: false, reason: "tool could read /run-state" },
        DIGEST,
      ),
    ).toThrow(/Cannot accept execution image/);

    expect(sandboxIsolationProbePassed(undefined)).toBe(false);
    expect(sandboxIsolationProbePassed(passingReport())).toBe(true);
  });

  it("caches successful probes by digest + policy version", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ah-probe-cache-"));
    const report = passingReport();
    await saveSandboxIsolationProbeCache(root, {
      version: 1,
      updatedAt: report.probedAt,
      entries: [report],
    });
    const cache = await loadSandboxIsolationProbeCache(root);
    expect(findCachedSandboxIsolationProbe(cache, DIGEST)?.ok).toBe(true);
    expect(sandboxIsolationProbeCacheKey(DIGEST)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("ensureSandboxIsolationProbe reuses cache and persists executor success", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ah-probe-ens-"));
    const probeState = path.join(root, "probe-state");
    await mkdir(probeState, { recursive: true });
    const docker = createFakeDockerClient({ healthy: true });
    const config = HarnessConfigSchema.parse({
      execution: { runtime: "docker", docker: { sandboxRequired: true } },
    });

    let runs = 0;
    const executor: SandboxIsolationProbeExecutor = async ({ imageDigest }) => {
      runs += 1;
      return passingReport(imageDigest);
    };

    const first = await ensureSandboxIsolationProbe({
      imageDigest: DIGEST,
      docker,
      dockerPolicy: config.execution.docker,
      projectStateRoot: root,
      probeRunStateHostPath: probeState,
      executor,
    });
    expect(first.ok).toBe(true);
    expect(runs).toBe(1);

    const second = await ensureSandboxIsolationProbe({
      imageDigest: DIGEST,
      docker,
      dockerPolicy: config.execution.docker,
      projectStateRoot: root,
      probeRunStateHostPath: probeState,
      executor,
    });
    expect(second.ok).toBe(true);
    expect(runs).toBe(1);
  });

  it("default executor is fail-closed unsupported when image cannot self-check", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ah-probe-uns-"));
    const probeState = path.join(root, "probe-state");
    await mkdir(probeState, { recursive: true });
    const docker = createFakeDockerClient({ healthy: true });
    const config = HarnessConfigSchema.parse({
      execution: { runtime: "docker", docker: { sandboxRequired: true } },
    });

    const report = await ensureSandboxIsolationProbe({
      imageDigest: DIGEST,
      docker,
      dockerPolicy: config.execution.docker,
      projectStateRoot: root,
      probeRunStateHostPath: probeState,
    });
    expect(report.ok).toBe(false);
    expect(report.unsupported).toBe(true);
    expect(() => assertSandboxIsolationProbePassed(report, DIGEST)).toThrow(HarnessFailure);
    // Disposable ah-probe-* volume must not linger after the probe.
    expect([...docker.volumes.keys()].filter((name) => name.startsWith("ah-probe-"))).toEqual([]);
    expect(docker.calls.some((call) => call.args[0] === "volume" && call.args[1] === "rm")).toBe(
      true,
    );
  });

  it("pruneSandboxIsolationProbeVolumes removes leftover ah-probe volumes only", async () => {
    const docker = createFakeDockerClient({ healthy: true });
    docker.volumes.set("ah-probe-leftover1", { name: "ah-probe-leftover1", driver: "local" });
    docker.volumes.set("ah-probe-leftover2", { name: "ah-probe-leftover2", driver: "local" });
    docker.volumes.set("ah-ws-project-run-1", { name: "ah-ws-project-run-1", driver: "local" });

    const pruned = await pruneSandboxIsolationProbeVolumes(docker);
    expect(pruned.found.sort()).toEqual(["ah-probe-leftover1", "ah-probe-leftover2"]);
    expect(pruned.removed.sort()).toEqual(["ah-probe-leftover1", "ah-probe-leftover2"]);
    expect(docker.volumes.has("ah-ws-project-run-1")).toBe(true);
    expect(docker.volumes.has("ah-probe-leftover1")).toBe(false);

    docker.volumes.set("ah-probe-again", { name: "ah-probe-again", driver: "local" });
    const report = await reconcileOrphanContainers({
      docker,
      knownRuns: [],
      apply: false,
    });
    expect(report.probeVolumes.removed).toEqual(["ah-probe-again"]);
    expect(docker.volumes.has("ah-probe-again")).toBe(false);
  });

  it("evaluateSandboxIsolationSelfCheck requires all denials", () => {
    expect(
      evaluateSandboxIsolationSelfCheck({
        workspaceWritable: true,
        canReadRunState: false,
        canWriteRunState: false,
        secretPresent: false,
        canReadRpcSecret: false,
        canAccessOutsideWorkspace: false,
      }).ok,
    ).toBe(true);
    expect(
      evaluateSandboxIsolationSelfCheck({
        workspaceWritable: true,
        canReadRunState: true,
        canWriteRunState: false,
        secretPresent: false,
        canReadRpcSecret: false,
        canAccessOutsideWorkspace: false,
      }).ok,
    ).toBe(false);
  });
});

describe("capability advertising after probe", () => {
  it("advertises canRestrictWritableWorkspace only after Docker probe success", () => {
    const backend = createFakeBackend({});
    expect(
      capabilitiesForBackend(backend, "fake", {
        sandboxIsolationProbePassed: false,
      }).canRestrictWritableWorkspace,
    ).toBe(false);
    expect(
      capabilitiesForBackend(backend, "fake", {
        sandboxIsolationProbePassed: true,
      }).canRestrictWritableWorkspace,
    ).toBe(true);
  });

  it("strict isolation rejects Docker when probe has not passed", () => {
    const result = checkWorkspaceIsolation({
      paths: {
        controlRoot: "/repo",
        stateRoot: "/state",
        workspaceRoot: WORKER_WORKSPACE_PATH,
      },
      homeRoot: "/home",
      strictIsolation: true,
      capabilities: { canRestrictWritableWorkspace: false, providerId: "cursor" },
      agentCwd: WORKER_WORKSPACE_PATH,
      containerExecution: true,
      sandboxIsolationProbePassed: false,
    });
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toMatch(/sandbox isolation probe/i);
  });

  it("default probe overrides worker ENTRYPOINT with self-check path", async () => {
    const { WORKER_ISOLATION_SELF_CHECK_PATH } = await import(
      "../../src/worker/protocol.js"
    );
    const probeDir = await mkdtemp(path.join(tmpdir(), "ah-probe-rs-"));
    const docker = createFakeDockerClient({
      scripted: [
        {
          match: WORKER_ISOLATION_SELF_CHECK_PATH,
          result: {
            exitCode: 0,
            stdout: JSON.stringify({
              workspaceWrite: true,
              runStateReadDenied: true,
              runStateWriteDenied: true,
              secretPresent: false,
              rpcSecretReadDenied: true,
              outsideWorkspaceDenied: true,
            }),
            stderr: "",
            timedOut: false,
          },
        },
      ],
    });
    const config = HarnessConfigSchema.parse({
      execution: { docker: { sandboxRequired: true } },
    });
    const report = await defaultSandboxIsolationProbeExecutor({
      imageDigest: DIGEST,
      docker,
      dockerPolicy: config.execution.docker,
      probeRunStateHostPath: probeDir,
      workspaceVolumeName: "ah-probe-vol",
    });
    expect(report.ok).toBe(true);
    const runCall = docker.calls.find(
      (call) => call.args[0] === "run" && call.args.includes(WORKER_ISOLATION_SELF_CHECK_PATH),
    );
    expect(runCall?.args).toEqual(
      expect.arrayContaining(["--entrypoint", WORKER_ISOLATION_SELF_CHECK_PATH, DIGEST]),
    );
    expect(runCall?.args).not.toContain("agent-harness");
    const entryIdx = runCall?.args.indexOf("--entrypoint") ?? -1;
    expect(runCall?.args[entryIdx + 1]).toBe(WORKER_ISOLATION_SELF_CHECK_PATH);
  });

  it("classifies executable-not-found as missing self-check, not missing image", async () => {
    const probeDir = await mkdtemp(path.join(tmpdir(), "ah-probe-miss-"));
    const docker = createFakeDockerClient({
      scripted: [
        {
          match: "--entrypoint /bin/sh",
          result: { exitCode: 0, stdout: "", stderr: "", timedOut: false },
        },
        {
          match: /^run /,
          result: {
            exitCode: 127,
            stdout: "",
            stderr:
              'exec: "/opt/agent-harness/sandbox-isolation-self-check": executable file not found in $PATH',
            timedOut: false,
          },
        },
      ],
    });
    const config = HarnessConfigSchema.parse({
      execution: { runtime: "docker", docker: { sandboxRequired: true } },
    });
    const report = await defaultSandboxIsolationProbeExecutor({
      imageDigest: DIGEST,
      docker,
      dockerPolicy: config.execution.docker,
      probeRunStateHostPath: probeDir,
      workspaceVolumeName: "ah-probe-vol",
    });
    expect(report.ok).toBe(false);
    expect(report.unsupported).toBe(true);
    expect(report.reason).toMatch(/lacks sandbox-isolation-self-check/);
    expect(report.reason).not.toMatch(/not available to run self-check/);
  });
});

describe("production worker isolation contract", () => {
  const config = HarnessConfigSchema.parse({
    execution: {
      runtime: "docker",
      docker: {
        limits: { cpus: 1, memoryMb: 1024, pidsLimit: 64 },
        network: { runtime: "bridge" },
      },
    },
  });

  it("exposes only workspace plus tmpfs as writable surfaces and never /run-state or provider keys", () => {
    const spec = buildHardenedContainerSpec({
      name: "ah-iso",
      image: DIGEST,
      projectKey: "p",
      runId: "r",
      harnessVersion: "0.3.2",
      dockerPolicy: config.execution.docker,
      workspaceVolumeName: "ah-ws",
      environment: [
        "HARNESS_RPC_URL=https://host.docker.internal:8788",
        "HARNESS_WORKER_TOKEN=opaque-worker-token",
      ],
    });
    const argv = hardenedSpecToRunArgv(spec);
    const writableMounts = spec.mounts.filter((mount) => mount.readOnly === false);
    expect(writableMounts).toEqual([
      expect.objectContaining({ target: WORKER_WORKSPACE_PATH, readOnly: false }),
    ]);
    expect(spec.tmpfs.map((entry) => entry.path).sort()).toEqual(["/home/harness", "/tmp"]);
    expect(spec.mounts.map((mount) => mount.target)).not.toContain("/run-state");
    expect(argv.join(" ")).not.toMatch(/\/run-state/);
    expect(argv.join(" ")).not.toMatch(
      /CURSOR_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GH_TOKEN|GITHUB_TOKEN|docker\.sock/,
    );
    expect(spec.mounts.some((mount) => mount.target.startsWith("/run/secrets"))).toBe(false);
    expect(spec.env).toEqual(
      expect.arrayContaining([
        "HARNESS_RPC_URL=https://host.docker.internal:8788",
        "HARNESS_WORKER_TOKEN=opaque-worker-token",
      ]),
    );
    expect(spec.env?.some((entry) => /^(CURSOR|OPENAI|ANTHROPIC)_API_KEY=/i.test(entry))).toBe(
      false,
    );
    expect(denyInsecureContainerArgv(argv).allowed).toBe(true);
  });
});

describe("secret and mount/resource hardening (unit)", () => {
  it("never leaks CURSOR_API_KEY into command environments even when passEnv requests it", () => {
    const previous = process.env.CURSOR_API_KEY;
    process.env.CURSOR_API_KEY = "unit-test-cursor-key-value";
    try {
      const built = buildCommandEnvironment({
        passEnv: ["PATH", "CURSOR_API_KEY", "HOME"],
      });
      expect(built.env.CURSOR_API_KEY).toBeUndefined();
      expect(built.redactions).toContain("unit-test-cursor-key-value");
    } finally {
      if (previous === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = previous;
    }
  });

  it("detects provider credential leaks in argv and allows slash-prefixed brief text", () => {
    expect(argvLeaksProviderCredential(["run", "-e", "CURSOR_API_KEY=x", "img"])).toBe(true);
    expect(argvLeaksProviderCredential(["run", "--name", "c", "img"])).toBe(false);
    expect(
      detectInstallFromToolStep({
        type: "toolCall",
        message: { type: "write", args: { contents: "Use /t claim in the brief" } },
      }),
    ).toBeUndefined();
  });

  it("encodes resource limits and denies secret-env / privileged argv", () => {
    const config = HarnessConfigSchema.parse({
      execution: {
        runtime: "docker",
        docker: {
          limits: { cpus: 1.25, memoryMb: 1536, pidsLimit: 96 },
          network: { runtime: "bridge", packageInstall: "bridge" },
        },
      },
    });
    const spec = buildHardenedContainerSpec({
      name: "ah-harden",
      image: DIGEST,
      projectKey: "p",
      runId: "r",
      harnessVersion: "0.3.2",
      dockerPolicy: config.execution.docker,
      workspaceVolumeName: "ah-ws",
    });
    const argv = hardenedSpecToRunArgv(spec);
    expect(argv).toEqual(
      expect.arrayContaining([
        "--cpus",
        "1.25",
        "--memory",
        "1536m",
        "--pids-limit",
        "96",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--network",
        "bridge",
      ]),
    );
    expect(argv.join(" ")).not.toMatch(/CURSOR_API_KEY|privileged|docker\.sock/);
    // The Cursor SDK sandbox helper needs an unprivileged user namespace, which
    // Docker's default seccomp profile refuses while capabilities are dropped.
    expect(spec.seccomp).toBe("unconfined");
    expect(argv).toEqual(
      expect.arrayContaining(["--security-opt", "seccomp=unconfined", "--cap-drop", "ALL"]),
    );
    const structuralOnly = buildHardenedContainerSpec({
      name: "ah-harden-nosdk",
      image: DIGEST,
      projectKey: "p",
      runId: "r",
      harnessVersion: "0.3.2",
      dockerPolicy: config.execution.docker,
      workspaceVolumeName: "ah-ws",
      runsCursorSandbox: false,
    });
    expect(structuralOnly.seccomp).toBe("docker-default");
    expect(hardenedSpecToRunArgv(structuralOnly).join(" ")).not.toContain("seccomp");
    const withPublicCa = buildHardenedContainerSpec({
      name: "ah-harden-ca",
      image: DIGEST,
      projectKey: "p",
      runId: "r",
      harnessVersion: "0.3.2",
      dockerPolicy: config.execution.docker,
      workspaceVolumeName: "ah-ws",
      publicReadOnlyMounts: [
        {
          source: "C:\\harness-state\\cursor-provider-tls\\ca-cert.pem",
          target: "/run/agent-harness-public/cursor-provider-ca.pem",
        },
      ],
    });
    const caArgv = hardenedSpecToRunArgv(withPublicCa);
    expect(caArgv).toContain(
      "NODE_EXTRA_CA_CERTS=/run/agent-harness-public/cursor-provider-ca.pem",
    );
    expect(caArgv.join(" ")).not.toMatch(/ca-key|server-key|CURSOR_API_KEY/);
    expect(denyInsecureContainerArgv(argv).allowed).toBe(true);
    expect(
      denyInsecureContainerArgv(["run", "-e", "CURSOR_API_KEY=secret", "img"]).allowed,
    ).toBe(false);
    expect(denyInsecureContainerArgv(["run", "--privileged", "img"]).allowed).toBe(false);
    expect(
      denyMountOrFlag({
        mounts: [{ source: "/var/run/docker.sock", target: "/var/run/docker.sock" }],
      }).allowed,
    ).toBe(false);
  });
});
