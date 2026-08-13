import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  runExecutionImageDirectory,
  runTransportDirectory,
  WORKER_WORKSPACE_PATH,
  type HarnessPaths,
} from "../application/paths.js";
import { defaultContainerName } from "../application/docker-worker-session.js";
import type { HarnessConfig } from "../config/schema.js";
import {
  WORKSPACE_SCHEMA_VERSION,
  canonicalizeWorkspacePath,
  type DockerCloneWorkspace,
  type RunWorkspace,
} from "../domain/workspace.js";
import { HarnessFailure } from "../errors.js";
import {
  assertCloneReopenInvariants,
  assertUnsupportedGitFeaturesRejected,
  createSeedBundle,
  initializeCloneFromSeedBundle,
  resolveBaseSha,
  verifySeedBundle,
} from "../git/bundle-transport.js";
import type { WorktreeInspection } from "../git/worktree-manager.js";
import {
  HARNESS_CONTAINER_LABEL_PREFIX,
} from "../infrastructure/container/container-spec.js";
import type { DockerClient } from "../infrastructure/container/types.js";
import type { RunStore } from "../store.js";
import type {
  CreateWorkspaceInput,
  WorkspaceCleanupInspection,
  WorkspaceProvisioner,
} from "./types.js";

export type MaterializeDockerCloneInput = {
  hostWorkspacePath: string;
  seedBundleHostPath: string;
  baseSha: string;
  runId: string;
  seedBundleHash: string;
  generation: number;
};

export type DockerCloneProvisionerOptions = {
  config: HarnessConfig;
  paths: HarnessPaths;
  store: RunStore;
  docker: DockerClient;
  projectKey?: string;
  /**
   * Test / offline seam: materialize the clone on the host under this root
   * (`<root>/<volumeName>/`) instead of `docker run` against a named volume.
   * Fake Docker clients still receive volume create / inspect calls.
   */
  hostMaterializeRoot?: string;
  /** Override image digest resolution (tests). */
  resolveImageDigest?: (runId: string) => Promise<string>;
  /** Override clone materialization (tests). */
  materializeClone?: (input: MaterializeDockerCloneInput) => Promise<void>;
};

/**
 * Docker execution runtime: seed-bundle → named volume clone at exact baseSha (ADR 0015).
 */
export class DockerCloneProvisioner implements WorkspaceProvisioner {
  readonly runtime = "docker" as const;

  constructor(private readonly options: DockerCloneProvisionerOptions) {}

  async create(input: CreateWorkspaceInput): Promise<RunWorkspace> {
    const controlRoot = path.resolve(this.options.paths.controlRoot);
    const stateRoot = path.resolve(this.options.paths.stateRoot);
    const policy = this.options.config.execution.docker.submoduleLfs;

    return this.options.store.withWorkspaceAdminLock(
      { runId: input.runId, action: "create-docker-clone" },
      async () => {
        const baseSha = await resolveBaseSha(controlRoot, {
          baseBranch: input.baseBranch,
          baseSha: input.baseSha,
        });
        await assertUnsupportedGitFeaturesRejected(controlRoot, baseSha, {
          submodules: policy.submodules,
          lfs: policy.lfs,
        });

        const imageDigest = await (this.options.resolveImageDigest?.(input.runId) ??
          resolveRunImageDigest(stateRoot, input.runId, this.options.docker));

        if (this.options.config.execution.docker.sandboxRequired !== false) {
          const {
            loadSandboxIsolationProbeCache,
            findCachedSandboxIsolationProbe,
            assertSandboxIsolationProbePassed,
          } = await import("../application/sandbox-isolation-probe.js");
          const cache = await loadSandboxIsolationProbeCache(stateRoot);
          const cached = findCachedSandboxIsolationProbe(cache, imageDigest);
          assertSandboxIsolationProbePassed(cached, imageDigest);
        }

        const transportDir = runTransportDirectory(stateRoot, input.runId);
        const seed = await createSeedBundle({
          controlRoot,
          transportDirectory: transportDir,
          baseSha,
        });
        await verifySeedBundle(controlRoot, seed.bundlePath);

        const projectKey = this.options.projectKey ?? "project";
        const containerName = defaultContainerName(projectKey, input.runId);
        const workspaceVolumeName = defaultWorkspaceVolumeName(projectKey, input.runId);
        const generation = 0;

        await this.ensureVolume(workspaceVolumeName);

        const hostWorkspacePath = this.hostMaterializePath(workspaceVolumeName);
        const materializeInput: MaterializeDockerCloneInput = {
          hostWorkspacePath,
          seedBundleHostPath: seed.bundlePath,
          baseSha,
          runId: input.runId,
          seedBundleHash: seed.bundleHash,
          generation,
        };
        if (this.options.materializeClone) {
          await this.options.materializeClone(materializeInput);
        } else if (this.options.hostMaterializeRoot) {
          await mkdir(hostWorkspacePath, { recursive: true });
          await initializeCloneFromSeedBundle({
            workspacePath: hostWorkspacePath,
            seedBundlePath: seed.bundlePath,
            baseSha,
            identity: {
              runId: input.runId,
              baseSha,
              seedBundleHash: seed.bundleHash,
              generation,
              createdAt: new Date().toISOString(),
            },
          });
        } else {
          await this.materializeViaInitContainer({
            ...materializeInput,
            workspaceVolumeName,
            imageDigest,
          });
        }

        return {
          version: WORKSPACE_SCHEMA_VERSION,
          kind: "docker-clone" as const,
          controlRoot: canonicalizeWorkspacePath(controlRoot),
          containerName,
          workspaceVolumeName,
          workspacePath: WORKER_WORKSPACE_PATH,
          imageDigest,
          baseSha,
          seedBundleHash: seed.bundleHash,
          generation,
          baseBranch: input.baseBranch,
          ...(input.branchName ? { branchName: input.branchName } : {}),
          createdAt: input.createdAt ?? new Date().toISOString(),
        };
      },
    );
  }

