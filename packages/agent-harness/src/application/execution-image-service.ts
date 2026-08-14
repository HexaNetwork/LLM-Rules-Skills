import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, access, unlink } from "node:fs/promises";
import path from "node:path";
import {
  collectExecutionImageEvidence,
  hashExecutionImageProfile,
  canonicalProfileInputs,
  type ExecutionImageEvidence,
} from "./execution-image-evidence.js";
import {
  BASE_IMAGE_ALLOWLIST_VERSION,
  EXECUTION_IMAGE_GENERATOR_VERSION,
  computeExecutionImageCacheKey,
  generateExecutionDockerfile,
  type GeneratedExecutionImage,
} from "./execution-image-generator.js";
import {
  validateExecutionDockerfile,
  type DockerfileValidationReport,
} from "./execution-image-validate.js";
import {
  runExecutionImageDirectory,
  projectExecutionImageCachePath,
} from "./paths.js";
import type { HarnessConfig } from "../config/schema.js";
import type { DockerClient } from "../infrastructure/container/types.js";
import { HarnessFailure } from "../errors.js";

export type ExecutionImageApprovalRecord = {
  approvedAt: string;
  profileHash: string;
  dockerfileHash: string;
  cacheKey: string;
  baseImage: string;
  workerImage: string;
  /** Local image id/digest after a successful build, when known. */
  imageDigest?: string;
};

export type ProjectExecutionImageCache = {
  version: 1;
  updatedAt: string;
  entries: ExecutionImageApprovalRecord[];
};

export type ExecutionImageArtifacts = {
  directory: string;
  dockerfilePath: string;
  dockerignorePath: string;
  profilePath: string;
  profileHashPath: string;
  dockerfileHashPath: string;
  validationPath: string;
  buildLogPath: string;
  digestPath: string;
  approvalPath: string;
};

export type ExecutionImagePrepareResult =
  | {
      status: "ready";
      evidence: ExecutionImageEvidence;
      generated: GeneratedExecutionImage;
      validation: DockerfileValidationReport;
      cacheKey: string;
      artifacts: ExecutionImageArtifacts;
      imageDigest?: string;
      reusedFromCache: boolean;
    }
  | {
      status: "needs-approval";
      evidence: ExecutionImageEvidence;
      generated: GeneratedExecutionImage;
      validation: DockerfileValidationReport;
      cacheKey: string;
      artifacts: ExecutionImageArtifacts;
      reason: string;
    }
  | {
      status: "blocked";
      evidence: ExecutionImageEvidence;
      reason: string;
      artifacts?: ExecutionImageArtifacts;
      validation?: DockerfileValidationReport;
    };

export type PrepareExecutionImageOptions = {
  config: HarnessConfig;
  stateRoot: string;
  runId: string;
  /** Project state root for cache metadata (harness home project dir). */
  projectStateRoot?: string;
  repositoryRoot?: string;
  docker?: DockerClient;
  /** When true, treat matching prior approval as sufficient without re-prompt. */
  autoReuseApproved?: boolean;
  now?: () => Date;
  platform?: string;
};

/** Stable operator-facing gate when Dockerfile exists but digest is not yet built. */
export const EXECUTION_IMAGE_APPROVAL_REQUIRED_MESSAGE =
  "Generated execution image requires operator approval before Docker clone. Review runs/<runId>/execution-image/, then Approve and build.";

export type EnsureExecutionImageResult =
  | {
      status: "ready";
      imageDigest: string;
      reusedFromCache: boolean;
      prepared: Extract<ExecutionImagePrepareResult, { status: "ready" }>;
    }
  | {
      status: "needs-approval";
      reason: string;
      prepared: Extract<ExecutionImagePrepareResult, { status: "needs-approval" | "ready" }>;
    }
  | {
      status: "blocked";
      reason: string;
      prepared?: Extract<ExecutionImagePrepareResult, { status: "blocked" }>;
    };

/**
 * Deterministic profile → Dockerfile → validate → persist under runs/<id>/execution-image/.
 * Stops at an operator approval gate on first build, profile change, or Dockerfile edits.
 * Never writes a Dockerfile into the control checkout.
 */
