import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { DockerExecutionPolicy } from "../config/schema.js";
import {
  buildHardenedContainerSpec,
  denyInsecureContainerArgv,
  hardenedSpecToRunArgv,
} from "../infrastructure/container/container-spec.js";
import type { DockerClient } from "../infrastructure/container/types.js";
import { WorkerProviderCredentialIssuer } from "./worker-provider-credentials.js";
import {
  recordCursorProviderProof,
  type CursorProviderProofReport,
  type CursorProviderProofTuple,
} from "./cursor-provider-proof.js";
import {
  CURSOR_PROVIDER_UPSTREAM_ORIGINS,
  UNPROVEN_CURSOR_PROVIDER_CONTRACT,
} from "../infrastructure/provider-proxy/cursor-provider-contract.js";
import {
  CursorProviderProxy,
  type CursorProviderAuditRecord,
} from "../infrastructure/provider-proxy/cursor-provider-proxy.js";
import { startCursorProviderHttpsListener } from "../infrastructure/provider-proxy/https-listener.js";
import {
  CURSOR_PROVIDER_CA_CONTAINER_PATH,
  type CursorProviderTlsMaterial,
} from "../infrastructure/provider-proxy/tls.js";
import { PROVIDER_API_PROTOCOL_VERSION } from "../worker/provider-protocol.js";
import {
  HARNESS_PACKAGE_VERSION,
  WORKER_IMAGE_CLI_PATH,
} from "../worker/protocol.js";
import { argvLeaksProviderCredential } from "../infrastructure/container/container-spec.js";
import { WORKER_WORKSPACE_PATH } from "./paths.js";
import type {
  CursorProviderCredentialAbsenceEvidence,
  CursorProviderSdkRuntimeEvidence,
  CredentialAbsencePhaseEvidence,
  SafeSdkDiagnostic,
  SmokeLifecycleStageEvidence,
} from "./cursor-provider-sdk-smoke-child.js";
import { CURSOR_PROVIDER_SMOKE_PROGRESS_PREFIX } from "./cursor-provider-sdk-smoke-child.js";

export {
  buildCursorProviderSdkOptions,
  type CursorProviderSdkRuntimeEvidence,
} from "./cursor-provider-sdk-smoke-child.js";

export const CURSOR_PROVIDER_SDK_SMOKE_COMMAND =
  "cursor-provider-sdk-smoke-child" as const;
const CURSOR_PROVIDER_PROOF_VOLUME_PREFIX = "ah-provider-proof-" as const;

type ChildResult = {
  ok: boolean;
  lifecycle?: CursorProviderProofReport["lifecycle"];
  credentialAbsence?: CursorProviderCredentialAbsenceEvidence;
  gaps?: string[];
  runtime?: CursorProviderSdkRuntimeEvidence;
  diagnostics?: SafeSdkDiagnostic[];
  lifecycleStages?: SmokeLifecycleStageEvidence[];
  error?: string;
};

