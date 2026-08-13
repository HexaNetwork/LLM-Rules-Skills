import type { HarnessConfig } from "../config/schema.js";
import { HarnessFailure } from "../errors.js";
import {
  createDockerClient,
  networkPolicyDocumentation,
  probeDockerReadiness,
  type DockerClient,
  type DockerReadinessReport,
} from "../infrastructure/container/index.js";
import {
  collectExecutionImageEvidence,
  type ExecutionImageEvidence,
} from "./execution-image-evidence.js";
import { generateExecutionDockerfile } from "./execution-image-generator.js";
import { isDigestPinnedImageRef } from "./execution-image-generator.js";

/**
 * Operator/UI-facing execution runtime status (slice 2 service API).
 * Full UI cards land in slice 7; this is enough to block Docker run creation.
 */
export type ExecutionRuntimeStatus = {
  runtime: "local" | "docker";
  ready: boolean;
  /** High-level blockers with remediation. */
  blockers: Array<{ code: string; message: string; remediation?: string }>;
  docker?: DockerReadinessReport;
  image?: {
    generatedImagesEnabled: boolean;
    workerImageConfigured: boolean;
    workerImageDigestPinned: boolean;
    approvedBaseImageCount: number;
    evidence?: Pick<ExecutionImageEvidence, "stacks" | "ambiguous">;
    canGenerate: boolean;
    generationMessage?: string;
  };
  networkNote?: string;
  /** Present for docker runtime when sandboxRequired; fail-closed until a probe passes. */
  sandboxIsolation?: {
    required: boolean;
    passed: boolean;
    unsupported?: boolean;
    reason?: string;
    imageDigest?: string;
  };
};

export type EvaluateExecutionRuntimeStatusOptions = {
  config: HarnessConfig;
  docker?: DockerClient;
  /** When false, skip Docker daemon probes (e.g. local runtime). Default: probe only for docker. */
  probeDocker?: boolean;
  /**
   * When probing Docker, whether to spawn the ephemeral alpine port-publish check.
   * Default true for fail-closed gates; UI bootstrap polls should pass false.
   */
  includePortBinding?: boolean;
  /** When true, also collect host stack evidence for image readiness. */
  collectEvidence?: boolean;
  repositoryRoot?: string;
  /** Project state root for sandbox isolation probe cache lookup. */
  projectStateRoot?: string;
  /** Known image digest to evaluate probe readiness against. */
  imageDigest?: string;
};

/**
 * Evaluate whether new runs may use the configured execution runtime.
 * Local mode is always ready from this gate; Docker mode requires CLI/daemon
 * readiness plus a resolvable generated-image policy.
 */