export async function prepareExecutionImage(
  options: PrepareExecutionImageOptions,
): Promise<ExecutionImagePrepareResult> {
  const repositoryRoot = path.resolve(
    options.repositoryRoot ?? options.config.repositoryRoot,
  );
  const evidence = await collectExecutionImageEvidence(repositoryRoot);
  const artifacts = executionImageArtifactPaths(options.stateRoot, options.runId);
  await mkdir(artifacts.directory, { recursive: true });

  const workerImage = options.config.execution.docker.workerImageDigest?.trim() ?? "";
  const generated = generateExecutionDockerfile({
    evidence,
    approvedBaseImages: options.config.execution.docker.approvedBaseImages,
    workerImage,
    platform: options.platform,
  });

  if (!generated.ok) {
    await writeJson(path.join(artifacts.directory, "profile.json"), {
      evidence: canonicalProfileInputs(evidence),
      profileHash: hashExecutionImageProfile(evidence),
      failure: generated.failure,
    });
    await writeFile(
      artifacts.profileHashPath,
      `${hashExecutionImageProfile(evidence)}\n`,
      "utf8",
    );
    return {
      status: "blocked",
      evidence,
      reason: generated.failure.message,
      artifacts,
    };
  }

  const image = generated.image;
  // Preserve operator-edited Dockerfiles. Otherwise refresh when missing or when the
  // generator version advanced (stale v1 images lack isolation self-check packaging).
  const existingDockerfile = await readTextIfExists(artifacts.dockerfilePath);
  const existingProfile = await readJsonIfExists<Record<string, unknown>>(artifacts.profilePath);
  const operatorEdited = existingProfile?.operatorEdited === true;
  const existingGeneratorVersion = Number(existingProfile?.generatorVersion ?? NaN);
  const shouldRefreshDockerfile =
    existingDockerfile == null ||
    (!operatorEdited && existingGeneratorVersion !== EXECUTION_IMAGE_GENERATOR_VERSION);
  const dockerfile = shouldRefreshDockerfile ? image.dockerfile : existingDockerfile!;
  const dockerfileHash = createHash("sha256").update(dockerfile).digest("hex");
  const effective: GeneratedExecutionImage = {
    ...image,
    dockerfile,
    dockerfileHash,
  };
  const allowlist = [effective.workerImage, effective.baseImage];
  const validation = validateExecutionDockerfile(effective.dockerfile, { allowlist });
  const cacheKey = computeExecutionImageCacheKey({
    evidence,
    dockerfile: effective.dockerfile,
    workerImage: effective.workerImage,
    platform: effective.platform,
  });

  await persistGeneratedArtifacts(artifacts, evidence, effective, validation, {
    overwriteDockerfile: shouldRefreshDockerfile,
  });

  if (!validation.ok) {
    return {
      status: "blocked",
      evidence,
      reason: `Generated Dockerfile failed validation: ${validation.issues
        .map((issue) => issue.message)
        .join("; ")}`,
      artifacts,
      validation,
    };
  }

  const cache = options.projectStateRoot
    ? await loadProjectImageCache(options.projectStateRoot)
    : undefined;
  const prior = cache?.entries.find((entry) => entry.cacheKey === cacheKey);
  let imageDigest = prior?.imageDigest;

  if (prior?.imageDigest && options.docker) {
    const stillExists = await options.docker.imageExists(prior.imageDigest);
    if (!stillExists) {
      imageDigest = undefined;
    }
  }

  const approval = await readJsonIfExists<ExecutionImageApprovalRecord>(artifacts.approvalPath);
  const approved =
    (approval &&
      approval.profileHash === effective.profileHash &&
      approval.dockerfileHash === effective.dockerfileHash) ||
    (options.autoReuseApproved !== false &&
      prior &&
      prior.profileHash === effective.profileHash &&
      prior.dockerfileHash === effective.dockerfileHash &&
      Boolean(imageDigest ?? prior.imageDigest));

  if (approved) {
    return {
      status: "ready",
      evidence,
      generated: effective,
      validation,
      cacheKey,
      artifacts,
      imageDigest: imageDigest ?? prior?.imageDigest ?? approval?.imageDigest,
      reusedFromCache: Boolean(imageDigest ?? prior?.imageDigest),
    };
  }

  return {
    status: "needs-approval",
    evidence,
    generated: effective,
    validation,
    cacheKey,
    artifacts,
    reason:
      "Operator approval required for first build, changed profile, or generated Dockerfile edits.",
  };
}

/**
 * Persist an operator-edited Dockerfile under runs/<id>/execution-image/.
 * Rehashes, revalidates, updates profile metadata when present, and clears
 * prior approval + digest so the next build requires fresh approval.
 */
