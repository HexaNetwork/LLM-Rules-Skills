import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import type { HarnessConfig } from "../config/schema.js";
import type { DockerClient } from "../infrastructure/container/types.js";
import {
  buildHardenedContainerSpec,
  hardenedSpecToRunArgv,
  HARNESS_CONTAINER_LABEL_PREFIX,
} from "../infrastructure/container/container-spec.js";
import { WorkerRpcClient } from "../infrastructure/worker-rpc/client.js";
import { HarnessFailure } from "../errors.js";
import {
  generateWorkerRpcToken,
  readWorkerRpcToken,
  workerRpcTokenFingerprint,
  writeWorkerRpcTokenFile,
} from "../worker/auth.js";
import {
  writeCursorApiKeySecretFile,
  argvLeaksCursorApiKey,
} from "../worker/cursor-api-key-secret.js";
import {
  HARNESS_PACKAGE_VERSION,
  WORKER_RPC_CONTAINER_PORT,
  WORKER_RPC_PROTOCOL_VERSION,
  WORKER_RPC_SECRET_CONTAINER_PATH,
  WORKER_STATE_CREDENTIAL_CONTAINER_PATH,
  CURSOR_API_KEY_SECRET_CONTAINER_PATH,
} from "../worker/protocol.js";
import {
  createPendingDockerExecutionState,
  hostRunDirectory,
  loadRunExecutionState,
  writeRunExecutionState,
} from "./execution-state-io.js";
import type { RunExecutionState } from "../domain/run-execution.js";
import { resolveHarnessPaths } from "./paths.js";

export type DockerWorkerSession = {
  execution: RunExecutionState;
  client: WorkerRpcClient;
  /** Absolute host path to the secret file (do not log). */
  secretFilePath: string;
};

export type EnsureDockerWorkerSessionOptions = {
  projectConfig: HarnessConfig;
  runId: string;
  docker: DockerClient;
  /** Image reference/tag to run when starting a new container. */
  image?: string;
  workspaceVolumeName?: string;
  /** Stable name already recorded in workspace.json. */
  containerName?: string;
  projectKey?: string;
  /** When true, create/start a container if none is healthy (requires image). */
  startIfMissing?: boolean;
  /** Host state API origin as seen by the worker container. */
  stateServiceEndpoint?: string;
  /** Mint the plaintext token once for a new worker incarnation. */
  issueStateCredential?: (
    runId: string,
    options: { workerInstanceId: string },
  ) => Promise<{ token: string }>;
  /** Select the deterministic vNext provider; accepted only by test callers. */
  deterministicTestProfile?: boolean;
};

/** Bound the normal docker-run-to-listen race without hiding durable failures. */
export async function waitForDockerWorkerHealth(
  client: Pick<WorkerRpcClient, "health">,
  options: {
    attempts?: number;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<unknown> {
  const attempts = Math.max(1, options.attempts ?? 50);
  const intervalMs = Math.max(0, options.intervalMs ?? 100);
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await client.health();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(intervalMs);
    }
  }
  throw lastError;
}

/**
 * Resume after host/UI restart: load execution.json, derive the worker-bootstrap
 * secret location from the worker instance, discover the labeled container by
 * name, probe worker health, and return an authenticated client.
 */