  async open(workspace: RunWorkspace): Promise<RunWorkspace> {
    if (workspace.kind !== "docker-clone") {
      throw new HarnessFailure(
        "Cannot open a non-docker-clone workspace with DockerCloneProvisioner",
        "workspace",
        false,
      );
    }

    const volume = await this.options.docker.inspectVolume(workspace.workspaceVolumeName);
    if (!volume) {
      throw new HarnessFailure(
        `Docker workspace volume ${workspace.workspaceVolumeName} is missing. ` +
          "Unpublished work cannot be recovered by reseeding; restore the volume or explicitly discard the run.",
        "execution",
        true,
      );
    }

    const inspected = await this.options.docker.inspectContainer?.(workspace.containerName);
    if (inspected) {
      this.assertContainerLabels(inspected.labels, workspace);
      await this.assertImageDigestCompatible(inspected.image, workspace.imageDigest);
    }
    // Missing container is recoverable: worker session may recreate against the retained volume.

    if (this.usesHostMaterialize()) {
      await assertCloneReopenInvariants({
        workspacePath: this.hostMaterializePath(workspace.workspaceVolumeName),
        expected: {
          baseSha: workspace.baseSha,
          seedBundleHash: workspace.seedBundleHash,
          generation: workspace.generation,
        },
      });
    } else {
      await this.probeVolumeClone(workspace);
    }

    return workspace;
  }

  async inspect(workspace: RunWorkspace): Promise<WorktreeInspection> {
    if (workspace.kind !== "docker-clone") {
      throw new HarnessFailure("Cannot inspect a non-docker-clone workspace", "workspace", false);
    }
    const facts = this.usesHostMaterialize()
      ? await assertCloneReopenInvariants({
          workspacePath: this.hostMaterializePath(workspace.workspaceVolumeName),
          expected: {
            baseSha: workspace.baseSha,
            seedBundleHash: workspace.seedBundleHash,
            generation: workspace.generation,
          },
        })
      : await this.probeVolumeClone(workspace);
    return {
      path: WORKER_WORKSPACE_PATH,
      toplevel: WORKER_WORKSPACE_PATH,
      headSha: facts.headSha,
      gitCommonDir: `${WORKER_WORKSPACE_PATH}/.git`,
      detached: true,
      registered: true,
    };
  }