export async function saveExecutionDockerfile(input: {
  stateRoot: string;
  runId: string;
  dockerfile: string;
  /** Exact allowlisted image refs used for FROM validation (worker + base). */
  allowlist: readonly string[];
}): Promise<{
  dockerfileHash: string;
  validation: DockerfileValidationReport;
  clearedApproval: boolean;
}> {
  const artifacts = executionImageArtifactPaths(input.stateRoot, input.runId);
  const existing = await readTextIfExists(artifacts.dockerfilePath);
  if (existing == null) {
    throw new HarnessFailure(
      "No generated execution Dockerfile to edit. Wait for Docker setup to prepare execution-image artifacts first.",
      "execution",
      false,
    );
  }

  const dockerfile = normalizeDockerfileText(input.dockerfile);
  if (!dockerfile.trim()) {
    throw new HarnessFailure("Dockerfile cannot be empty.", "execution", false);
  }

  const dockerfileHash = createHash("sha256").update(dockerfile).digest("hex");
  const validation = validateExecutionDockerfile(dockerfile, {
    allowlist: input.allowlist,
  });

  const priorHash = (await readTextIfExists(artifacts.dockerfileHashPath))?.trim();
  const priorApproval = await readJsonIfExists<ExecutionImageApprovalRecord>(artifacts.approvalPath);
  const priorDigest = await readTextIfExists(artifacts.digestPath);

  await mkdir(artifacts.directory, { recursive: true });
  await writeFile(artifacts.dockerfilePath, dockerfile, "utf8");
  await writeFile(artifacts.dockerfileHashPath, `${dockerfileHash}\n`, "utf8");
  await writeJson(artifacts.validationPath, validation);

  const profile = await readJsonIfExists<Record<string, unknown>>(artifacts.profilePath);
  if (profile) {
    await writeJson(artifacts.profilePath, {
      ...profile,
      dockerfileHash,
      operatorEdited: true,
      operatorEditedAt: new Date().toISOString(),
    });
  }

  // Saving always invalidates approval/digest — operator must re-approve the new text.
  const hadApprovalOrDigest = Boolean(priorApproval || priorDigest);
  await unlinkIfExists(artifacts.approvalPath);
  await unlinkIfExists(artifacts.digestPath);

  if (!validation.ok) {
    throw new HarnessFailure(
      `Dockerfile failed validation: ${validation.issues.map((issue) => issue.message).join("; ")}`,
      "execution",
      false,
    );
  }

  return {
    dockerfileHash,
    validation,
    clearedApproval: hadApprovalOrDigest || Boolean(priorHash && priorHash !== dockerfileHash),
  };
}

/** Record operator approval for the current generated artifacts (does not build). */
export async function approveExecutionImage(input: {
  stateRoot: string;
  runId: string;
  projectStateRoot?: string;
  generated: GeneratedExecutionImage;
  cacheKey: string;
  imageDigest?: string;
  now?: () => Date;
}): Promise<ExecutionImageApprovalRecord> {
  const artifacts = executionImageArtifactPaths(input.stateRoot, input.runId);
  await mkdir(artifacts.directory, { recursive: true });
  const record: ExecutionImageApprovalRecord = {
    approvedAt: (input.now ?? (() => new Date()))().toISOString(),
    profileHash: input.generated.profileHash,
    dockerfileHash: input.generated.dockerfileHash,
    cacheKey: input.cacheKey,
    baseImage: input.generated.baseImage,
    workerImage: input.generated.workerImage,
    imageDigest: input.imageDigest,
  };
  await writeJson(artifacts.approvalPath, record);

  if (input.projectStateRoot) {
    const cache = await loadProjectImageCache(input.projectStateRoot);
    const entries = [
      record,
      ...cache.entries.filter((entry) => entry.cacheKey !== record.cacheKey),
    ].slice(0, 32);
    await saveProjectImageCache(input.projectStateRoot, {
      version: 1,
      updatedAt: record.approvedAt,
      entries,
    });
  }
  return record;
}

/**
 * Build the approved image via argv Docker client into a minimal generated context.
 * Requires prior approval matching the current Dockerfile hash.
 */
