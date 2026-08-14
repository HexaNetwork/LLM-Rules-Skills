import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { HarnessFailure } from "../errors.js";
import type { DockerClient } from "../infrastructure/container/types.js";
import {
  buildHardenedContainerSpec,
  hardenedSpecToRunArgv,
  denyMountOrFlag,
} from "../infrastructure/container/container-spec.js";
import type { DockerExecutionPolicy } from "../config/schema.js";
import { WORKER_RPC_SECRET_RELATIVE_PATH } from "../worker/protocol.js";
import { WORKER_ISOLATION_SELF_CHECK_PATH } from "./execution-image-generator.js";
import { WORKER_RUN_STATE_PATH, WORKER_WORKSPACE_PATH } from "./paths.js";

/** Bump when probe semantics or required checks change (invalidates cache). */
export const SANDBOX_ISOLATION_PROBE_POLICY_VERSION = 1 as const;

export type SandboxIsolationCheckId =
  | "mount-topology"
  | "resource-flags"
  | "workspace-write"
  | "run-state-read-denied"
  | "run-state-write-denied"
  | "rpc-secret-read-denied"
  | "outside-workspace-denied"
  | "sandbox-enabled";

export type SandboxIsolationCheck = {
  id: SandboxIsolationCheckId;
  ok: boolean;
  detail: string;
};

export type SandboxIsolationProbeReport = {
  version: 1;
  ok: boolean;
  /** True when the probe could not run (missing Docker/SDK/key); fail-closed treats as not ok. */
  unsupported: boolean;
  imageDigest: string;
  policyVersion: typeof SANDBOX_ISOLATION_PROBE_POLICY_VERSION;
  probedAt: string;
  checks: SandboxIsolationCheck[];
  reason?: string;
};

export type SandboxIsolationProbeCache = {
  version: 1;
  updatedAt: string;
  entries: SandboxIsolationProbeReport[];
};

export type SandboxIsolationProbeExecutor = (input: {
  imageDigest: string;
  docker: DockerClient;
  dockerPolicy: DockerExecutionPolicy;
  /** Host dir used as a disposable /run-state bind for the probe. */
  probeRunStateHostPath: string;
  workspaceVolumeName: string;
  signal?: AbortSignal;
}) => Promise<SandboxIsolationProbeReport>;

export function sandboxIsolationProbeCacheKey(
  imageDigest: string,
  policyVersion: number = SANDBOX_ISOLATION_PROBE_POLICY_VERSION,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ imageDigest: imageDigest.trim(), policyVersion }))
    .digest("hex");
}

export function projectSandboxIsolationProbeCachePath(projectStateRoot: string): string {
  return path.join(projectStateRoot, "sandbox-isolation-probe-cache.json");
}

export async function loadSandboxIsolationProbeCache(
  projectStateRoot: string,
): Promise<SandboxIsolationProbeCache> {
  const filePath = projectSandboxIsolationProbeCachePath(projectStateRoot);
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as SandboxIsolationProbeCache;
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) {
      return { version: 1, updatedAt: new Date(0).toISOString(), entries: [] };
    }
    return parsed;
  } catch {
    return { version: 1, updatedAt: new Date(0).toISOString(), entries: [] };
  }
}

export async function saveSandboxIsolationProbeCache(
  projectStateRoot: string,
  cache: SandboxIsolationProbeCache,
): Promise<void> {
  await mkdir(projectStateRoot, { recursive: true });
  await writeFile(
    projectSandboxIsolationProbeCachePath(projectStateRoot),
    `${JSON.stringify(cache, null, 2)}\n`,
    "utf8",
  );
}

export function findCachedSandboxIsolationProbe(
  cache: SandboxIsolationProbeCache,
  imageDigest: string,
  policyVersion: number = SANDBOX_ISOLATION_PROBE_POLICY_VERSION,
): SandboxIsolationProbeReport | undefined {
  return cache.entries.find(
    (entry) =>
      entry.imageDigest === imageDigest &&
      entry.policyVersion === policyVersion &&
      entry.ok &&
      !entry.unsupported,
  );
}

/**
 * Fail-closed gate: Docker mode may advertise restrict capability / accept a digest
 * only when a successful probe exists for this digest + policy version.
 */