export async function evaluateExecutionRuntimeStatus(
  options: EvaluateExecutionRuntimeStatusOptions,
): Promise<ExecutionRuntimeStatus> {
  const runtime = options.config.execution?.runtime ?? "local";
  if (runtime === "local") {
    return { runtime: "local", ready: true, blockers: [] };
  }

  const blockers: ExecutionRuntimeStatus["blockers"] = [];
  const dockerPolicy = options.config.execution.docker;
  const worker = dockerPolicy.workerImageDigest?.trim() ?? "";
  const workerConfigured = worker.length > 0;
  const workerPinned = workerConfigured && isDigestPinnedImageRef(worker);

  if (!dockerPolicy.generatedImagesEnabled) {
    blockers.push({
      code: "generated-images-disabled",
      message: "execution.docker.generatedImagesEnabled is false.",
      remediation: "Enable generated images or set execution.runtime to local.",
    });
  }
  if (!workerConfigured) {
    blockers.push({
      code: "worker-image-missing",
      message: "execution.docker.workerImageDigest is not set.",
      remediation: "Configure a digest-pinned maintained worker image.",
    });
  } else if (!workerPinned) {
    blockers.push({
      code: "worker-image-not-pinned",
      message: "execution.docker.workerImageDigest must be digest-pinned (name@sha256:…).",
      remediation: "Replace the worker image reference with a digest-pinned value.",
    });
  }
  if (dockerPolicy.approvedBaseImages.length === 0) {
    blockers.push({
      code: "base-images-empty",
      message: "execution.docker.approvedBaseImages is empty.",
      remediation:
        "Run `agent-harness execution approve-base --all --write-settings` to pin the shared harness-home toolchain catalog, or add digest-pinned bases in Settings.",
    });
  }

  let dockerReport: DockerReadinessReport | undefined;
  const shouldProbe = options.probeDocker !== false;
  if (shouldProbe) {
    const client = options.docker ?? createDockerClient();
    dockerReport = await probeDockerReadiness(client, {
      includePortBinding: options.includePortBinding,
    });
    if (!dockerReport.ready) {
      for (const check of dockerReport.checks.filter((item) => !item.ok)) {
        blockers.push({
          code: `docker-${check.id}`,
          message: check.detail,
          remediation: check.remediation,
        });
      }
    }
  }

  let evidenceSummary: ExecutionRuntimeStatus["image"];
  let canGenerate = false;
  let generationMessage: string | undefined;
  let evidenceStacks: ExecutionImageEvidence["stacks"] | undefined;
  let ambiguous: boolean | undefined;

  if (options.collectEvidence !== false) {
    const evidence = await collectExecutionImageEvidence(
      options.repositoryRoot ?? options.config.repositoryRoot,
    );
    evidenceStacks = evidence.stacks;
    ambiguous = evidence.ambiguous;
    const generated = generateExecutionDockerfile({
      evidence,
      approvedBaseImages: dockerPolicy.approvedBaseImages,
      workerImage: worker,
    });
    canGenerate = generated.ok;
    generationMessage = generated.ok ? undefined : generated.failure.message;
    if (!generated.ok) {
      blockers.push({
        code: `image-${generated.failure.kind}`,
        message: generated.failure.message,
        remediation:
          generated.failure.kind === "ambiguous"
            ? "Use a single known stack or keep execution.runtime=local. MVP never falls back to a host image-profiler agent."
            : generated.failure.kind === "missing-base"
              ? "Run `agent-harness execution approve-base --all --write-settings`, or add a digest-pinned base in Settings."
              : "Fix execution.docker image policy (worker digest + approved bases).",
      });
    }
  }

  evidenceSummary = {
    generatedImagesEnabled: dockerPolicy.generatedImagesEnabled,
    workerImageConfigured: workerConfigured,
    workerImageDigestPinned: workerPinned,
    approvedBaseImageCount: dockerPolicy.approvedBaseImages.length,
    evidence:
      evidenceStacks !== undefined
        ? { stacks: evidenceStacks, ambiguous: Boolean(ambiguous) }
        : undefined,
    canGenerate,
    generationMessage,
  };

  const networkNote = networkPolicyDocumentation(dockerPolicy.network.runtime);

  let sandboxIsolation: ExecutionRuntimeStatus["sandboxIsolation"];
  if (dockerPolicy.sandboxRequired !== false) {
    const { loadSandboxIsolationProbeCache, findCachedSandboxIsolationProbe, sandboxIsolationProbePassed } =
      await import("./sandbox-isolation-probe.js");
    if (options.projectStateRoot && options.imageDigest) {
      const cache = await loadSandboxIsolationProbeCache(options.projectStateRoot);
      const cached = findCachedSandboxIsolationProbe(cache, options.imageDigest);
      const passed = sandboxIsolationProbePassed(cached);
      sandboxIsolation = {
        required: true,
        passed,
        unsupported: cached?.unsupported,
        reason: cached?.reason,
        imageDigest: options.imageDigest,
      };
      if (!passed) {
        blockers.push({
          code: "sandbox-isolation-probe",
          message:
            cached?.reason ??
            "Sandbox isolation probe has not passed for the approved execution image digest.",
          remediation:
            "Approve/build the generated image so the fail-closed isolation probe can run. " +
            "Docker mode advertises canRestrictWritableWorkspace only after the probe succeeds.",
        });
      }
    } else {
      sandboxIsolation = {
        required: true,
        passed: false,
        reason: "No approved image digest yet; isolation probe runs after build.",
      };
      // Do not block readiness solely for missing digest — operator must approve/build first.
      // Digest acceptance and clone create remain fail-closed.
    }
  } else {
    sandboxIsolation = { required: false, passed: true };
  }

  return {
    runtime: "docker",
    ready: blockers.length === 0,
    blockers,
    docker: dockerReport,
    image: evidenceSummary,
    networkNote,
    sandboxIsolation,
  };
}

/** Fail closed before creating a Docker-mode run when Docker/image policy is unhealthy. */
export async function assertDockerExecutionReady(
  options: EvaluateExecutionRuntimeStatusOptions,
): Promise<ExecutionRuntimeStatus> {
  const status = await evaluateExecutionRuntimeStatus(options);
  if (status.runtime === "local" || status.ready) return status;
  const lines = status.blockers.map((blocker) => {
    const rem = blocker.remediation ? ` Remediation: ${blocker.remediation}` : "";
    return `- ${blocker.code}: ${blocker.message}.${rem}`;
  });
  throw new HarnessFailure(
    `Docker execution mode is blocked:\n${lines.join("\n")}`,
    "execution",
    false,
  );
}