export async function buildApprovedExecutionImage(input: {
  stateRoot: string;
  runId: string;
  projectStateRoot?: string;
  docker: DockerClient;
  tag: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Docker execution policy (sandboxRequired, limits, network). Defaults to schema defaults. */
  dockerPolicy?: import("../config/schema.js").DockerExecutionPolicy;
  /** Test seam: inject probe executor (skip real Docker self-check). */
  isolationProbeExecutor?: import("./sandbox-isolation-probe.js").SandboxIsolationProbeExecutor;
  /** Test seam: skip probe entirely (prefer injecting a passing executor). */
  skipIsolationProbe?: boolean;
}): Promise<{ imageDigest: string; buildLog: string }> {
  const artifacts = executionImageArtifactPaths(input.stateRoot, input.runId);
  const approval = await readJsonIfExists<ExecutionImageApprovalRecord>(artifacts.approvalPath);
  if (!approval) {
    throw new HarnessFailure(
      "Cannot build execution image before operator approval.",
      "execution",
      false,
    );
  }
  const dockerfileHash = (await readFile(artifacts.dockerfileHashPath, "utf8")).trim();
  if (dockerfileHash !== approval.dockerfileHash) {
    throw new HarnessFailure(
      "Generated Dockerfile changed since approval; re-approve before building.",
      "execution",
      false,
    );
  }

  const result = await input.docker.build({
    contextDir: artifacts.directory,
    dockerfilePath: artifacts.dockerfilePath,
    tag: input.tag,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
  const buildLog = `${result.stdout}\n${result.stderr}`.trim();
  await writeFile(artifacts.buildLogPath, `${buildLog}\n`, "utf8");
  if (result.exitCode !== 0) {
    throw new HarnessFailure(
      `Execution image build failed (exit ${result.exitCode}). See execution-image/build.log.`,
      "execution",
      true,
    );
  }

  const inspected = await input.docker.inspectImage(input.tag);
  // Prefer local image Id for probe/run (always addressable). RepoDigests may be
  // empty for never-pushed builds or point at a registry digest that is not local.
  const imageDigest =
    inspected?.id ??
    inspected?.digest ??
    (() => {
      throw new HarnessFailure(
        `Build succeeded but image ${input.tag} could not be inspected for a digest.`,
        "execution",
        true,
      );
    })();

  await writeFile(artifacts.digestPath, `${imageDigest}\n`, "utf8");
  const updated: ExecutionImageApprovalRecord = { ...approval, imageDigest };
  await writeJson(artifacts.approvalPath, updated);
  if (input.projectStateRoot) {
    const cache = await loadProjectImageCache(input.projectStateRoot);
    const entries = [
      updated,
      ...cache.entries.filter((entry) => entry.cacheKey !== updated.cacheKey),
    ].slice(0, 32);
    await saveProjectImageCache(input.projectStateRoot, {
      version: 1,
      updatedAt: new Date().toISOString(),
      entries,
    });
  }

  // Fail-closed: accepting a digest requires a successful sandbox isolation probe
  // when sandboxRequired (default). Unsupported/failed probes reject the digest.
  if (input.skipIsolationProbe !== true) {
    try {
      const { ensureSandboxIsolationProbe, assertSandboxIsolationProbePassed } = await import(
        "./sandbox-isolation-probe.js"
      );
      const { HarnessConfigSchema } = await import("../config/schema.js");
      const dockerPolicy =
        input.dockerPolicy ?? HarnessConfigSchema.parse({}).execution.docker;
      const probeDir = path.join(artifacts.directory, "isolation-probe-run-state");
      const report = await ensureSandboxIsolationProbe({
        imageDigest,
        docker: input.docker,
        dockerPolicy,
        projectStateRoot: input.projectStateRoot,
        probeRunStateHostPath: probeDir,
        executor: input.isolationProbeExecutor,
        signal: input.signal,
      });
      assertSandboxIsolationProbePassed(report, imageDigest);
      // Durable stamp under the run directory (mounted at /run-state) so the worker
      // can advertise canRestrictWritableWorkspace without host project cache access.
      const runDir = path.dirname(artifacts.directory);
      await writeJson(path.join(runDir, "sandbox-isolation-probe.json"), {
        ok: report.ok,
        unsupported: report.unsupported,
        imageDigest: report.imageDigest,
        policyVersion: report.policyVersion,
        probedAt: report.probedAt,
      });
    } catch (error) {
      // Do not leave a digest that the UI treats as "built" when the probe rejected it.
      await unlinkIfExists(artifacts.digestPath);
      const clearedApproval: ExecutionImageApprovalRecord = { ...approval };
      delete clearedApproval.imageDigest;
      await writeJson(artifacts.approvalPath, clearedApproval);
      throw error;
    }
  }

  return { imageDigest, buildLog };
}

/**
 * Prepare artifacts and either materialize a reusable digest for this run or
 * stop at the operator approval gate. Call before Docker clone provisioning.
 */
export async function ensureExecutionImageForRun(
  options: PrepareExecutionImageOptions & {
    dockerPolicy?: import("../config/schema.js").DockerExecutionPolicy;
    isolationProbeExecutor?: import("./sandbox-isolation-probe.js").SandboxIsolationProbeExecutor;
    skipIsolationProbe?: boolean;
    signal?: AbortSignal;
  },
): Promise<EnsureExecutionImageResult> {
  const prepared = await prepareExecutionImage(options);
  if (prepared.status === "blocked") {
    return { status: "blocked", reason: prepared.reason, prepared };
  }

  if (prepared.status === "needs-approval") {
    return {
      status: "needs-approval",
      reason: EXECUTION_IMAGE_APPROVAL_REQUIRED_MESSAGE,
      prepared,
    };
  }

  const imageDigest = prepared.imageDigest?.trim();
  if (!imageDigest) {
    return {
      status: "needs-approval",
      reason: EXECUTION_IMAGE_APPROVAL_REQUIRED_MESSAGE,
      prepared,
    };
  }

  // Stamp per-run digest (and approval) so the provisioner does not depend on
  // project-cache lookup at clone time.
  await writeFile(prepared.artifacts.digestPath, `${imageDigest}\n`, "utf8");
  const existingApproval = await readJsonIfExists<ExecutionImageApprovalRecord>(
    prepared.artifacts.approvalPath,
  );
  if (
    !existingApproval ||
    existingApproval.dockerfileHash !== prepared.generated.dockerfileHash ||
    existingApproval.imageDigest !== imageDigest
  ) {
    await approveExecutionImage({
      stateRoot: options.stateRoot,
      runId: options.runId,
      projectStateRoot: options.projectStateRoot,
      generated: prepared.generated,
      cacheKey: prepared.cacheKey,
      imageDigest,
      now: options.now,
    });
  }

  const dockerPolicy =
    options.dockerPolicy ?? options.config.execution.docker;
  if (options.skipIsolationProbe !== true && dockerPolicy.sandboxRequired !== false) {
    if (!options.docker) {
      return {
        status: "blocked",
        reason:
          "Docker client is required to verify sandbox isolation for a cached execution image digest.",
      };
    }
    const { ensureSandboxIsolationProbe, assertSandboxIsolationProbePassed } = await import(
      "./sandbox-isolation-probe.js"
    );
    const probeDir = path.join(prepared.artifacts.directory, "isolation-probe-run-state");
    const report = await ensureSandboxIsolationProbe({
      imageDigest,
      docker: options.docker,
      dockerPolicy,
      projectStateRoot: options.projectStateRoot,
      probeRunStateHostPath: probeDir,
      executor: options.isolationProbeExecutor,
      signal: options.signal,
    });
    assertSandboxIsolationProbePassed(report, imageDigest);
    const runDir = path.dirname(prepared.artifacts.directory);
    await writeJson(path.join(runDir, "sandbox-isolation-probe.json"), {
      ok: report.ok,
      unsupported: report.unsupported,
      imageDigest: report.imageDigest,
      policyVersion: report.policyVersion,
      probedAt: report.probedAt,
    });
  }

  return {
    status: "ready",
    imageDigest,
    reusedFromCache: prepared.reusedFromCache,
    prepared,
  };
}

/**
 * Operator one-shot: prepare → approve → build (+ isolation probe).
 * Writes runs/<runId>/execution-image/image.digest on success.
 */
export async function approveAndBuildExecutionImage(input: {
  config: HarnessConfig;
  stateRoot: string;
  runId: string;
  projectStateRoot?: string;
  repositoryRoot?: string;
  docker: DockerClient;
  tag?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  dockerPolicy?: import("../config/schema.js").DockerExecutionPolicy;
  isolationProbeExecutor?: import("./sandbox-isolation-probe.js").SandboxIsolationProbeExecutor;
  skipIsolationProbe?: boolean;
  now?: () => Date;
  platform?: string;
}): Promise<{ imageDigest: string; buildLog: string }> {
  const prepared = await prepareExecutionImage({
    config: input.config,
    stateRoot: input.stateRoot,
    runId: input.runId,
    projectStateRoot: input.projectStateRoot,
    repositoryRoot: input.repositoryRoot,
    docker: input.docker,
    autoReuseApproved: false,
    now: input.now,
    platform: input.platform,
  });
  if (prepared.status === "blocked") {
    throw new HarnessFailure(prepared.reason, "execution", false);
  }
  if (!("generated" in prepared) || !prepared.generated) {
    throw new HarnessFailure("No generated execution image to approve.", "execution", false);
  }

  await approveExecutionImage({
    stateRoot: input.stateRoot,
    runId: input.runId,
    projectStateRoot: input.projectStateRoot,
    generated: prepared.generated,
    cacheKey: prepared.cacheKey,
    now: input.now,
  });

  return buildApprovedExecutionImage({
    stateRoot: input.stateRoot,
    runId: input.runId,
    projectStateRoot: input.projectStateRoot,
    docker: input.docker,
    tag: input.tag ?? `agent-harness-run-${input.runId}`.toLowerCase().slice(0, 128),
    timeoutMs: input.timeoutMs ?? input.config.execution.docker.buildTimeoutMs,
    signal: input.signal,
    dockerPolicy: input.dockerPolicy ?? input.config.execution.docker,
    isolationProbeExecutor: input.isolationProbeExecutor,
    skipIsolationProbe: input.skipIsolationProbe,
  });
}

export function executionImageArtifactPaths(
  stateRoot: string,
  runId: string,
): ExecutionImageArtifacts {
  const directory = runExecutionImageDirectory(stateRoot, runId);
  return {
    directory,
    dockerfilePath: path.join(directory, "Dockerfile"),
    dockerignorePath: path.join(directory, ".dockerignore"),
    profilePath: path.join(directory, "profile.json"),
    profileHashPath: path.join(directory, "profile.sha256"),
    dockerfileHashPath: path.join(directory, "Dockerfile.sha256"),
    validationPath: path.join(directory, "validation.json"),
    buildLogPath: path.join(directory, "build.log"),
    digestPath: path.join(directory, "image.digest"),
    approvalPath: path.join(directory, "approval.json"),
  };
}

async function persistGeneratedArtifacts(
  artifacts: ExecutionImageArtifacts,
  evidence: ExecutionImageEvidence,
  image: GeneratedExecutionImage,
  validation: DockerfileValidationReport,
  options: { overwriteDockerfile?: boolean } = {},
): Promise<void> {
  if (options.overwriteDockerfile !== false) {
    await writeFile(artifacts.dockerfilePath, image.dockerfile, "utf8");
  }
  await writeFile(artifacts.dockerignorePath, image.dockerignore, "utf8");
  await writeFile(artifacts.profileHashPath, `${image.profileHash}\n`, "utf8");
  await writeFile(artifacts.dockerfileHashPath, `${image.dockerfileHash}\n`, "utf8");
  await writeJson(artifacts.profilePath, {
    generatorVersion: EXECUTION_IMAGE_GENERATOR_VERSION,
    allowlistVersion: BASE_IMAGE_ALLOWLIST_VERSION,
    stack: image.stack,
    platform: image.platform,
    baseImage: image.baseImage,
    workerImage: image.workerImage,
    profileHash: image.profileHash,
    dockerfileHash: image.dockerfileHash,
    inputs: canonicalProfileInputs(evidence),
    evidence,
  });
  await writeJson(artifacts.validationPath, validation);
}

function normalizeDockerfileText(raw: string): string {
  const normalized = String(raw ?? "").replace(/\r\n/g, "\n");
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

export async function loadProjectImageCache(
  projectStateRoot: string,
): Promise<ProjectExecutionImageCache> {
  const filePath = projectExecutionImageCachePath(projectStateRoot);
  const existing = await readJsonIfExists<ProjectExecutionImageCache>(filePath);
  return existing ?? { version: 1, updatedAt: new Date(0).toISOString(), entries: [] };
}

async function saveProjectImageCache(
  projectStateRoot: string,
  cache: ProjectExecutionImageCache,
): Promise<void> {
  await mkdir(projectStateRoot, { recursive: true });
  await writeJson(projectExecutionImageCachePath(projectStateRoot), cache);
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJsonIfExists<T>(filePath: string): Promise<T | undefined> {
  try {
    await access(filePath);
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}