export function sandboxIsolationProbePassed(
  report: SandboxIsolationProbeReport | undefined,
): boolean {
  return Boolean(report && report.ok && !report.unsupported);
}

export function assertSandboxIsolationProbePassed(
  report: SandboxIsolationProbeReport | undefined,
  imageDigest: string,
): SandboxIsolationProbeReport {
  if (sandboxIsolationProbePassed(report)) return report!;
  const reason =
    report?.reason ??
    (report?.unsupported
      ? "Sandbox isolation probe is unsupported in this environment."
      : "Sandbox isolation probe has not succeeded.");
  throw new HarnessFailure(
    `Cannot accept execution image ${imageDigest}: ${reason}`,
    "execution",
    false,
  );
}

/**
 * Run (or reuse cached) isolation probe before accepting an image digest.
 * Failures and unsupported environments are fail-closed when sandboxRequired.
 */
export async function ensureSandboxIsolationProbe(input: {
  imageDigest: string;
  docker: DockerClient;
  dockerPolicy: DockerExecutionPolicy;
  projectStateRoot?: string;
  probeRunStateHostPath: string;
  workspaceVolumeName?: string;
  executor?: SandboxIsolationProbeExecutor;
  now?: () => Date;
  signal?: AbortSignal;
  /** When false, skip re-probe even if cache miss (tests). Default true. */
  runIfMissing?: boolean;
}): Promise<SandboxIsolationProbeReport> {
  const imageDigest = input.imageDigest.trim();
  if (!imageDigest) {
    throw new HarnessFailure("Cannot probe sandbox isolation without an image digest.", "execution", false);
  }

  if (input.projectStateRoot) {
    const cache = await loadSandboxIsolationProbeCache(input.projectStateRoot);
    const cached = findCachedSandboxIsolationProbe(cache, imageDigest);
    if (cached) return cached;
  }

  if (input.runIfMissing === false) {
    return {
      version: 1,
      ok: false,
      unsupported: true,
      imageDigest,
      policyVersion: SANDBOX_ISOLATION_PROBE_POLICY_VERSION,
      probedAt: (input.now ?? (() => new Date()))().toISOString(),
      checks: [],
      reason: "Sandbox isolation probe cache miss and runIfMissing=false.",
    };
  }

  if (input.dockerPolicy.sandboxRequired === false) {
    const skipped: SandboxIsolationProbeReport = {
      version: 1,
      ok: true,
      unsupported: false,
      imageDigest,
      policyVersion: SANDBOX_ISOLATION_PROBE_POLICY_VERSION,
      probedAt: (input.now ?? (() => new Date()))().toISOString(),
      checks: [
        {
          id: "sandbox-enabled",
          ok: true,
          detail: "execution.docker.sandboxRequired=false; probe skipped by policy.",
        },
      ],
    };
    await persistProbe(input.projectStateRoot, skipped);
    return skipped;
  }

  const executor = input.executor ?? defaultSandboxIsolationProbeExecutor;
  const report = await executor({
    imageDigest,
    docker: input.docker,
    dockerPolicy: input.dockerPolicy,
    probeRunStateHostPath: input.probeRunStateHostPath,
    workspaceVolumeName:
      input.workspaceVolumeName ??
      `ah-probe-${createHash("sha256").update(imageDigest).digest("hex").slice(0, 12)}`,
    signal: input.signal,
  });

  await persistProbe(input.projectStateRoot, report);
  return report;
}

async function persistProbe(
  projectStateRoot: string | undefined,
  report: SandboxIsolationProbeReport,
): Promise<void> {
  if (!projectStateRoot || !sandboxIsolationProbePassed(report)) return;
  const cache = await loadSandboxIsolationProbeCache(projectStateRoot);
  const entries = [
    report,
    ...cache.entries.filter(
      (entry) =>
        !(
          entry.imageDigest === report.imageDigest &&
          entry.policyVersion === report.policyVersion
        ),
    ),
  ].slice(0, 32);
  await saveSandboxIsolationProbeCache(projectStateRoot, {
    version: 1,
    updatedAt: report.probedAt,
    entries,
  });
}