export async function ensureDockerWorkerSession(
  options: EnsureDockerWorkerSessionOptions,
): Promise<DockerWorkerSession> {
  const runDir = hostRunDirectory(options.projectConfig, options.runId);
  let execution =
    (await loadRunExecutionState(options.projectConfig, options.runId)) ??
    createPendingDockerExecutionState();

  const workerInstanceId = execution.workerInstanceId ?? randomUUID();
  const bootstrapDirectory = path.join(
    resolveHarnessPaths(options.projectConfig).stateRoot,
    "worker-bootstrap",
    options.runId,
    workerInstanceId,
  );
  const secretFilePath = path.join(bootstrapDirectory, "worker-rpc.token");
  const stateCredentialFilePath = path.join(bootstrapDirectory, "state-credential.token");
  const cursorSecretFilePath = path.join(bootstrapDirectory, "cursor-api-key.token");

  let token: string;
  try {
    token = await readWorkerRpcToken(secretFilePath);
  } catch {
    if (!options.startIfMissing) {
      throw new HarnessFailure(
        `Docker worker RPC secret missing for run ${options.runId}. Re-open requires durable secret metadata under the run directory.`,
        "execution",
        true,
      );
    }
    token = generateWorkerRpcToken();
    await writeWorkerRpcTokenFile(secretFilePath, token);
  }

  const containerName =
    execution.containerName ??
    options.containerName ??
    defaultContainerName(options.projectKey ?? "project", options.runId);

  let hostPort = execution.hostPort;
  let containerId = execution.containerId;

  const inspected = await options.docker.inspectContainer?.(containerName);
  if (inspected) {
    containerId = inspected.id;
    const published = inspected.publishedPorts?.find(
      (port) => port.containerPort === (execution.containerPort ?? WORKER_RPC_CONTAINER_PORT),
    );
    if (published?.hostPort) hostPort = published.hostPort;
  } else if (options.startIfMissing) {
    if (!options.image || !options.workspaceVolumeName) {
      throw new HarnessFailure(
        "Cannot start Docker worker: image and workspaceVolumeName are required",
        "execution",
        false,
      );
    }
    if (!options.stateServiceEndpoint || !options.issueStateCredential) {
      throw new HarnessFailure(
        "Cannot start Docker worker without the host state-service endpoint and credential issuer",
        "execution",
        false,
      );
    }
    const issuedStateCredential = await options.issueStateCredential(options.runId, {
      workerInstanceId,
    });
    await writeWorkerRpcTokenFile(stateCredentialFilePath, issuedStateCredential.token);
    // Materialize Cursor API key as a narrowly mounted read-only bootstrap secret.
    const configuredHostApiKey = process.env.CURSOR_API_KEY?.trim();
    if (configuredHostApiKey && options.deterministicTestProfile !== true) {
      throw new HarnessFailure(
        "Cursor Docker workers are release-blocked: mounted /run/secrets credentials are disabled until the real Cursor tool and delegated-task isolation probe passes.",
        "execution",
        false,
      );
    }
    const hostApiKey =
      options.deterministicTestProfile === true ? undefined : configuredHostApiKey;
    if (hostApiKey) {
      await writeCursorApiKeySecretFile(
        cursorSecretFilePath,
        hostApiKey,
      );
    }
    hostPort = hostPort ?? (await allocateLoopbackPort());
    const started = await startWorkerContainer({
      docker: options.docker,
      projectConfig: options.projectConfig,
      runId: options.runId,
      runDir,
      workerInstanceId,
      stateServiceEndpoint: options.stateServiceEndpoint,
      rpcSecretFilePath: secretFilePath,
      stateCredentialFilePath,
      cursorSecretFilePath: hostApiKey ? cursorSecretFilePath : undefined,
      containerName,
      image: options.image,
      workspaceVolumeName: options.workspaceVolumeName,
      projectKey: options.projectKey ?? "project",
      hostPort,
      containerPort: execution.containerPort ?? WORKER_RPC_CONTAINER_PORT,
      deterministicTestProfile: options.deterministicTestProfile,
    });
    containerId = started.containerId;
  } else {
    throw new HarnessFailure(
      `Docker worker container ${containerName} was not found. Volume may still hold unpublished work; recreate the worker against the retained volume.`,
      "execution",
      true,
    );
  }

  if (hostPort == null) {
    throw new HarnessFailure(
      `Could not discover published RPC port for container ${containerName}`,
      "execution",
      true,
    );
  }

  const client = new WorkerRpcClient({
    baseUrl: `http://127.0.0.1:${hostPort}`,
    token,
  });

  try {
    await waitForDockerWorkerHealth(client);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    execution = await writeRunExecutionState(options.projectConfig, options.runId, {
      ...execution,
      lifecycle: "failed",
      containerName,
      containerId,
      hostPort,
      workerInstanceId,
      rpcTokenFingerprint: workerRpcTokenFingerprint(token),
      rpcProtocolVersion: WORKER_RPC_PROTOCOL_VERSION,
      workerHarnessVersion: HARNESS_PACKAGE_VERSION,
      lastError: message,
      updatedAt: new Date().toISOString(),
    });
    throw new HarnessFailure(
      `Docker worker health probe failed for ${containerName}: ${message}`,
      "execution",
      true,
    );
  }

  execution = await writeRunExecutionState(options.projectConfig, options.runId, {
    ...execution,
    lifecycle: "running",
    containerName,
    containerId,
    hostPort,
    workerInstanceId,
    rpcTokenFingerprint: workerRpcTokenFingerprint(token),
    rpcProtocolVersion: WORKER_RPC_PROTOCOL_VERSION,
    workerHarnessVersion: HARNESS_PACKAGE_VERSION,
    lastHealthAt: new Date().toISOString(),
    lastError: undefined,
    updatedAt: new Date().toISOString(),
  });

  return { execution, client, secretFilePath };
}

/**
 * Map a host UI action name onto a worker RPC action when the run is Docker-backed.
 * Returns undefined for host-only actions (cleanup, analysis, ignore_artifacts, …).
 */
export function workerRpcActionForHostAction(action: string): string | undefined {
  const map: Record<string, string> = {
    continue: "advance",
    resume: "advance",
    advance: "advance",
    initial_setup: "initial_setup",
    cancel: "cancel",
    retry: "retry",
    answer: "answer",
    note: "note",
    confirm_grill: "confirm_grill",
    confirm_plan: "confirm_plan",
    confirm_verification: "confirm_verification",
    retry_verification_baseline: "retry_verification_baseline",
    resolve_installs: "resolve_installs",
    propose_fix: "propose_fix",
    apply_fix: "apply_fix",
    accept_tree: "accept_tree",
    set_rag: "set_rag",
    set_repository_intelligence: "set_repository_intelligence",
    stop: "stop",
    prepare_export: "prepare-export",
    shutdown: "shutdown",
  };
  return map[action];
}

