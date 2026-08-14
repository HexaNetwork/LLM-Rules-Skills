import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertCloneReopenInvariants,
  assertUnsupportedGitFeaturesRejected,
  createSeedBundle,
  hashFileSha256,
  initializeCloneFromSeedBundle,
  readCloneIdentity,
  resolveBaseSha,
  verifySeedBundle,
} from "../../src/git/bundle-transport.js";
import { createProjectFixture } from "../testkit/project-fixture.js";
import { git } from "../testkit/git.js";
import { DockerCloneProvisioner } from "../../src/workspace/docker-clone-provisioner.js";
import { createFakeDockerClient } from "../../src/infrastructure/container/fake-docker-client.js";
import { HarnessConfigSchema } from "../../src/config/schema.js";
import {
  WORKER_WORKSPACE_PATH,
  resolveExecutionWorkspaceRoot,
} from "../../src/application/paths.js";
import { buildCommandEnvironment } from "../../src/commands.js";
import { prohibitedAgentPathAccess } from "../../src/infrastructure/agents/step-utils.js";
import {
  checkWorkspaceIsolation,
  forbiddenAgentWritableRoots,
} from "../../src/application/workspace-isolation.js";
import { createApplicationDependencies } from "../../src/application/dependencies.js";
import { createFakeBackend } from "../../src/infrastructure/agents/fake-backend.js";

async function transportDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "ah-transport-"));
}