/**
 * Default executor: structural mount/resource probe via disposable container +
 * in-container path checks that mirror Cursor sandbox expectations.
 * Returns unsupported when Docker cannot run the probe image.
 *
 * Full Cursor SDK sandbox verification is preferred when CURSOR_API_KEY is set
 * and `executor` is overridden by the SDK probe helper.
 */
export async function defaultSandboxIsolationProbeExecutor(input: {
  imageDigest: string;
  docker: DockerClient;
  dockerPolicy: DockerExecutionPolicy;
  probeRunStateHostPath: string;
  workspaceVolumeName: string;
  signal?: AbortSignal;
}): Promise<SandboxIsolationProbeReport> {
  const probedAt = new Date().toISOString();
  const checks: SandboxIsolationCheck[] = [];

  const deny = denyMountOrFlag({
    privileged: false,
    pidHost: false,
    ipcHost: false,
    networkHost: input.dockerPolicy.network.runtime === "bridge" ? false : false,
    mounts: [
      { kind: "volume", source: input.workspaceVolumeName, target: WORKER_WORKSPACE_PATH },
      { kind: "bind", source: input.probeRunStateHostPath, target: WORKER_RUN_STATE_PATH },
    ],
    allowedBindSources: new Set([input.probeRunStateHostPath]),
  });
  checks.push({
    id: "mount-topology",
    ok: deny.allowed,
    detail: deny.allowed
      ? "Hardened mount set (workspace volume + single run-state bind) accepted."
      : `Mount policy denied: ${deny.detail}`,
  });

  const spec = buildHardenedContainerSpec({
    name: `ah-probe-${Date.now().toString(36)}`.slice(0, 63),
    image: input.imageDigest,
    projectKey: "probe",
    runId: "sandbox-isolation",
    harnessVersion: "probe",
    dockerPolicy: input.dockerPolicy,
    workspaceVolumeName: input.workspaceVolumeName,
    runStateHostPath: input.probeRunStateHostPath,
  });
  const argv = hardenedSpecToRunArgv(spec, {
    entrypoint: [WORKER_ISOLATION_SELF_CHECK_PATH],
    command: [
      "--workspace",
      WORKER_WORKSPACE_PATH,
      "--run-state",
      WORKER_RUN_STATE_PATH,
      "--rpc-secret",
      `${WORKER_RUN_STATE_PATH}/${WORKER_RPC_SECRET_RELATIVE_PATH}`,
    ],
  });
  const hasResources =
    argv.includes("--cpus") &&
    argv.includes("--memory") &&
    argv.includes("--pids-limit") &&
    argv.includes("--read-only") &&
    argv.includes("--cap-drop");
  checks.push({
    id: "resource-flags",
    ok: hasResources,
    detail: hasResources
      ? "CPU/memory/PID limits and read-only/cap-drop flags present in probe argv."
      : "Hardened resource flags missing from probe container argv.",
  });

  // Ensure volume exists for the probe.
  const vol = await input.docker.inspectVolume(input.workspaceVolumeName);
  if (!vol) {
    const created = await input.docker.exec(["volume", "create", input.workspaceVolumeName], {
      signal: input.signal,
    });
    if (created.exitCode !== 0) {
      return {
        version: 1,
        ok: false,
        unsupported: true,
        imageDigest: input.imageDigest,
        policyVersion: SANDBOX_ISOLATION_PROBE_POLICY_VERSION,
        probedAt,
        checks,
        reason: `Could not create probe workspace volume: ${created.stderr || created.stdout}`,
      };
    }
  }

  await mkdir(input.probeRunStateHostPath, { recursive: true });
  await mkdir(path.join(input.probeRunStateHostPath, path.dirname(WORKER_RPC_SECRET_RELATIVE_PATH)), {
    recursive: true,
  });
  await writeFile(
    path.join(input.probeRunStateHostPath, WORKER_RPC_SECRET_RELATIVE_PATH),
    "probe-rpc-secret-not-for-production\n",
    "utf8",
  );
  await writeFile(
    path.join(input.probeRunStateHostPath, "probe-marker.txt"),
    "run-state-should-be-invisible-to-sandbox\n",
    "utf8",
  );

  // Override the image ENTRYPOINT (long-lived worker) with the self-check wrapper.
  // Do not pass `agent-harness sandbox-isolation-self-check` as CMD — that becomes
  // args to `/opt/agent-harness/worker`, which always prefixes `cli.js worker`.
  const runArgv = [
    "run",
    "--rm",
    "--name",
    spec.name,
    "--network",
    "none",
    "--user",
    spec.user,
    "--read-only",
    "--security-opt",
    "no-new-privileges:true",
    "--cap-drop",
    "ALL",
    "--pids-limit",
    String(spec.limits.pidsLimit),
    "--cpus",
    String(spec.limits.cpus),
    "--memory",
    `${spec.limits.memoryMb}m`,
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--mount",
    `type=volume,source=${input.workspaceVolumeName},target=${WORKER_WORKSPACE_PATH}`,
    "--mount",
    `type=bind,source=${input.probeRunStateHostPath},target=${WORKER_RUN_STATE_PATH}`,
    "--entrypoint",
    WORKER_ISOLATION_SELF_CHECK_PATH,
    input.imageDigest,
    "--workspace",
    WORKER_WORKSPACE_PATH,
    "--run-state",
    WORKER_RUN_STATE_PATH,
    "--rpc-secret",
    `${WORKER_RUN_STATE_PATH}/${WORKER_RPC_SECRET_RELATIVE_PATH}`,
  ];

  const result = await input.docker.exec(runArgv, {
    timeoutMs: 120_000,
    signal: input.signal,
  });

  if (result.exitCode !== 0) {
    const combined = `${result.stderr}\n${result.stdout}`;
    // Keep missingImage narrow — bare "not found" also matches exec/path failures.
    const missingImage =
      /unable to find image|No such image|pull access denied/i.test(combined) &&
      !/executable file not found|no such file or directory/i.test(combined);
    const missingCmd =
      /sandbox-isolation-self-check|unknown command|executable file not found|no such file or directory/i.test(
        combined,
      );
    if (missingImage || missingCmd) {
      // Fall back to structural-only evaluation when the image cannot execute the
      // self-check (common in unit fakes). Structural checks must still pass.
      const structuralOk = checks.every((check) => check.ok);
      checks.push({
        id: "workspace-write",
        ok: structuralOk,
        detail: missingImage
          ? "Image missing locally; structural mount/resource checks only."
          : "Self-check entrypoint missing; structural mount/resource checks only.",
      });
      checks.push({
        id: "run-state-read-denied",
        ok: structuralOk,
        detail:
          "Deferred to Cursor sandbox + prohibitedAgentPathAccess; structural mounts verified.",
      });
      checks.push({
        id: "run-state-write-denied",
        ok: structuralOk,
        detail: "Deferred to Cursor sandbox; structural mounts verified.",
      });
      checks.push({
        id: "rpc-secret-read-denied",
        ok: structuralOk,
        detail: "RPC secret lives under /run-state; sandbox must deny access.",
      });
      checks.push({
        id: "outside-workspace-denied",
        ok: structuralOk,
        detail: "Outside-/workspace paths must be denied by sandbox.",
      });
      checks.push({
        id: "sandbox-enabled",
        ok: structuralOk,
        detail: "sandboxRequired=true; agent coordinator enables sandboxOptions.",
      });
      // When sandboxRequired, structural-only without self-check is unsupported
      // (cannot prove SDK tool isolation) — fail closed.
      return {
        version: 1,
        ok: false,
        unsupported: true,
        imageDigest: input.imageDigest,
        policyVersion: SANDBOX_ISOLATION_PROBE_POLICY_VERSION,
        probedAt,
        checks,
        reason: missingImage
          ? "Sandbox isolation probe unsupported: execution image not available to run self-check."
          : "Sandbox isolation probe unsupported: image lacks sandbox-isolation-self-check entrypoint.",
      };
    }
    return {
      version: 1,
      ok: false,
      unsupported: false,
      imageDigest: input.imageDigest,
      policyVersion: SANDBOX_ISOLATION_PROBE_POLICY_VERSION,
      probedAt,
      checks: [
        ...checks,
        {
          id: "workspace-write",
          ok: false,
          detail: `Probe container failed: ${result.stderr || result.stdout}`,
        },
      ],
      reason: `Sandbox isolation self-check failed (exit ${result.exitCode}).`,
    };
  }

  let parsed: {
    workspaceWrite?: boolean;
    runStateReadDenied?: boolean;
    runStateWriteDenied?: boolean;
    rpcSecretReadDenied?: boolean;
    outsideWorkspaceDenied?: boolean;
  };
  try {
    const trimmed = result.stdout.trim();
    if (!trimmed) {
      return {
        version: 1,
        ok: false,
        unsupported: true,
        imageDigest: input.imageDigest,
        policyVersion: SANDBOX_ISOLATION_PROBE_POLICY_VERSION,
        probedAt,
        checks,
        reason:
          "Sandbox isolation self-check returned empty output (image may lack the probe entrypoint).",
      };
    }
    parsed = JSON.parse(trimmed) as typeof parsed;
  } catch {
    return {
      version: 1,
      ok: false,
      unsupported: true,
      imageDigest: input.imageDigest,
      policyVersion: SANDBOX_ISOLATION_PROBE_POLICY_VERSION,
      probedAt,
      checks,
      reason: "Sandbox isolation self-check returned unreadable JSON.",
    };
  }

  checks.push({
    id: "workspace-write",
    ok: parsed.workspaceWrite === true,
    detail:
      parsed.workspaceWrite === true
        ? "Wrote successfully under /workspace."
        : "Failed to write under /workspace.",
  });
  checks.push({
    id: "run-state-read-denied",
    ok: parsed.runStateReadDenied === true,
    detail:
      parsed.runStateReadDenied === true
        ? "Sandbox denied reading /run-state."
        : "Sandbox could read /run-state (fail closed).",
  });
  checks.push({
    id: "run-state-write-denied",
    ok: parsed.runStateWriteDenied === true,
    detail:
      parsed.runStateWriteDenied === true
        ? "Sandbox denied writing /run-state."
        : "Sandbox could write /run-state (fail closed).",
  });
  checks.push({
    id: "rpc-secret-read-denied",
    ok: parsed.rpcSecretReadDenied === true,
    detail:
      parsed.rpcSecretReadDenied === true
        ? "Sandbox denied reading the RPC secret."
        : "Sandbox could read the RPC secret (fail closed).",
  });
  checks.push({
    id: "outside-workspace-denied",
    ok: parsed.outsideWorkspaceDenied === true,
    detail:
      parsed.outsideWorkspaceDenied === true
        ? "Sandbox denied paths outside /workspace."
        : "Sandbox allowed paths outside /workspace (fail closed).",
  });
  checks.push({
    id: "sandbox-enabled",
    ok: true,
    detail: "Self-check completed with sandboxRequired policy.",
  });

  const ok = checks.every((check) => check.ok);
  return {
    version: 1,
    ok,
    unsupported: false,
    imageDigest: input.imageDigest,
    policyVersion: SANDBOX_ISOLATION_PROBE_POLICY_VERSION,
    probedAt,
    checks,
    reason: ok ? undefined : "One or more sandbox isolation checks failed.",
  };
}

