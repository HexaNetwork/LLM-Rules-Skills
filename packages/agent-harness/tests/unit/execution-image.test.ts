import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectExecutionImageEvidence,
  hashExecutionImageProfile,
} from "../../src/application/execution-image-evidence.js";
import {
  BASE_IMAGE_ALLOWLIST_VERSION,
  EXECUTION_IMAGE_GENERATOR_VERSION,
  computeExecutionImageCacheKey,
  generateExecutionDockerfile,
  isDigestPinnedImageRef,
  resolveApprovedBaseImage,
} from "../../src/application/execution-image-generator.js";
import { validateExecutionDockerfile } from "../../src/application/execution-image-validate.js";
import {
  approveAndBuildExecutionImage,
  approveExecutionImage,
  ensureExecutionImageForRun,
  EXECUTION_IMAGE_APPROVAL_REQUIRED_MESSAGE,
  prepareExecutionImage,
} from "../../src/application/execution-image-service.js";
import { HarnessConfigSchema } from "../../src/config/schema.js";
import { createFakeDockerClient } from "../../src/infrastructure/container/fake-docker-client.js";

const WORKER =
  "ghcr.io/example/agent-harness-worker:1@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NODE_BASE =
  "node:22-bookworm@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("execution image evidence and hashing", () => {
  it("collects allowlisted manifests and detects a single node stack", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ah-img-ev-"));
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "demo", dependencies: { zod: "3.0.0" } }, null, 2),
      "utf8",
    );
    await writeFile(path.join(root, "package-lock.json"), "{}\n", "utf8");

    const evidence = await collectExecutionImageEvidence(root);
    expect(evidence.stacks).toEqual(["node"]);
    expect(evidence.ambiguous).toBe(false);
    expect(evidence.manifests.find((m) => m.path === "package.json")?.present).toBe(true);
    expect(hashExecutionImageProfile(evidence)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("marks multi-stack evidence as ambiguous", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ah-img-amb-"));
    await writeFile(path.join(root, "package.json"), '{"name":"a"}\n', "utf8");
    await writeFile(path.join(root, "go.mod"), "module example\n", "utf8");
    const evidence = await collectExecutionImageEvidence(root);
    expect(evidence.stacks.sort()).toEqual(["go", "node"]);
    expect(evidence.ambiguous).toBe(true);
  });
});