describe("seed bundle transport", () => {
  it("creates, hashes, verifies, and clones at exact baseSha", async () => {
    const fixture = await createProjectFixture();
    await fixture.initGit({ branch: "main" });
    const baseSha = (await fixture.git("rev-parse", "HEAD")).trim();
    const transport = await transportDir();

    const seed = await createSeedBundle({
      controlRoot: fixture.root,
      transportDirectory: transport,
      baseSha,
    });
    expect(seed.baseSha).toBe(baseSha);
    expect(seed.bundleHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await hashFileSha256(seed.bundlePath)).toBe(seed.bundleHash);
    await verifySeedBundle(fixture.root, seed.bundlePath);

    const cloneRoot = await mkdtemp(path.join(tmpdir(), "ah-clone-"));
    await initializeCloneFromSeedBundle({
      workspacePath: cloneRoot,
      seedBundlePath: seed.bundlePath,
      baseSha,
      identity: {
        runId: "run-1",
        baseSha,
        seedBundleHash: seed.bundleHash,
        generation: 0,
        createdAt: new Date().toISOString(),
      },
    });

    expect((await git(cloneRoot, "rev-parse", "HEAD")).trim()).toBe(baseSha);
    expect((await git(cloneRoot, "remote")).trim()).toBe("");
    const identity = await readCloneIdentity(cloneRoot);
    expect(identity?.baseSha).toBe(baseSha);
    expect(identity?.seedBundleHash).toBe(seed.bundleHash);

    const exclude = await readFile(path.join(cloneRoot, ".git", "info", "exclude"), "utf8");
    expect(exclude).toMatch(/\.gitnexus\//);
    expect(exclude).toMatch(/\.codegraph\//);

    await assertCloneReopenInvariants({
      workspacePath: cloneRoot,
      expected: {
        runId: "run-1",
        baseSha,
        seedBundleHash: seed.bundleHash,
        generation: 0,
      },
    });

    await fixture.cleanup();
  });

  it("rejects submodule repositories under default policy", async () => {
    const fixture = await createProjectFixture();
    await fixture.initGit({ branch: "main" });
    await writeFile(
      path.join(fixture.root, ".gitmodules"),
      '[submodule "vendor"]\n\tpath = vendor\n\turl = https://example.com/vendor.git\n',
    );
    await fixture.git("add", ".gitmodules");
    await fixture.git("commit", "-m", "add submodule metadata");
    const baseSha = (await fixture.git("rev-parse", "HEAD")).trim();
    await expect(
      assertUnsupportedGitFeaturesRejected(fixture.root, baseSha, {
        submodules: "reject",
        lfs: "reject",
      }),
    ).rejects.toMatchObject({
      name: "HarnessFailure",
      message: expect.stringMatching(/submodule/i),
    });
    await fixture.cleanup();
  });

  it("rejects LFS attribute repositories under default policy", async () => {
    const fixture = await createProjectFixture();
    await fixture.initGit({ branch: "main" });
    await writeFile(path.join(fixture.root, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    await fixture.git("add", ".gitattributes");
    await fixture.git("commit", "-m", "declare lfs");
    const baseSha = (await fixture.git("rev-parse", "HEAD")).trim();
    await expect(
      assertUnsupportedGitFeaturesRejected(fixture.root, baseSha, {
        submodules: "reject",
        lfs: "reject",
      }),
    ).rejects.toMatchObject({
      name: "HarnessFailure",
      message: expect.stringMatching(/LFS/i),
    });
    await fixture.cleanup();
  });
});

describe("DockerCloneProvisioner lifecycle (fake Docker)", () => {
  it("overrides the worker entrypoint for one-shot seed initialization", async () => {
    const fixture = await createProjectFixture({
      config: {
        execution: {
          runtime: "docker",
          docker: { sandboxRequired: false },
        },
      },
    });
    await fixture.initGit({ branch: "main" });
    const docker = createFakeDockerClient({ healthy: true });
    const provisioner = new DockerCloneProvisioner({
      config: fixture.config,
      paths: {
        controlRoot: fixture.root,
        stateRoot: path.join(fixture.root, ".agent-harness"),
        workspaceRoot: fixture.root,
        worktreeRoot: path.join(fixture.root, ".agent-harness", "worktrees"),
      },
      store: {
        withWorkspaceAdminLock: async <T>(_h: unknown, work: () => Promise<T>) => work(),
      } as never,
      docker,
      projectKey: "demo",
      resolveImageDigest: async () => `sha256:${"d".repeat(64)}`,
    });

    await provisioner.create({ runId: "run-init-entrypoint", baseBranch: "main" });

    const init = docker.calls.find(
      (call) => call.args[0] === "run" && call.args.includes("workspace-init"),
    );
    expect(init?.args).toEqual(
      expect.arrayContaining([
        "--entrypoint",
        "/opt/agent-harness/cli",
        `sha256:${"d".repeat(64)}`,
        "workspace-init",
        "--workspace",
        "/workspace",
      ]),
    );
    expect(init?.args).not.toContain("agent-harness");
    await fixture.cleanup();
  });

  it("provisions a host-materialized clone at exact baseSha and reopens", async () => {
    const fixture = await createProjectFixture({
      config: {
        execution: {
          runtime: "docker",
          docker: {
            sandboxRequired: false,
            workerImageDigest:
              "ghcr.io/example/worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            approvedBaseImages: [
              "node:22-bookworm@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            ],
          },
        },
      },
    });
    await fixture.initGit({ branch: "main" });
    const baseSha = (await fixture.git("rev-parse", "HEAD")).trim();
    const stateRoot = path.join(fixture.root, ".agent-harness");
    const materializeRoot = await mkdtemp(path.join(tmpdir(), "ah-mat-"));
    const docker = createFakeDockerClient({
      healthy: true,
      images: new Map([
        [
          "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          {
            id: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            digest: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            repoTags: ["project:run"],
          },
        ],
      ]),
    });

    const store = {
      withWorkspaceAdminLock: async <T>(_h: unknown, work: () => Promise<T>) => work(),
    } as never;

    const provisioner = new DockerCloneProvisioner({
      config: fixture.config,
      paths: {
        controlRoot: fixture.root,
        stateRoot,
        workspaceRoot: fixture.root,
        worktreeRoot: path.join(stateRoot, "worktrees"),
      },
      store,
      docker,
      projectKey: "demo",
      hostMaterializeRoot: materializeRoot,
      resolveImageDigest: async () =>
        "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    });

    const workspace = await provisioner.create({
      runId: "run-abc",
      baseBranch: "main",
    });
    expect(workspace.kind).toBe("docker-clone");
    if (workspace.kind !== "docker-clone") throw new Error("expected docker-clone");
    expect(workspace.baseSha).toBe(baseSha);
    expect(workspace.workspacePath).toBe(WORKER_WORKSPACE_PATH);
    expect(workspace.seedBundleHash).toMatch(/^sha256:/);
    expect(docker.volumes.has(workspace.workspaceVolumeName)).toBe(true);

    const opened = await provisioner.open(workspace);
    expect(opened.kind).toBe("docker-clone");
    const inspection = await provisioner.inspect(workspace);
    expect(inspection.headSha).toBe(baseSha);
    expect(inspection.path).toBe(WORKER_WORKSPACE_PATH);

    await fixture.cleanup();
  });

  it("blocks reopen when the named volume is missing (no silent reseed)", async () => {
    const docker = createFakeDockerClient({ healthy: true });
    const provisioner = new DockerCloneProvisioner({
      config: HarnessConfigSchema.parse({
        repositoryRoot: ".",
        execution: { runtime: "docker" },
      }),
      paths: {
        controlRoot: "/repo",
        stateRoot: "/state",
        workspaceRoot: "/repo",
        worktreeRoot: "/worktrees",
      },
      store: {
        withWorkspaceAdminLock: async <T>(_h: unknown, work: () => Promise<T>) => work(),
      } as never,
      docker,
      hostMaterializeRoot: await mkdtemp(path.join(tmpdir(), "ah-mat-missing-")),
    });
    await expect(
      provisioner.open({
        version: 1,
        kind: "docker-clone",
        controlRoot: "/repo",
        containerName: "ah-demo-run",
        workspaceVolumeName: "missing-volume",
        workspacePath: "/workspace",
        imageDigest: "sha256:x",
        baseSha: "abc",
        seedBundleHash: "sha256:y",
        generation: 0,
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({
      name: "HarnessFailure",
      message: expect.stringMatching(/volume .* missing|cannot be recovered by reseeding/i),
    });
  });
});

describe("Docker path model + architecture guards", () => {
  it("keeps docker-clone execution root at /workspace", () => {
    expect(
      resolveExecutionWorkspaceRoot(
        {
          version: 1,
          kind: "docker-clone",
          controlRoot: "/repo",
          containerName: "c",
          workspaceVolumeName: "v",
          workspacePath: "/workspace",
          imageDigest: "sha256:x",
          baseSha: "abc",
          seedBundleHash: "h",
          generation: 0,
          createdAt: "2026-08-10T12:00:00.000Z",
        },
        "/repo",
      ),
    ).toBe(WORKER_WORKSPACE_PATH);
  });

  it("isolation forbids /run/secrets as writable and lists it for Docker paths", () => {
    const paths = {
      controlRoot: path.resolve("/tmp/repo"),
      stateRoot: path.resolve("/tmp/state"),
      workspaceRoot: WORKER_WORKSPACE_PATH,
      worktreeRoot: path.resolve("/tmp/worktrees"),
    };
    const ok = checkWorkspaceIsolation({
      paths,
      homeRoot: path.resolve("/tmp/home"),
      strictIsolation: false,
      capabilities: { canRestrictWritableWorkspace: true, providerId: "cursor" },
      agentCwd: WORKER_WORKSPACE_PATH,
      containerExecution: true,
    });
    expect(ok.ok).toBe(true);
    expect(forbiddenAgentWritableRoots(paths, path.resolve("/tmp/home"))).toEqual(
      expect.arrayContaining(["/run/secrets"]),
    );
    expect(
      checkWorkspaceIsolation({
        paths,
        homeRoot: path.resolve("/tmp/home"),
        strictIsolation: false,
        capabilities: { canRestrictWritableWorkspace: true, providerId: "cursor" },
        agentCwd: "/run/secrets",
        containerExecution: true,
      }).ok,
    ).toBe(false);
  });

  it("does not infer filesystem access from Docker tool argument text", () => {
    expect(
      prohibitedAgentPathAccess({ path: "/run-state/config.json" }, WORKER_WORKSPACE_PATH),
    ).toBeUndefined();
    expect(
      prohibitedAgentPathAccess({ path: "/etc/passwd" }, WORKER_WORKSPACE_PATH),
    ).toBeUndefined();
    expect(
      prohibitedAgentPathAccess({ text: "/t claim" }, WORKER_WORKSPACE_PATH),
    ).toBeUndefined();
    expect(
      prohibitedAgentPathAccess({ path: "/workspace/src/main.ts" }, WORKER_WORKSPACE_PATH),
    ).toBeUndefined();
  });

  it("never passes CURSOR_API_KEY into project command environments", () => {
    const previous = process.env.CURSOR_API_KEY;
    process.env.CURSOR_API_KEY = "secret-key-value-xyz";
    try {
      const built = buildCommandEnvironment({ passEnv: ["PATH", "CURSOR_API_KEY"] });
      expect(built.env.CURSOR_API_KEY).toBeUndefined();
      expect(built.redactions).toEqual(expect.arrayContaining(["secret-key-value-xyz"]));
    } finally {
      if (previous === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = previous;
    }
  });

  it("wires Docker runtime to DockerCloneProvisioner without host worktree fallback", () => {
    const config = HarnessConfigSchema.parse({
      repositoryRoot: ".",
      execution: { runtime: "docker" },
    });
    const deps = createApplicationDependencies(config, {
      backend: createFakeBackend({}),
      docker: createFakeDockerClient({ healthy: true }),
    });
    expect(deps.workspaceProvisioner.runtime).toBe("docker");
    expect(deps.commands).toBeDefined();
    // Architecture: Docker mode must not resolve the local worktree provisioner.
    expect(deps.workspaceProvisioner.runtime).not.toBe("local");
  });
});

describe("resolveBaseSha", () => {
  it("freezes branch tip to a full commit SHA", async () => {
    const fixture = await createProjectFixture();
    await fixture.initGit({ branch: "main" });
    const expected = (await fixture.git("rev-parse", "HEAD")).trim();
    await expect(resolveBaseSha(fixture.root, { baseBranch: "main" })).resolves.toBe(expected);
    await fixture.cleanup();
  });
});