/**
 * Pure evaluation used by unit tests and as the in-container self-check core.
 * Simulates SDK sandbox rules: allow writes under workspace; deny run-state/secret/outside.
 */
export function evaluateSandboxIsolationSelfCheck(input: {
  workspaceWritable: boolean;
  canReadRunState: boolean;
  canWriteRunState: boolean;
  canReadRpcSecret: boolean;
  canAccessOutsideWorkspace: boolean;
}): {
  workspaceWrite: boolean;
  runStateReadDenied: boolean;
  runStateWriteDenied: boolean;
  rpcSecretReadDenied: boolean;
  outsideWorkspaceDenied: boolean;
  ok: boolean;
} {
  const workspaceWrite = input.workspaceWritable;
  const runStateReadDenied = !input.canReadRunState;
  const runStateWriteDenied = !input.canWriteRunState;
  const rpcSecretReadDenied = !input.canReadRpcSecret;
  const outsideWorkspaceDenied = !input.canAccessOutsideWorkspace;
  return {
    workspaceWrite,
    runStateReadDenied,
    runStateWriteDenied,
    rpcSecretReadDenied,
    outsideWorkspaceDenied,
    ok:
      workspaceWrite &&
      runStateReadDenied &&
      runStateWriteDenied &&
      rpcSecretReadDenied &&
      outsideWorkspaceDenied,
  };
}
