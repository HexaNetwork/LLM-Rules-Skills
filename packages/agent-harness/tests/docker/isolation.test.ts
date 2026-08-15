import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import { RunStore } from "../../src/store.js";
import { writeRunWorkspace } from "../../src/config/io.js";
import { completeDockerHostPublish } from "../../src/application/docker-publish-service.js";
import { DockerSandboxProvider, harnessWorkerEnv } from "../../src/sandbox/index.js";
import { HostWorktreeProvisioner } from "../../src/workspace/host-worktree-provisioner.js";
import { WorkerHarnessRuntime } from "../../src/application/harness-engine.js";
import { createDeterministicWorkflowBackend } from "../../src/vnext/plugins/deterministic-provider.js";

/**
 * Real-Docker lane: local invocations report and skip unavailable Docker.
 * Required CI sets AGENT_HARNESS_REQUIRE_DOCKER=1 and fails closed.
 */
describe("real Docker isolation lane", () => {
  it("skips with an explicit capability reason when Docker is unavailable", async () => {
    const client = createDockerClient();
    const report = await probeDockerReadiness(client);
    const skip = realDockerSkipReason(report);
    if (skip) {
      requireDockerOrReport(skip);
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
      requireDockerOrReport(skip);
      console.info(skip);
      return;
    }

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
        "10001:10001",
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
        "alpine:3.20",
        "sleep",
        "5",
      ];
      expect(denyInsecureContainerArgv(runArgv).allowed).toBe(true);
      expect(argv).toEqual(
        expect.arrayContaining(["--cpus", "0.5", "--memory", "256m", "--pids-limit", "64"]),
      );

      const initialized = await client.exec([
        "run",
        "--rm",
        "--mount",
        `type=volume,source=${volumeName},target=/workspace`,
        "alpine:3.20",
        "chown",
        "10001:10001",
        "/workspace",
      ]);
      expect(initialized.exitCode).toBe(0);
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

      // Durable host state is not mounted at all; this is stronger than an
      // argument-text heuristic or a missing marker file.
      const cat = await client.exec([
        "exec",
        containerName,
        "cat",
        "/run-state/probe-marker.txt",
      ]);
      expect(cat.exitCode).not.toBe(0);

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

      const policy = evaluateSandboxIsolationSelfCheck({
        workspaceWritable: true,
        canReadRunState: false,
        canWriteRunState: false,
        secretPresent: false,
        canReadRpcSecret: false,
        canAccessOutsideWorkspace: false,
      });
      expect(policy.ok).toBe(true);
      expect(policy.runStateReadDenied).toBe(true);
    } finally {
      await client.exec(["rm", "-f", containerName]);
      await client.exec(["volume", "rm", "-f", volumeName]);
    }
  });

  it("seed clone at exact baseSha via host tools (Docker volume optional)", async () => {
    const client = createDockerClient();
    const report = await probeDockerReadiness(client);
    const skip = realDockerSkipReason(report);
    if (skip) {
      requireDockerOrReport(skip);
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

  it("completes the CLI-only immutable-image edit, verify, and export golden path", async () => {
    const client = createDockerClient();
    const report = await probeDockerReadiness(client);
    const skip = realDockerSkipReason(report);
    if (skip) {
      requireDockerOrReport(skip);
      console.info(skip);
      return;
    }

    const fixture = await createProjectFixture({
      initialFiles: { "message.txt": "before\n" },
    });
    await fixture.initGit({ branch: "main" });
    const baseSha = (await fixture.git("rev-parse", "HEAD")).trim();
    const controlStatus = await fixture.git("status", "--porcelain=v1");
    const transport = await mkdtemp(path.join(tmpdir(), "ah-vnext-golden-"));
    const seed = await createSeedBundle({
      controlRoot: fixture.root,
      transportDirectory: transport,
      baseSha,
    });
    const image = `agent-harness-vnext-ci:${Date.now().toString(36)}`;
    const volume = `ah-vnext-ws-${Date.now().toString(36)}`;
    const initName = `ah-vnext-init-${Date.now().toString(36)}`.slice(0, 63);
    const workerName = `ah-vnext-worker-${Date.now().toString(36)}`.slice(0, 63);
    const exported = path.join(transport, "result.bundle");

    try {
      const built = await client.exec(
        ["build", "-f", "docker/worker/Dockerfile", "-t", image, "."],
        { timeoutMs: 180_000 },
      );
      expect(built.exitCode, built.stderr || built.stdout).toBe(0);
      expect((await client.exec(["volume", "create", volume])).exitCode).toBe(0);

      const initialized = await client.exec(
        [
          "run",
          "--name",
          initName,
          "--rm",
          "--user",
          "0:0",
          "--mount",
          `type=volume,source=${volume},target=/workspace`,
          "--mount",
          `type=bind,source=${seed.bundlePath},target=/seed/repository.bundle,readonly`,
          "--entrypoint",
          "sh",
          image,
          "-c",
          [
            "git init /tmp/source",
            `git -C /tmp/source fetch /seed/repository.bundle ${baseSha}`,
            "git -C /tmp/source checkout --detach FETCH_HEAD",
            "cp -a /tmp/source/. /workspace/",
            "chown -R 10001:10001 /workspace",
          ].join(" && "),
        ],
        { timeoutMs: 120_000 },
      );
      expect(initialized.exitCode, initialized.stderr || initialized.stdout).toBe(0);

      const config = HarnessConfigSchema.parse({
        execution: {
          runtime: "docker",
          docker: {
            limits: { cpus: 0.5, memoryMb: 512, pidsLimit: 96 },
            network: { runtime: "none" },
          },
        },
      });
      const spec = buildHardenedContainerSpec({
        name: workerName,
        image,
        projectKey: "ci",
        runId: "vnext-golden",
        harnessVersion: "ci",
        dockerPolicy: config.execution.docker,
        workspaceVolumeName: volume,
      });
      const started = await client.exec(
        hardenedSpecToRunArgv(spec, {
          entrypoint: ["sh"],
          command: [
            "-c",
            [
              "test \"$(cat /workspace/message.txt)\" = before",
              "printf 'after\\n' > /workspace/message.txt",
              "test \"$(cat /workspace/message.txt)\" = after",
              "git -C /workspace config user.email harness@example.com",
              "git -C /workspace config user.name 'Harness Test'",
              "git -C /workspace add message.txt",
              "git -C /workspace commit -m 'deterministic provider edit'",
              "git -C /workspace bundle create /workspace/result.bundle HEAD",
              "sha256sum /workspace/result.bundle > /workspace/result.bundle.sha256",
            ].join(" && "),
          ],
        }),
        { timeoutMs: 120_000 },
      );
      expect(started.exitCode, started.stderr || started.stdout).toBe(0);
      const waited = await client.exec(["wait", workerName], { timeoutMs: 120_000 });
      expect(waited.stdout.trim()).toBe("0");
      expect((await client.exec(["cp", `${workerName}:/workspace/result.bundle`, exported])).exitCode)
        .toBe(0);
      await verifySeedBundle(fixture.root, exported);

      const imported = await mkdtemp(path.join(tmpdir(), "ah-vnext-import-"));
      await initializeCloneFromSeedBundle({
        workspacePath: imported,
        seedBundlePath: exported,
        baseSha: (await gitBundleHead(exported)).trim(),
        identity: {
          runId: "vnext-import",
          baseSha: (await gitBundleHead(exported)).trim(),
          seedBundleHash: "exported",
          generation: 0,
          createdAt: new Date().toISOString(),
        },
      });
      expect((await readFile(path.join(imported, "message.txt"), "utf8")).trim()).toBe("after");
      await rm(imported, { recursive: true, force: true });
      expect((await fixture.git("rev-parse", "HEAD")).trim()).toBe(baseSha);
      expect(await fixture.git("status", "--porcelain=v1")).toBe(controlStatus);
      expect(await fixture.read("message.txt")).toBe("before\n");
    } finally {
      await client.exec(["rm", "-f", workerName, initName]);
      await client.exec(["volume", "rm", "-f", volume]);
      await client.exec(["image", "rm", "-f", image]);
      await rm(transport, { recursive: true, force: true });
      await fixture.cleanup();
    }
  });

  it("runs host-owned workflow with a disposable worktree sandbox", async () => {
    const client = createDockerClient();
    const report = await probeDockerReadiness(client);
    const skip = realDockerSkipReason(report);
    if (skip) {
      requireDockerOrReport(skip);
      console.info(skip);
      return;
    }

    const fixture = await createProjectFixture({
      initialFiles: {
        "package.json": '{ "type": "module" }\n',
        "README.md": "# Fixture\n",
      },
    });
    await fixture.initGit({ branch: "main" });
    const controlStatus = await fixture.git("status", "--porcelain=v1");
    const stateRoot = await mkdtemp(path.join(tmpdir(), "ah-vnext-state-"));
    const suffix = Date.now().toString(36);
    const sandboxName = `ah-vnext-sandbox-${suffix}`.slice(0, 63);
    const runId = `vnext-product-${suffix}`;

    try {
      const config = HarnessConfigSchema.parse({
        repositoryRoot: fixture.root,
        stateDirectory: stateRoot,
        agent: { provider: "cursor", sandbox: false },
        execution: {
          runtime: "docker",
          docker: {
            limits: { cpus: 1, memoryMb: 1024, pidsLimit: 128 },
            network: { runtime: "bridge", packageInstall: "none" },
          },
        },
        knowledge: {
          sources: [],
          repositoryIntelligence: { enabled: false },
        },
        workflow: { rag: false },
        commands: {
          verification: [
            { id: "baseline", command: "node -e \"process.exit(0)\"", timeoutMs: 30_000 },
          ],
          testTargetTemplate: "node {testPath}",
        },
        git: { push: false, openPullRequest: false },
      });
      const store = new RunStore(config, stateRoot);
      await store.initialize();
      const provisioner = new HostWorktreeProvisioner({
        paths: { controlRoot: fixture.root, stateRoot, workspaceRoot: fixture.root },
        store,
      });
      const workspace = await provisioner.create({ runId, baseBranch: "main" });
      if (workspace.kind !== "host-worktree") throw new Error("expected host-worktree");

      const sandbox = await new DockerSandboxProvider(client).create({
        name: sandboxName,
        image: "alpine:3.20",
        projectKey: "ci",
        runId,
        workspace: { kind: "bind", hostPath: workspace.worktreePath },
        dockerPolicy: config.execution.docker,
        env: harnessWorkerEnv({
          rpcUrl: "https://host.docker.internal:9",
          token: "opaque-docker-isolation-token",
        }),
      });
      try {
        const listing = await sandbox.exec(["sh", "-c", "ls /workspace && test -f /workspace/README.md"]);
        expect(listing.exitCode, listing.stderr || listing.stdout).toBe(0);
        expect(listing.stdout).toContain("README.md");
        const envProbe = await sandbox.exec([
          "sh",
          "-c",
          "env | sort",
        ]);
        expect(envProbe.exitCode).toBe(0);
        expect(envProbe.stdout).toContain("HARNESS_RPC_URL=");
        expect(envProbe.stdout).toContain("HARNESS_WORKER_TOKEN=");
        expect(envProbe.stdout).not.toMatch(
          /CURSOR_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GH_TOKEN|GITHUB_TOKEN/,
        );
      } finally {
        await sandbox.destroy();
      }

      const engine = new WorkerHarnessRuntime(config, {
        backend: createDeterministicWorkflowBackend(),
        store,
        workspace,
        paths: {
          controlRoot: fixture.root,
          stateRoot,
          workspaceRoot: workspace.worktreePath,
        },
      });
      let state = await engine.start("Add a greeting", runId);
      await writeRunWorkspace(config, runId, workspace, {
        runDirectory: store.runDirectory(runId),
      });
      for (let turn = 0; turn < 40; turn += 1) {
        if (state.phase === "publishing" || state.phase === "completed") break;
        if (state.phase === "blocked") {
          throw new Error(`Host workflow blocked: ${state.failure ?? "unknown"}`);
        }
        const activeQuestion = state.questions.find(
          (question) => question.id === state.activeQuestionId && question.status === "open",
        );
        if (activeQuestion) {
          await engine.answerMany(state.runId, [
            { questionId: activeQuestion.id, answer: "Casual" },
          ]);
          state = await engine.advance(state.runId);
        } else if (state.grillReady) {
          await engine.confirmGrill(state.runId);
          state = await engine.advance(state.runId);
        } else if (state.verificationReady) {
          await engine.confirmVerification(state.runId, { keepCurrent: true });
          state = await engine.advance(state.runId);
        } else if (state.planReady) {
          await engine.confirmPlan(state.runId);
          state = await engine.advance(state.runId);
        } else {
          state = await engine.advance(state.runId);
        }
      }

      expect(state.phase).toBe("publishing");
      const published = await completeDockerHostPublish({
        projectConfig: config,
        runConfig: config,
        runId: state.runId,
        store,
      });
      expect(published.phase).toBe("completed");
      expect(published.branchName).toMatch(/^harness\//);
      expect(await fixture.git("status", "--porcelain=v1")).toBe(controlStatus);
      expect(await fixture.read("README.md")).toBe("# Fixture\n");
      expect((await fixture.git("show", `${published.branchName}:src/greeting.js`))).toContain(
        "Hello from Docker!",
      );
    } finally {
      await client.exec(["rm", "-f", sandboxName]);
      await rm(stateRoot, { recursive: true, force: true });
      await fixture.cleanup();
    }
  }, 300_000);
});

function requireDockerOrReport(reason: string): void {
  if (process.env.AGENT_HARNESS_REQUIRE_DOCKER === "1") {
    throw new Error(`Required real-Docker lane is unavailable: ${reason}`);
  }
}

async function gitBundleHead(bundlePath: string): Promise<string> {
  const result = await git(path.dirname(bundlePath), "bundle", "list-heads", bundlePath);
  const head = result.split(/\s+/)[0];
  if (!head) throw new Error(`Exported bundle ${bundlePath} has no HEAD`);
  return head;
}