export function defaultContainerName(projectKey: string, runId: string): string {
  const safeProject = projectKey.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 40);
  const safeRun = runId.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 40);
  return `ah-${safeProject}-${safeRun}`.toLowerCase().slice(0, 63);
}

async function startWorkerContainer(input: {
  docker: DockerClient;
  projectConfig: HarnessConfig;
  runId: string;
  runDir: string;
  workerInstanceId: string;
  stateServiceEndpoint: string;
  rpcSecretFilePath: string;
  stateCredentialFilePath: string;
  cursorSecretFilePath?: string;
  containerName: string;
  image: string;
  workspaceVolumeName: string;
  projectKey: string;
  hostPort: number;
  containerPort: number;
  deterministicTestProfile?: boolean;
}): Promise<{ containerId: string }> {
  const dockerPolicy = input.projectConfig.execution?.docker;
  if (!dockerPolicy) {
    throw new HarnessFailure("execution.docker policy missing", "execution", false);
  }
  const spec = buildHardenedContainerSpec({
    name: input.containerName,
    image: input.image,
    projectKey: input.projectKey,
    runId: input.runId,
    harnessVersion: HARNESS_PACKAGE_VERSION,
    dockerPolicy,
    workspaceVolumeName: input.workspaceVolumeName,
    secretMounts: [
      { source: input.rpcSecretFilePath, target: WORKER_RPC_SECRET_CONTAINER_PATH },
      { source: input.stateCredentialFilePath, target: WORKER_STATE_CREDENTIAL_CONTAINER_PATH },
      ...(input.cursorSecretFilePath
        ? [{ source: input.cursorSecretFilePath, target: CURSOR_API_KEY_SECRET_CONTAINER_PATH }]
        : []),
    ],
    publishHostPort: input.hostPort,
    workerPort: input.containerPort,
  });
  const argv = hardenedSpecToRunArgv(spec, {
    command: [
      "--run-id",
      input.runId,
      "--worker-instance-id",
      input.workerInstanceId,
      "--state-endpoint",
      input.stateServiceEndpoint,
      "--listen",
      `0.0.0.0:${input.containerPort}`,
      ...(input.deterministicTestProfile ? ["--deterministic-test-profile"] : []),
    ],
  });
  if (argvLeaksCursorApiKey(argv)) {
    throw new HarnessFailure(
      "Refusing to start worker: CURSOR_API_KEY must not appear in container env argv.",
      "execution",
      false,
    );
  }
  const result = await input.docker.exec(argv);
  if (result.exitCode !== 0) {
    throw new HarnessFailure(
      `Failed to start worker container: ${result.stderr || result.stdout}`,
      "execution",
      true,
    );
  }
  const containerId = result.stdout.trim().slice(0, 64) || input.containerName;
  return { containerId };
}

function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("Failed to allocate loopback port"));
      });
    });
    server.on("error", reject);
  });
}

/**
 * Stop the per-run worker: best-effort RPC shutdown, then remove the container.
 * Retains the named workspace volume (unpublished work may still live there).
 * Idempotent when the container is already absent.
 */
export async function stopDockerWorkerSession(options: {
  projectConfig: HarnessConfig;
  runId: string;
  docker: DockerClient;
  containerName?: string;
  /** When true, attempt authenticated RPC shutdown before docker rm. */
  rpcShutdown?: boolean;
}): Promise<{ stopped: boolean; containerName: string }> {
  const execution =
    (await loadRunExecutionState(options.projectConfig, options.runId)) ??
    createPendingDockerExecutionState();
  const containerName =
    options.containerName ??
    execution.containerName ??
    defaultContainerName("project", options.runId);

  if (options.rpcShutdown !== false && execution.hostPort) {
    try {
      const session = await ensureDockerWorkerSession({
        projectConfig: options.projectConfig,
        runId: options.runId,
        docker: options.docker,
        startIfMissing: false,
      });
      await session.client.invoke("shutdown", {}).catch(() => undefined);
    } catch {
      // Container may already be dead; fall through to docker rm.
    }
  }

  const inspected = await options.docker.inspectContainer?.(containerName);
  if (inspected) {
    await options.docker.exec(["rm", "-f", containerName]);
  }

  await writeRunExecutionState(options.projectConfig, options.runId, {
    ...execution,
    lifecycle: "stopped",
    containerName,
    containerId: undefined,
    hostPort: undefined,
    updatedAt: new Date().toISOString(),
  });

  return { stopped: true, containerName };
}

/** Label filter helper for orphan reconciliation (slice 7). */
export function harnessManagedContainerFilter(projectKey?: string, runId?: string): string[] {
  const filters = [`label=${HARNESS_CONTAINER_LABEL_PREFIX}.managed=true`];
  if (projectKey) {
    filters.push(`label=${HARNESS_CONTAINER_LABEL_PREFIX}.project-key=${projectKey}`);
  }
  if (runId) {
    filters.push(`label=${HARNESS_CONTAINER_LABEL_PREFIX}.run-id=${runId}`);
  }
  return filters;
}