describe("dockerfile generation and allowlist validation", () => {
  it("resolves digest-pinned allowlist entries by family", () => {
    expect(isDigestPinnedImageRef(NODE_BASE)).toBe(true);
    expect(isDigestPinnedImageRef("node:22-bookworm")).toBe(false);
    expect(resolveApprovedBaseImage("node:22-bookworm", [NODE_BASE])).toBe(NODE_BASE);
  });

  it("generates a multi-stage Dockerfile without project source COPY", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ah-img-gen-"));
    await writeFile(path.join(root, "package.json"), '{"name":"demo"}\n', "utf8");
    const evidence = await collectExecutionImageEvidence(root);
    const result = generateExecutionDockerfile({
      evidence,
      approvedBaseImages: [NODE_BASE],
      workerImage: WORKER,
      platform: "linux/amd64",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.dockerfile).toContain(`FROM ${WORKER} AS harness-worker`);
    expect(result.image.dockerfile).toContain(`FROM ${NODE_BASE}`);
    expect(result.image.dockerfile).toMatch(/COPY --from=harness-worker/);
    expect(result.image.dockerfile).not.toMatch(/^COPY (?!--from=)/m);
    expect(result.image.generatorVersion).toBe(EXECUTION_IMAGE_GENERATOR_VERSION);
    expect(result.image.allowlistVersion).toBe(BASE_IMAGE_ALLOWLIST_VERSION);

    const validation = validateExecutionDockerfile(result.image.dockerfile, {
      allowlist: [WORKER, NODE_BASE],
    });
    expect(validation.ok).toBe(true);
    expect(validation.fromImages).toEqual([WORKER, NODE_BASE]);
  });

  it("rejects non-allowlisted FROM and secret ARG/ENV", () => {
    const bad = [
      "FROM evil/image@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "ARG API_KEY=secret",
      "ENV TOKEN=abc",
      "ADD https://example.com/x /x",
      "COPY . /workspace",
    ].join("\n");
    const report = validateExecutionDockerfile(bad, { allowlist: [NODE_BASE] });
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === "from-not-allowlisted")).toBe(true);
    expect(report.issues.some((i) => i.code === "secret-arg")).toBe(true);
    expect(report.issues.some((i) => i.code === "secret-env")).toBe(true);
    expect(report.issues.some((i) => i.code === "remote-add")).toBe(true);
    expect(report.issues.some((i) => i.code === "copies-project-source")).toBe(true);
  });

  it("stops at ambiguous stacks instead of falling back to a host agent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ah-img-stop-"));
    await writeFile(path.join(root, "package.json"), '{"name":"a"}\n', "utf8");
    await writeFile(path.join(root, "Cargo.toml"), "[package]\nname=\"a\"\n", "utf8");
    const evidence = await collectExecutionImageEvidence(root);
    const result = generateExecutionDockerfile({
      evidence,
      approvedBaseImages: [NODE_BASE],
      workerImage: WORKER,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("ambiguous");
  });

  it("derives a stable cache key from profile + generator + digests + dockerfile", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ah-img-cache-"));
    await writeFile(path.join(root, "package.json"), '{"name":"demo"}\n', "utf8");
    const evidence = await collectExecutionImageEvidence(root);
    const first = generateExecutionDockerfile({
      evidence,
      approvedBaseImages: [NODE_BASE],
      workerImage: WORKER,
      platform: "linux/amd64",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const key1 = computeExecutionImageCacheKey({
      evidence,
      dockerfile: first.image.dockerfile,
      workerImage: WORKER,
      platform: "linux/amd64",
    });
    const key2 = computeExecutionImageCacheKey({
      evidence,
      dockerfile: first.image.dockerfile,
      workerImage: WORKER,
      platform: "linux/amd64",
    });
    expect(key1).toBe(key2);
    const key3 = computeExecutionImageCacheKey({
      evidence,
      dockerfile: first.image.dockerfile,
      workerImage: WORKER,
      platform: "linux/arm64",
    });
    expect(key3).not.toBe(key1);
  });
});