export async function recordLiveCursorProviderContract(input: {
  apiKey: string;
  projectStateRoot: string;
  tuple: CursorProviderProofTuple;
  tls: CursorProviderTlsMaterial;
  docker: DockerClient;
  dockerPolicy: DockerExecutionPolicy;
  timeoutMs?: number;
  fetch?: typeof fetch;
  runChild?: (input: {
    endpoint: string;
    token: string;
    caCertificatePath: string;
    model: string;
    timeoutMs: number;
  }) => Promise<{ result: ChildResult; outputContainedHostKey: boolean }>;
}): Promise<CursorProviderProofReport> {
  const provedAt = new Date().toISOString();
  const runtimeRoot = path.join(
    input.projectStateRoot,
    "cursor-provider-proof-runtime",
    randomUUID(),
  );
  const runId = `proof-${randomUUID()}`;
  const workerInstanceId = `contract-container-${randomUUID()}`;
  const credentials = new WorkerProviderCredentialIssuer(
    path.join(runtimeRoot, "credentials"),
  );
  const issued = await credentials.issue(runId, { workerInstanceId });
  const audit: CursorProviderAuditRecord[] = [];
  const proxy = new CursorProviderProxy({
    credentials,
    upstreamOrigins: CURSOR_PROVIDER_UPSTREAM_ORIGINS,
    upstreamApiKey: input.apiKey,
    contract: UNPROVEN_CURSOR_PROVIDER_CONTRACT,
    fetch: input.fetch,
    audit: (record) => audit.push(record),
  });
  const listener = await startCursorProviderHttpsListener({
    proxy,
    tls: input.tls,
  });
  let child: ChildResult = { ok: false, error: "SDK child did not start" };
  let outputContainedHostKey = false;
  try {
    const endpoint =
      `${listener.containerOrigin}/provider-api/v${PROVIDER_API_PROTOCOL_VERSION}` +
      `/runs/${encodeURIComponent(runId)}/cursor`;
    const executeChild =
      input.runChild ??
      ((childInput) =>
        runSdkContainer(
          {
            ...childInput,
            imageDigest: input.tuple.imageDigest,
            docker: input.docker,
            dockerPolicy: input.dockerPolicy,
          },
          input.apiKey,
        ));
    const executed = await executeChild({
      endpoint,
      token: issued.token,
      caCertificatePath: input.tls.caCertificatePath,
      model: input.tuple.model,
      timeoutMs: input.timeoutMs ?? 12 * 60_000,
    });
    child = redactChildResult(executed.result, [input.apiKey, issued.token]);
    outputContainedHostKey = executed.outputContainedHostKey;
  } catch (error) {
    child = { ok: false, error: redactError(error, input.apiKey) };
  } finally {
    proxy.close();
    await listener.close().catch(() => undefined);
    await credentials.revoke(runId).catch(() => undefined);
    await rm(runtimeRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  const operations = dedupeOperations(audit);
  const actualRequest = operations.length > 0;
  const proxySucceeded = audit.some((record) => record.status >= 200 && record.status < 300);
  const appendProgress = audit.some(
    (record) =>
      record.relativePath === "/aiserver.v1.BidiService/BidiAppend" &&
      record.streaming === true &&
      record.status >= 200 &&
      record.status < 300 &&
      !record.failure &&
      record.requestBytes > 0,
  );
  const runStreamProgress = audit.some(
    (record) =>
      (record.relativePath === "/agent.v1.AgentService/RunSSE" ||
        record.relativePath === "/aiserver.v1.AgentService/RunSSE") &&
      record.status >= 200 &&
      record.status < 300 &&
      !record.failure &&
      record.responseBytes > 0,
  );
  const providerStreamProgress = appendProgress && runStreamProgress;
  const lifecycle = child.lifecycle ?? emptyLifecycle();
  const requiredLifecycle =
    lifecycle.create &&
    lifecycle.send &&
    lifecycle.stream &&
    lifecycle.wait &&
    lifecycle.resume &&
    lifecycle.cancel &&
    lifecycle.dispose;
  const productionRuntime = isProductionCursorProviderSdkRuntime(child.runtime);
  const directAbsence = credentialAbsencePhasePassed(child.credentialAbsence?.direct);
  const delegatedAbsence = credentialAbsencePhasePassed(child.credentialAbsence?.delegated);
  const checks = [
    {
      id: "host-only-key",
      ok: !outputContainedHostKey,
      detail: outputContainedHostKey
        ? "SDK child output contained forbidden credential bytes"
        : "SDK child received only a run-scoped broker token",
    },
    {
      id: "sdk-runtime",
      ok: productionRuntime,
      detail: productionRuntime
        ? "Pinned Linux x64 worker helper ran at /workspace with Cursor sandbox enabled"
        : runtimeDetail(child.runtime),
    },
    {
      id: "live-provider-request",
      ok: actualRequest,
      detail: actualRequest
        ? `${operations.length} redacted method/path contract entries observed`
        : "No request reached the HTTPS broker",
    },
    {
      id: "host-auth-injection",
      ok: proxySucceeded,
      detail: proxySucceeded
        ? "Host proxy completed at least one authenticated upstream hop"
        : "No upstream hop completed successfully",
    },
    {
      id: "provider-stream-progress",
      ok: providerStreamProgress,
      detail: providerStreamProgress
        ? "BidiAppend upload and RunSSE download transferred non-zero bytes without a stream failure"
        : `Provider stream progress incomplete: BidiAppend upload=${appendProgress ? "ok" : "gap"}, RunSSE download=${runStreamProgress ? "ok" : "gap"}`,
    },
    {
      id: "sdk-lifecycle",
      ok: requiredLifecycle,
      detail: lifecycleDetail(lifecycle, child.gaps),
    },
    {
      id: "direct-agent-absence",
      ok: directAbsence,
      detail: credentialAbsenceDetail(child.credentialAbsence?.direct),
    },
    {
      id: "delegated-agent-absence",
      ok: delegatedAbsence,
      detail: credentialAbsenceDetail(child.credentialAbsence?.delegated),
    },
    {
      id: "tls",
      ok: actualRequest,
      detail: actualRequest
        ? `Pinned SDK connected through trusted TLS identity ${input.tuple.tlsIdentity}`
        : "Pinned SDK did not establish the broker request",
    },
  ];
  const ok = child.ok && checks.every((check) => check.ok);
  const report: CursorProviderProofReport = {
    version: 1,
    ok,
    unsupported: false,
    tuple: input.tuple,
    provedAt,
    checks,
    operations,
    lifecycle,
    ...(child.credentialAbsence ? { credentialAbsence: child.credentialAbsence } : {}),
    ...(child.diagnostics?.length ? { sdkDiagnostics: child.diagnostics } : {}),
    ...(child.lifecycleStages?.length ? { lifecycleStages: child.lifecycleStages } : {}),
    ...(ok
      ? {}
      : {
          reason:
            child.error ??
            checks.find((check) => !check.ok)?.detail ??
            "Live provider contract failed",
        }),
  };
  await recordCursorProviderProof(input.projectStateRoot, report);
  return report;
}

function credentialAbsencePhasePassed(
  evidence: CredentialAbsencePhaseEvidence | undefined,
): boolean {
  return Boolean(
    evidence?.providerCompleted &&
      evidence.toolSearchAttempted &&
      evidence.completionMarkerObserved &&
      !evidence.keyShapedCredentialObserved &&
      !evidence.failure &&
      (evidence.phase !== "delegated" ||
        (evidence.taskAttempted && evidence.nestedTaskObserved)),
  );
}

function credentialAbsenceDetail(
  evidence: CredentialAbsencePhaseEvidence | undefined,
): string {
  if (!evidence) return "No behavioral credential-absence evidence was returned";
  const values = [
    `completed=${evidence.providerCompleted ? "ok" : "gap"}`,
    `tool-search=${evidence.toolSearchAttempted ? "ok" : "gap"}`,
    ...(evidence.phase === "delegated"
      ? [
          `task=${evidence.taskAttempted ? "ok" : "gap"}`,
          `nested=${evidence.nestedTaskObserved ? "ok" : "gap"}`,
        ]
      : []),
    `absence-marker=${evidence.completionMarkerObserved ? "ok" : "gap"}`,
    `credential-shaped-value=${evidence.keyShapedCredentialObserved ? "observed" : "absent"}`,
    `observed-via=${evidence.observationSource ?? "stream"}`,
  ];
  if (evidence.streamFailure) {
    values.push(`stream-failure=${redactText(evidence.streamFailure)}`);
  }
  if (evidence.failure) values.push(`failure=${redactText(evidence.failure)}`);
  return values.join(", ");
}

export function buildCursorProviderRecorderRunArgv(input: {
  endpoint: string;
  token: string;
  caCertificatePath: string;
  model: string;
  imageDigest: string;
  dockerPolicy: DockerExecutionPolicy;
  containerName: string;
  workspaceVolumeName: string;
}): string[] {
  const spec = buildHardenedContainerSpec({
    name: input.containerName,
    image: input.imageDigest,
    projectKey: "cursor-provider-proof",
    runId: input.containerName,
    harnessVersion: HARNESS_PACKAGE_VERSION,
    dockerPolicy: input.dockerPolicy,
    workspaceVolumeName: input.workspaceVolumeName,
    publicReadOnlyMounts: [
      {
        source: input.caCertificatePath,
        target: CURSOR_PROVIDER_CA_CONTAINER_PATH,
      },
    ],
    workingDir: WORKER_WORKSPACE_PATH,
    environment: [
      `CURSOR_BACKEND_URL=${input.endpoint}`,
      `CURSOR_PROVIDER_BROKER_TOKEN=${input.token}`,
      `CURSOR_PROVIDER_SMOKE_MODEL=${input.model}`,
    ],
  });
  const argv = hardenedSpecToRunArgv(spec, {
    entrypoint: [WORKER_IMAGE_CLI_PATH],
    command: [CURSOR_PROVIDER_SDK_SMOKE_COMMAND],
  });
  const detachedIndex = argv.indexOf("-d");
  if (detachedIndex >= 0) argv.splice(detachedIndex, 1, "--rm");
  return argv;
}

export function assertCursorProviderRecorderRunArgv(input: {
  argv: readonly string[];
  apiKey: string;
  imageDigest: string;
}): void {
  const insecure = denyInsecureContainerArgv(input.argv);
  if (!insecure.allowed) {
    throw new Error(`Provider recorder container rejected: ${insecure.detail}`);
  }
  if (argvLeaksProviderCredential(input.argv, input.apiKey)) {
    throw new Error("Provider recorder argv contains forbidden Cursor credential material");
  }
  const requiredPairs = [
    ["--security-opt", "no-new-privileges:true"],
    ["--security-opt", "seccomp=unconfined"],
    ["--cap-drop", "ALL"],
    ["--user", "10001:10001"],
    ["--network", "bridge"],
    ["--workdir", WORKER_WORKSPACE_PATH],
    ["--add-host", "host.docker.internal:host-gateway"],
    ["--entrypoint", WORKER_IMAGE_CLI_PATH],
  ] as const;
  if (
    !input.argv.includes("--rm") ||
    input.argv.includes("-d") ||
    !input.argv.includes("--read-only") ||
    requiredPairs.some(([flag, value]) => !hasArgPair(input.argv, flag, value))
  ) {
    throw new Error("Provider recorder must use the production-equivalent hardened container");
  }
  const imageIndex = input.argv.indexOf(input.imageDigest);
  if (
    imageIndex < 0 ||
    input.argv[imageIndex + 1] !== CURSOR_PROVIDER_SDK_SMOKE_COMMAND ||
    input.argv.length !== imageIndex + 2
  ) {
    throw new Error("Provider recorder must run the fixed helper from the pinned worker image");
  }
  const environment = input.argv.flatMap((arg, index) =>
    arg === "--env" ? [input.argv[index + 1] ?? ""] : [],
  );
  const allowedEnvironment = new Set([
    "HOME",
    "NODE_EXTRA_CA_CERTS",
    "CURSOR_BACKEND_URL",
    "CURSOR_PROVIDER_BROKER_TOKEN",
    "CURSOR_PROVIDER_SMOKE_MODEL",
  ]);
  if (
    environment.some((entry) => !allowedEnvironment.has(entry.split("=")[0] ?? "")) ||
    !environment.some((entry) => entry === `NODE_EXTRA_CA_CERTS=${CURSOR_PROVIDER_CA_CONTAINER_PATH}`) ||
    !input.argv.some(
      (arg) =>
        arg.startsWith("type=volume,") &&
        arg.includes(`target=${WORKER_WORKSPACE_PATH}`),
    ) ||
    !input.argv.some(
      (arg) =>
        arg.startsWith("type=bind,") &&
        arg.includes(`target=${CURSOR_PROVIDER_CA_CONTAINER_PATH},readonly`),
    )
  ) {
    throw new Error("Provider recorder container has an invalid environment or mount topology");
  }
}

async function runSdkContainer(
  input: {
    endpoint: string;
    token: string;
    caCertificatePath: string;
    model: string;
    timeoutMs: number;
    imageDigest: string;
    docker: DockerClient;
    dockerPolicy: DockerExecutionPolicy;
  },
  hostApiKey: string,
): Promise<{ result: ChildResult; outputContainedHostKey: boolean }> {
  const identity = randomUUID().replaceAll("-", "").slice(0, 16);
  const containerName = `${CURSOR_PROVIDER_PROOF_VOLUME_PREFIX}${identity}`;
  const workspaceVolumeName = `${containerName}-workspace`;
  const argv = buildCursorProviderRecorderRunArgv({
    ...input,
    containerName,
    workspaceVolumeName,
  });
  assertCursorProviderRecorderRunArgv({
    argv,
    apiKey: hostApiKey,
    imageDigest: input.imageDigest,
  });
  try {
    const executed = await input.docker.exec(argv, {
      timeoutMs: input.timeoutMs,
      // SDK bridge stderr can include large module dumps; keep the Docker
      // client's default ceiling so a noisy failure cannot truncate JSON.
      maxBuffer: 8 * 1024 * 1024,
    });
    const outputContainedHostKey =
      executed.stdout.includes(hostApiKey) || executed.stderr.includes(hostApiKey);
    const line = executed.stdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .at(-1);
    try {
      return {
        result: JSON.parse(line ?? "") as ChildResult,
        outputContainedHostKey,
      };
    } catch {
      // A child that dies before its result line still emitted per-stage
      // progress; keep it so the report says how far the contract got.
      const lifecycleStages = parseCursorProviderSmokeProgress(executed.stdout);
      return {
        result: {
          ok: false,
          ...(lifecycleStages.length ? { lifecycleStages } : {}),
          error: redactText(
            formatInvalidSdkChildOutput(executed.exitCode, executed.stdout, executed.stderr)
              .replaceAll(hostApiKey, "[REDACTED]")
              .replaceAll(input.token, "[REDACTED]"),
          ),
        },
        outputContainedHostKey,
      };
    }
  } finally {
    await input.docker.exec(["rm", "-f", containerName]).catch(() => undefined);
    await input.docker.exec(["volume", "rm", "-f", workspaceVolumeName]).catch(
      () => undefined,
    );
  }
}

export function isProductionCursorProviderSdkRuntime(
  runtime: CursorProviderSdkRuntimeEvidence | undefined,
): boolean {
  return Boolean(
    runtime?.containerized &&
      runtime.platform === "linux" &&
      runtime.arch === "x64" &&
      runtime.cwd === WORKER_WORKSPACE_PATH &&
      runtime.sandboxEnabled === true &&
      runtime.sdkHelper === "@cursor/sdk-linux-x64",
  );
}

function runtimeDetail(runtime: CursorProviderSdkRuntimeEvidence | undefined): string {
  if (!runtime) return "No containerized SDK runtime evidence was returned";
  return (
    `Rejected SDK runtime: containerized=${runtime.containerized}, ` +
    `platform=${runtime.platform}, arch=${runtime.arch}, cwd=${runtime.cwd}, ` +
    `sandbox=${runtime.sandboxEnabled}, helper=${runtime.sdkHelper}`
  );
}

function hasArgPair(argv: readonly string[], flag: string, value: string): boolean {
  return argv.some((arg, index) => arg === flag && argv[index + 1] === value);
}

function dedupeOperations(
  audit: CursorProviderAuditRecord[],
): NonNullable<CursorProviderProofReport["operations"]> {
  const entries = new Map<string, NonNullable<CursorProviderProofReport["operations"]>[number]>();
  for (const record of audit) {
    const entry = {
      method: record.method,
      path: record.relativePath,
      operation: record.operation,
      status: record.status,
      requestBytes: record.requestBytes,
      responseBytes: record.responseBytes,
      durationMs: record.durationMs,
      ...(record.streaming ? { streaming: true as const } : {}),
      ...(record.contentType ? { contentType: record.contentType } : {}),
      ...(record.failure ? { failure: record.failure } : {}),
    };
    entries.set(
      `${entry.method} ${entry.path} ${entry.status} ${entry.failure ?? ""}`,
      entry,
    );
  }
  return [...entries.values()];
}

function emptyLifecycle(): NonNullable<CursorProviderProofReport["lifecycle"]> {
  return {
    create: false,
    send: false,
    stream: false,
    wait: false,
    resume: false,
    cancel: false,
    dispose: false,
  };
}

function lifecycleDetail(
  lifecycle: NonNullable<CursorProviderProofReport["lifecycle"]>,
  gaps: string[] | undefined,
): string {
  const values = Object.entries(lifecycle)
    .map(([name, ok]) => `${name}=${ok ? "ok" : "gap"}`)
    .join(", ");
  return gaps?.length ? `${values}; ${gaps.join("; ")}` : values;
}

function redactError(error: unknown, apiKey: string): string {
  return redactText(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    .replaceAll(apiKey, "[REDACTED]");
}

function redactChildResult(value: ChildResult, secrets: string[]): ChildResult {
  return redactStructuredValue(value, secrets) as ChildResult;
}

function redactStructuredValue(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") {
    let redacted = value;
    for (const secret of secrets) {
      if (secret) redacted = redacted.replaceAll(secret, "[REDACTED]");
    }
    return redactText(redacted);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactStructuredValue(item, secrets));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      redactStructuredValue(item, secrets),
    ]),
  );
}