  async inspectCleanupTarget(workspace: RunWorkspace): Promise<WorkspaceCleanupInspection> {
    if (workspace.kind !== "docker-clone") {
      return {
        pathValid: false,
        registered: false,
        gitCommonDirMatches: false,
        dirty: false,
        headSha: undefined,
        commitsReachableFromRetainedRef: false,
      };
    }
    const volume = await this.options.docker.inspectVolume(workspace.workspaceVolumeName);
    if (!volume) {
      return {
        pathValid: false,
        registered: false,
        gitCommonDirMatches: false,
        dirty: false,
        headSha: undefined,
        commitsReachableFromRetainedRef: false,
      };
    }
    try {
      const facts = this.usesHostMaterialize()
        ? await assertCloneReopenInvariants({
            workspacePath: this.hostMaterializePath(workspace.workspaceVolumeName),
            expected: {
              baseSha: workspace.baseSha,
              seedBundleHash: workspace.seedBundleHash,
              generation: workspace.generation,
            },
          })
        : await this.probeVolumeClone(workspace);
      return {
        pathValid: true,
        registered: true,
        gitCommonDirMatches: true,
        dirty: facts.dirty,
        headSha: facts.headSha,
        commitsReachableFromRetainedRef: true,
      };
    } catch {
      return {
        pathValid: true,
        registered: true,
        gitCommonDirMatches: false,
        dirty: true,
        headSha: undefined,
        commitsReachableFromRetainedRef: false,
      };
    }
  }

  async remove(
    workspace: RunWorkspace,
    _runId: string,
    options?: { removeVolume?: boolean },
  ): Promise<void> {
    if (workspace.kind !== "docker-clone") return;
    const inspected = await this.options.docker.inspectContainer?.(workspace.containerName);
    if (inspected) {
      await this.options.docker.exec(["rm", "-f", workspace.containerName]);
    }
    if (options?.removeVolume) {
      const volume = await this.options.docker.inspectVolume(workspace.workspaceVolumeName);
      if (volume) {
        await this.options.docker.exec(["volume", "rm", "-f", workspace.workspaceVolumeName]);
      }
    }
  }

  private usesHostMaterialize(): boolean {
    return Boolean(this.options.hostMaterializeRoot || this.options.materializeClone);
  }

  private hostMaterializePath(volumeName: string): string {
    if (this.options.hostMaterializeRoot) {
      return path.join(this.options.hostMaterializeRoot, volumeName);
    }
    return path.join(this.options.paths.stateRoot, ".docker-clone-mirror", volumeName);
  }

  private async ensureVolume(name: string): Promise<void> {
    const existing = await this.options.docker.inspectVolume(name);
    if (existing) return;
    const result = await this.options.docker.exec(["volume", "create", name]);
    if (result.exitCode !== 0) {
      throw new HarnessFailure(
        `Failed to create workspace volume ${name}: ${result.stderr || result.stdout}`,
        "execution",
        true,
      );
    }
  }

  private async materializeViaInitContainer(
    input: MaterializeDockerCloneInput & {
      workspaceVolumeName: string;
      imageDigest: string;
    },
  ): Promise<void> {
    const initName = `${defaultContainerName(this.options.projectKey ?? "project", input.runId)}-init`.slice(
      0,
      63,
    );
    // Seed mount is init-only; the long-lived worker never remounts the seed bundle.
    const argv = [
      "run",
      "--rm",
      "--name",
      initName,
      "--network",
      "none",
      "--user",
      "10001:10001",
      "--mount",
      `type=volume,source=${input.workspaceVolumeName},target=${WORKER_WORKSPACE_PATH}`,
      "--mount",
      `type=bind,source=${input.seedBundleHostPath},target=/seed.bundle,readonly`,
      input.imageDigest,
      "agent-harness",
      "workspace-init",
      "--workspace",
      WORKER_WORKSPACE_PATH,
      "--seed-bundle",
      "/seed.bundle",
      "--base-sha",
      input.baseSha,
      "--run-id",
      input.runId,
      "--seed-bundle-hash",
      input.seedBundleHash,
      "--generation",
      String(input.generation),
    ];
    const result = await this.options.docker.exec(argv, { timeoutMs: 10 * 60 * 1000 });
    if (result.exitCode !== 0) {
      throw new HarnessFailure(
        `Docker seed-clone init failed: ${result.stderr || result.stdout}`,
        "execution",
        true,
      );
    }
  }