describe("execution image prepare / approval artifacts", () => {
  it("persists artifacts under runs/<id>/execution-image and requires approval", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ah-img-prep-"));
    const stateRoot = await mkdtemp(path.join(tmpdir(), "ah-img-state-"));
    const projectState = await mkdtemp(path.join(tmpdir(), "ah-img-proj-"));
    await writeFile(path.join(root, "package.json"), '{"name":"demo"}\n', "utf8");

    const config = HarnessConfigSchema.parse({
      repositoryRoot: root,
      stateDirectory: stateRoot,
      execution: {
        runtime: "docker",
        docker: {
          workerImageDigest: WORKER,
          approvedBaseImages: [NODE_BASE],
        },
      },
    });

    const docker = createFakeDockerClient({ healthy: true });
    const prepared = await prepareExecutionImage({
      config,
      stateRoot,
      runId: "run-1",
      projectStateRoot: projectState,
      repositoryRoot: root,
      docker,
      autoReuseApproved: false,
    });
    expect(prepared.status).toBe("needs-approval");
    if (prepared.status === "blocked") throw new Error(prepared.reason);

    const dockerfile = await readFile(prepared.artifacts.dockerfilePath, "utf8");
    expect(dockerfile).toContain("FROM ");
    expect(prepared.artifacts.directory.replaceAll("\\", "/")).toContain(
      "runs/run-1/execution-image",
    );

    const approval = await approveExecutionImage({
      stateRoot,
      runId: "run-1",
      projectStateRoot: projectState,
      generated: prepared.generated,
      cacheKey: prepared.cacheKey,
      imageDigest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    });
    expect(approval.profileHash).toBe(prepared.generated.profileHash);

    docker.images.set(approval.imageDigest!, {
      id: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      repoTags: ["harness-run:run-1"],
    });

    const reused = await prepareExecutionImage({
      config,
      stateRoot,
      runId: "run-2",
      projectStateRoot: projectState,
      repositoryRoot: root,
      docker,
      autoReuseApproved: true,
    });
    expect(reused.status).toBe("ready");
    if (reused.status !== "ready") return;
    expect(reused.reusedFromCache).toBe(true);
  });

  it("ensureExecutionImageForRun stamps image.digest from project cache reuse", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ah-img-ens-"));
    const stateRoot = await mkdtemp(path.join(tmpdir(), "ah-img-ens-state-"));
    const projectState = await mkdtemp(path.join(tmpdir(), "ah-img-ens-proj-"));
    await writeFile(path.join(root, "package.json"), '{"name":"demo"}\n', "utf8");

    const config = HarnessConfigSchema.parse({
      repositoryRoot: root,
      stateDirectory: stateRoot,
      execution: {
        runtime: "docker",
        docker: {
          workerImageDigest: WORKER,
          approvedBaseImages: [NODE_BASE],
          sandboxRequired: false,
        },
      },
    });

    const digest =
      "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const docker = createFakeDockerClient({ healthy: true });
    docker.images.set(digest, {
      id: digest,
      digest,
      repoTags: ["harness-run:cached"],
    });

    const first = await prepareExecutionImage({
      config,
      stateRoot,
      runId: "seed",
      projectStateRoot: projectState,
      repositoryRoot: root,
      docker,
      autoReuseApproved: false,
    });
    expect(first.status).toBe("needs-approval");
    if (first.status === "blocked" || first.status === "needs-approval") {
      if (!("generated" in first)) throw new Error("missing generated");
      await approveExecutionImage({
        stateRoot,
        runId: "seed",
        projectStateRoot: projectState,
        generated: first.generated,
        cacheKey: first.cacheKey,
        imageDigest: digest,
      });
    }

    const ensured = await ensureExecutionImageForRun({
      config,
      stateRoot,
      runId: "run-fresh",
      projectStateRoot: projectState,
      repositoryRoot: root,
      docker,
      skipIsolationProbe: true,
    });
    expect(ensured.status).toBe("ready");
    if (ensured.status !== "ready") return;
    expect(ensured.imageDigest).toBe(digest);
    expect(ensured.reusedFromCache).toBe(true);
    const stamped = (
      await readFile(path.join(stateRoot, "runs", "run-fresh", "execution-image", "image.digest"), "utf8")
    ).trim();
    expect(stamped).toBe(digest);
  });

  it("ensureExecutionImageForRun returns needs-approval before a digest exists", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ah-img-gate-"));
    const stateRoot = await mkdtemp(path.join(tmpdir(), "ah-img-gate-state-"));
    await writeFile(path.join(root, "package.json"), '{"name":"demo"}\n', "utf8");
    const config = HarnessConfigSchema.parse({
      repositoryRoot: root,
      stateDirectory: stateRoot,
      execution: {
        runtime: "docker",
        docker: {
          workerImageDigest: WORKER,
          approvedBaseImages: [NODE_BASE],
        },
      },
    });
    const ensured = await ensureExecutionImageForRun({
      config,
      stateRoot,
      runId: "run-gate",
      repositoryRoot: root,
      docker: createFakeDockerClient({ healthy: true }),
      skipIsolationProbe: true,
    });
    expect(ensured.status).toBe("needs-approval");
    if (ensured.status !== "needs-approval") return;
    expect(ensured.reason).toBe(EXECUTION_IMAGE_APPROVAL_REQUIRED_MESSAGE);
  });

  it("approveAndBuildExecutionImage writes image.digest after operator approval", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ah-img-aab-"));
    const stateRoot = await mkdtemp(path.join(tmpdir(), "ah-img-aab-state-"));
    const projectState = await mkdtemp(path.join(tmpdir(), "ah-img-aab-proj-"));
    await writeFile(path.join(root, "package.json"), '{"name":"demo"}\n', "utf8");
    const config = HarnessConfigSchema.parse({
      repositoryRoot: root,
      stateDirectory: stateRoot,
      execution: {
        runtime: "docker",
        docker: {
          workerImageDigest: WORKER,
          approvedBaseImages: [NODE_BASE],
          sandboxRequired: false,
        },
      },
    });
    const docker = createFakeDockerClient({ healthy: true });
    const built = await approveAndBuildExecutionImage({
      config,
      stateRoot,
      runId: "run-build",
      projectStateRoot: projectState,
      repositoryRoot: root,
      docker,
      skipIsolationProbe: true,
    });
    expect(built.imageDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    const stamped = (
      await readFile(path.join(stateRoot, "runs", "run-build", "execution-image", "image.digest"), "utf8")
    ).trim();
    expect(stamped).toBe(built.imageDigest);
  });
});