function redactText(value: string): string {
  // The progress sentinel is a fixed literal that no credential can contain,
  // so redacting around it keeps stage evidence readable without loosening the
  // key-shaped and Bearer rules applied to every other segment.
  return value
    .split(CURSOR_PROVIDER_SMOKE_PROGRESS_PREFIX)
    .map((segment) =>
      segment
        .replace(/\b(?:cursor_|key_|sk-)[A-Za-z0-9_-]{8,}\b/gi, "[REDACTED]")
        .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]"),
    )
    .join(CURSOR_PROVIDER_SMOKE_PROGRESS_PREFIX)
    .slice(0, 2_000);
}

export function formatInvalidSdkChildOutput(
  exitCode: number,
  stdout: string,
  stderr: string,
): string {
  const combined = `${stderr}\n${stdout}`.trim();
  const tail = combined.length > 1_500 ? combined.slice(-1_500) : combined;
  const last = parseCursorProviderSmokeProgress(stdout).at(-1);
  const stage = last ? ` Last stage: ${last.stage}=${last.status}.` : "";
  return `Containerized SDK child returned invalid output (exit ${exitCode}).${stage} ${tail}`;
}

const SMOKE_STAGE_STATUSES = new Set<SmokeLifecycleStageEvidence["status"]>([
  "started",
  "completed",
  "failed",
  "unsupported",
]);

export function parseCursorProviderSmokeProgress(
  stdout: string,
): SmokeLifecycleStageEvidence[] {
  const stages: SmokeLifecycleStageEvidence[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(CURSOR_PROVIDER_SMOKE_PROGRESS_PREFIX)) continue;
    try {
      const parsed = JSON.parse(
        trimmed.slice(CURSOR_PROVIDER_SMOKE_PROGRESS_PREFIX.length),
      ) as { stage?: unknown; status?: unknown };
      if (
        typeof parsed.stage !== "string" ||
        typeof parsed.status !== "string" ||
        !SMOKE_STAGE_STATUSES.has(parsed.status as SmokeLifecycleStageEvidence["status"])
      ) {
        continue;
      }
      stages.push({
        stage: redactText(parsed.stage),
        status: parsed.status as SmokeLifecycleStageEvidence["status"],
      });
    } catch {
      // Malformed progress remains non-authoritative diagnostic data.
    }
  }
  return stages;
}
