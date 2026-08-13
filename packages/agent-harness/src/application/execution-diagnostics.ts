import type { HarnessConfig } from "../config/schema.js";
import type { DockerClient } from "../infrastructure/container/types.js";
import type { DockerCloneWorkspace, RunWorkspace } from "../domain/workspace.js";
import type { BundleImportState, RunExecutionState } from "../domain/run-execution.js";
import { loadBundleImportState } from "./bundle-import-io.js";
import { loadRunExecutionState } from "./execution-state-io.js";
import { HARNESS_CONTAINER_LABEL_PREFIX } from "../infrastructure/container/container-spec.js";

/**
 * Redacted operator diagnostics for Docker-mode runs (ADR 0015 §10).
 * Never includes RPC tokens, API keys, or secret file contents.
 */
export type ExecutionDiagnostics = {
  runtime: "local" | "docker";
  runId: string;
  workspace?: {
    kind: string;
    containerName?: string;
    workspaceVolumeName?: string;
    imageDigest?: string;
    baseSha?: string;
    seedBundleHash?: string;
    generation?: number;
    removedAt?: string;
  };
  execution?: {
    lifecycle: string;
    containerName?: string;
    containerId?: string;
    hostPort?: number;
    imageId?: string;
    discoveredImageDigest?: string;
    rpcTokenFingerprint?: string;
    rpcProtocolVersion?: number;
    workerHarnessVersion?: string;
    lastHealthAt?: string;
    lastError?: string;
    updatedAt?: string;
  };
  import?: {
    status: string;
    seedBundleHash?: string;
    resultBundleHash?: string;
    tipSha?: string;
    deliveryBranch?: string;
    noChange?: boolean;
    rejectionReason?: string;
    updatedAt?: string;
  };
  dockerInspect?: {
    container?: {
      id: string;
      name: string;
      state: string;
      image: string;
      labels: Record<string, string>;
      publishedPorts?: Array<{ containerPort: number; hostPort: number; hostIp?: string }>;
    };
    volume?: {
      name: string;
      driver: string;
      /** Mountpoint redacted to basename only (avoid host path leakage). */
      mountpointBasename?: string;
    };
    image?: {
      id: string;
      digest?: string;
      repoTags: string[];
      size?: number;
    };
  };
  workerHealth?: { ok: boolean; detail?: string };
};

export async function collectExecutionDiagnostics(input: {
  projectConfig: HarnessConfig;
  runId: string;
  workspace?: RunWorkspace;
  docker?: DockerClient;
  workerHealth?: { ok: boolean; detail?: string };
}): Promise<ExecutionDiagnostics> {
  const execution = await loadRunExecutionState(input.projectConfig, input.runId);
  const importState = await loadBundleImportState(input.projectConfig, input.runId);
  const workspace = input.workspace;

  const diagnostics: ExecutionDiagnostics = {
    runtime: workspace?.kind === "docker-clone" ? "docker" : "local",
    runId: input.runId,
    workspace: workspace
      ? summarizeWorkspace(workspace)
      : undefined,
    execution: execution ? summarizeExecution(execution) : undefined,
    import: importState ? summarizeImport(importState) : undefined,
    workerHealth: input.workerHealth,
  };

  if (input.docker && workspace?.kind === "docker-clone") {
    diagnostics.dockerInspect = await redactDockerInspect(input.docker, workspace, execution);
  }

  return diagnostics;
}

function summarizeWorkspace(workspace: RunWorkspace): ExecutionDiagnostics["workspace"] {
  if (workspace.kind === "docker-clone") {
    return {
      kind: workspace.kind,
      containerName: workspace.containerName,
      workspaceVolumeName: workspace.workspaceVolumeName,
      imageDigest: workspace.imageDigest,
      baseSha: workspace.baseSha,
      seedBundleHash: workspace.seedBundleHash,
      generation: workspace.generation,
      removedAt: workspace.removedAt,
    };
  }
  if (workspace.kind === "git-worktree") {
    return {
      kind: workspace.kind,
      baseSha: workspace.baseSha,
      removedAt: workspace.removedAt,
    };
  }
  return { kind: workspace.kind };
}

function summarizeExecution(execution: RunExecutionState): ExecutionDiagnostics["execution"] {
  return {
    lifecycle: execution.lifecycle,
    containerName: execution.containerName,
    containerId: execution.containerId,
    hostPort: execution.hostPort,
    imageId: execution.imageId,
    discoveredImageDigest: execution.discoveredImageDigest,
    rpcTokenFingerprint: execution.rpcTokenFingerprint,
    rpcProtocolVersion: execution.rpcProtocolVersion,
    workerHarnessVersion: execution.workerHarnessVersion,
    lastHealthAt: execution.lastHealthAt,
    lastError: execution.lastError,
    updatedAt: execution.updatedAt,
  };
}

function summarizeImport(state: BundleImportState): ExecutionDiagnostics["import"] {
  return {
    status: state.status,
    seedBundleHash: state.seedBundleHash,
    resultBundleHash: state.resultBundleHash,
    tipSha: state.tipSha,
    deliveryBranch: state.deliveryBranch,
    noChange: state.noChange,
    rejectionReason: state.rejectionReason,
    updatedAt: state.updatedAt,
  };
}

async function redactDockerInspect(
  docker: DockerClient,
  workspace: DockerCloneWorkspace,
  execution: RunExecutionState | undefined,
): Promise<NonNullable<ExecutionDiagnostics["dockerInspect"]>> {
  const out: NonNullable<ExecutionDiagnostics["dockerInspect"]> = {};
  const containerName = workspace.containerName || execution?.containerName;
  if (containerName && docker.inspectContainer) {
    const inspected = await docker.inspectContainer(containerName).catch(() => undefined);
    if (inspected) {
      out.container = {
        id: inspected.id,
        name: inspected.name,
        state: inspected.state,
        image: inspected.image,
        labels: redactLabels(inspected.labels),
        publishedPorts: inspected.publishedPorts,
      };
    }
  }
  const volume = await docker.inspectVolume(workspace.workspaceVolumeName).catch(() => undefined);
  if (volume) {
    out.volume = {
      name: volume.name,
      driver: volume.driver,
      mountpointBasename: volume.mountpoint
        ? volume.mountpoint.replace(/\\/g, "/").split("/").filter(Boolean).at(-1)
        : undefined,
    };
  }
  const imageRef = workspace.imageDigest || execution?.discoveredImageDigest || execution?.imageId;
  if (imageRef) {
    const image = await docker.inspectImage(imageRef).catch(() => undefined);
    if (image) {
      out.image = {
        id: image.id,
        digest: image.digest,
        repoTags: image.repoTags,
        size: image.size,
      };
    }
  }
  return out;
}

function redactLabels(labels: Record<string, string>): Record<string, string> {
  const allowed = new Set([
    `${HARNESS_CONTAINER_LABEL_PREFIX}.managed`,
    `${HARNESS_CONTAINER_LABEL_PREFIX}.project-key`,
    `${HARNESS_CONTAINER_LABEL_PREFIX}.run-id`,
    `${HARNESS_CONTAINER_LABEL_PREFIX}.version`,
  ]);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (allowed.has(key)) out[key] = value;
  }
  return out;
}

/** True when import journal indicates commits are durable on the host. */
export function commitsImportedOrReachable(importState: BundleImportState | undefined): boolean {
  if (!importState) return false;
  if (importState.status === "promoted") return true;
  if (
    importState.noChange === true &&
    (importState.status === "export-ready" || importState.status === "validated")
  ) {
    return true;
  }
  return Boolean(importState.deliveryBranch || importState.deliveryRef);
}