  private assertContainerLabels(
    labels: Record<string, string>,
    _workspace: DockerCloneWorkspace,
  ): void {
    const managed = labels[`${HARNESS_CONTAINER_LABEL_PREFIX}.managed`];
    if (managed !== "true") {
      throw new HarnessFailure(
        `Container is missing harness managed label (${HARNESS_CONTAINER_LABEL_PREFIX}.managed=true)`,
        "execution",
        true,
      );
    }
  }

  private async assertImageDigestCompatible(
    containerImage: string,
    expectedDigest: string,
  ): Promise<void> {
    if (!containerImage || !expectedDigest) return;
    if (containerImage === expectedDigest) return;
    const image = await this.options.docker.inspectImage(containerImage);
    if (!image) return;
    const observed = image.digest
      ? image.digest.startsWith("sha256:")
        ? image.digest
        : `sha256:${image.digest}`
      : image.id;
    const expected = expectedDigest.startsWith("sha256:")
      ? expectedDigest
      : `sha256:${expectedDigest}`;
    if (
      observed !== expected &&
      image.id !== expectedDigest &&
      !(image.digest && expectedDigest.includes(image.digest.replace(/^sha256:/, "")))
    ) {
      throw new HarnessFailure(
        `Docker clone container image digest mismatch (expected ${expectedDigest}, observed ${observed})`,
        "execution",
        true,
      );
    }
  }

  private async probeVolumeClone(
    workspace: DockerCloneWorkspace,
  ): Promise<{ headSha: string; dirty: boolean }> {
    const probeName = `${workspace.containerName}-probe`.slice(0, 63);
    const argv = [
      "run",
      "--rm",
      "--name",
      probeName,
      "--network",
      "none",
      "--mount",
      `type=volume,source=${workspace.workspaceVolumeName},target=${WORKER_WORKSPACE_PATH}`,
      workspace.imageDigest,
      "agent-harness",
      "workspace-probe",
      "--workspace",
      WORKER_WORKSPACE_PATH,
      "--base-sha",
      workspace.baseSha,
      "--seed-bundle-hash",
      workspace.seedBundleHash,
      "--generation",
      String(workspace.generation),
    ];
    const result = await this.options.docker.exec(argv, { timeoutMs: 120_000 });
    if (result.exitCode !== 0) {
      throw new HarnessFailure(
        `Failed to probe Docker clone volume ${workspace.workspaceVolumeName}: ${result.stderr || result.stdout}`,
        "execution",
        true,
      );
    }
    try {
      const parsed = JSON.parse(result.stdout.trim()) as { headSha: string; dirty: boolean };
      if (!parsed.headSha) throw new Error("missing headSha");
      return { headSha: parsed.headSha, dirty: Boolean(parsed.dirty) };
    } catch {
      throw new HarnessFailure(
        `Unreadable Docker clone probe output for volume ${workspace.workspaceVolumeName}`,
        "execution",
        true,
      );
    }
  }
}

export function defaultWorkspaceVolumeName(projectKey: string, runId: string): string {
  const safeProject = projectKey.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 40);
  const safeRun = runId.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 40);
  return `ah-ws-${safeProject}-${safeRun}`.toLowerCase().slice(0, 63);
}

async function resolveRunImageDigest(
  stateRoot: string,
  runId: string,
  docker: DockerClient,
): Promise<string> {
  const artifactsDir = runExecutionImageDirectory(stateRoot, runId);
  const digestPath = path.join(artifactsDir, "image.digest");
  try {
    await access(digestPath);
    const digest = (await readFile(digestPath, "utf8")).trim();
    if (!digest) {
      throw new HarnessFailure(
        "execution-image/image.digest is empty; approve and build the generated image before creating a Docker clone.",
        "execution",
        true,
      );
    }
    const exists = await docker.imageExists(digest);
    if (!exists) {
      throw new HarnessFailure(
        `Approved execution image digest ${digest} is not present locally. Rebuild before creating the Docker clone.`,
        "execution",
        true,
      );
    }
    return digest;
  } catch (error) {
    if (error instanceof HarnessFailure) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new HarnessFailure(
        "Docker clone requires a built execution image digest under runs/<runId>/execution-image/image.digest. " +
          "Approve and build the generated image first (isolation probe must pass when sandboxRequired).",
        "execution",
        true,
      );
    }
    throw error;
  }
}
