import path from "node:path";
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
  CURSOR_PROVIDER_CONTRACT_VERSION,
  PINNED_CURSOR_SDK_VERSION,
  UNPROVEN_CURSOR_PROVIDER_CONTRACT,
} from "../infrastructure/provider-proxy/cursor-provider-contract.js";
import { PROVIDER_API_PROTOCOL_VERSION } from "../worker/provider-protocol.js";
import {
  currentCursorProviderProofTuple,
  findMatchingCursorProviderProof,
  loadCursorProviderProofCache,
} from "./cursor-provider-proof.js";
import { readCursorProviderTlsIdentity } from "../infrastructure/provider-proxy/tls.js";

function isDigestPinnedImageRef(reference: string): boolean {
  return reference.startsWith("sha256:") || /@sha256:[a-f0-9]{64}$/i.test(reference);
}

/**
 * Operator/UI-facing Docker execution status.
 */
export type ExecutionRuntimeStatus = {
  runtime: "docker";
  ready: boolean;
  /** High-level blockers with remediation. */
  blockers: Array<{ code: string; message: string; remediation?: string }>;
  docker?: DockerReadinessReport;
  image?: {
    workerImageConfigured: boolean;
    workerImageDigestPinned: boolean;
    available: boolean;
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
  /** Separate real-provider gate; deterministic Docker readiness cannot satisfy it. */
  cursorCredential?: {
    configured: boolean;
    requiredForRealRuns: true;
    passed: boolean;
    custody: "host-proxy";
    broker: {
      configured: boolean;
      reachable: boolean;
      compatible: boolean;
      proven: boolean;
      protocolVersion: number;
      contractVersion: string;
      sdkVersion: string;
    };
    reason?: string;
    imageDigest?: string;
    model: string;
  };
};

export type EvaluateExecutionRuntimeStatusOptions = {
  config: HarnessConfig;
  docker?: DockerClient;
  /** When false, skip Docker daemon probes. */
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
 * Evaluate whether new runs may use Docker. Requires CLI/daemon readiness plus
 * one available immutable worker/toolchain image.
 */
export async function evaluateExecutionRuntimeStatus(
  options: EvaluateExecutionRuntimeStatusOptions,
): Promise<ExecutionRuntimeStatus> {
  const blockers: ExecutionRuntimeStatus["blockers"] = [];
  const dockerPolicy = options.config.execution.docker;
  const worker = dockerPolicy.workerImageDigest?.trim() ?? "";
  const workerConfigured = worker.length > 0;
  const workerPinned = workerConfigured && isDigestPinnedImageRef(worker);

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

  let dockerReport: DockerReadinessReport | undefined;
  let imageAvailable = false;
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
    } else if (workerPinned) {
      imageAvailable = await client.imageExists(worker);
      if (!imageAvailable) {
        blockers.push({
          code: "worker-image-unavailable",
          message: `Maintained worker image is unavailable locally: ${worker}`,
          remediation: "Run `agent-harness execution prepare-worker --force-rebuild --write-settings`.",
        });
      }
    }
  }

  const networkNote = networkPolicyDocumentation(dockerPolicy.network.runtime);

  let sandboxIsolation: ExecutionRuntimeStatus["sandboxIsolation"];
  if (dockerPolicy.sandboxRequired !== false) {
    const { loadSandboxIsolationProbeCache, findCachedSandboxIsolationProbe, sandboxIsolationProbePassed } =
      await import("./sandbox-isolation-probe.js");
    const isolationImage = options.imageDigest ?? worker;
    if (options.projectStateRoot && isolationImage) {
      const cache = await loadSandboxIsolationProbeCache(options.projectStateRoot);
      const cached = findCachedSandboxIsolationProbe(cache, isolationImage);
      const passed = sandboxIsolationProbePassed(cached);
      sandboxIsolation = {
        required: true,
        passed,
        unsupported: cached?.unsupported,
        reason: cached?.reason,
        imageDigest: isolationImage,
      };
      if (!passed) {
        blockers.push({
          code: "sandbox-isolation-probe",
          message:
            cached?.reason ??
            "Sandbox isolation probe has not passed for the maintained worker image digest.",
          remediation:
            "Run the credential and sandbox isolation probe for the maintained image.",
        });
      }
    } else {
      sandboxIsolation = {
        required: true,
        passed: false,
        reason: "No maintained image digest is configured.",
      };
      // Missing image is already represented by the worker-image blocker.
    }
  } else {
    sandboxIsolation = { required: false, passed: true };
  }

  const configuredApiKey = process.env.CURSOR_API_KEY?.trim();
  const credentialImage = options.imageDigest ?? worker;
  const tlsIdentity = options.projectStateRoot
    ? await readCursorProviderTlsIdentity(
        path.join(options.projectStateRoot, "cursor-provider-tls"),
      )
    : undefined;
  const proof =
    configuredApiKey && options.projectStateRoot && credentialImage && tlsIdentity
      ? findMatchingCursorProviderProof(
          await loadCursorProviderProofCache(options.projectStateRoot),
          currentCursorProviderProofTuple({
            imageDigest: credentialImage,
            model: options.config.models.capable,
            tlsIdentity,
            apiKey: configuredApiKey,
          }),
        )
      : undefined;
  const providerPassed = Boolean(
    configuredApiKey &&
      tlsIdentity &&
      UNPROVEN_CURSOR_PROVIDER_CONTRACT.productionReady &&
      proof,
  );
  const cursorCredential: ExecutionRuntimeStatus["cursorCredential"] = {
    configured: Boolean(configuredApiKey),
    requiredForRealRuns: true,
    passed: providerPassed,
    custody: "host-proxy",
    broker: {
      configured: Boolean(configuredApiKey && tlsIdentity),
      reachable: Boolean(proof),
      compatible: UNPROVEN_CURSOR_PROVIDER_CONTRACT.productionReady,
      proven: Boolean(proof),
      protocolVersion: PROVIDER_API_PROTOCOL_VERSION,
      contractVersion: CURSOR_PROVIDER_CONTRACT_VERSION,
      sdkVersion: PINNED_CURSOR_SDK_VERSION,
    },
    reason: providerPassed
      ? undefined
      : !configuredApiKey
        ? "Host Cursor credential is not configured; deterministic runs remain available."
        : !UNPROVEN_CURSOR_PROVIDER_CONTRACT.productionReady
          ? "Pinned Cursor SDK has no green provider-proxy contract for this image."
          : !tlsIdentity
            ? "Host Cursor provider TLS material is not initialized."
            : "No matching green host provider-proxy proof exists for this release tuple.",
    imageDigest: credentialImage || undefined,
    model: options.config.models.capable,
  };
  if (configuredApiKey && !providerPassed) {
    blockers.push({
      code: "cursor-credential-delivery-unsupported",
      message: cursorCredential.reason!,
      remediation:
        "Real Cursor runs remain blocked. Run `agent-harness execution cursor-provider-smoke --repository <path> --force` after the HTTPS broker and SDK contract are available; never restore /run/secrets credential mounting.",
    });
  }

  return {
    runtime: "docker",
    ready: blockers.length === 0,
    blockers,
    docker: dockerReport,
    image: {
      workerImageConfigured: workerConfigured,
      workerImageDigestPinned: workerPinned,
      available: imageAvailable,
    },
    networkNote,
    sandboxIsolation,
    cursorCredential,
  };
}

/** Fail closed before creating a Docker run when Docker/image policy is unhealthy. */
export async function assertDockerExecutionReady(
  options: EvaluateExecutionRuntimeStatusOptions,
): Promise<ExecutionRuntimeStatus> {
  const status = await evaluateExecutionRuntimeStatus(options);
  if (status.ready) return status;
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
