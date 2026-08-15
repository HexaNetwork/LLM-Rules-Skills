import { HarnessFailure } from "../../errors.js";
import type { DockerClient } from "./types.js";

/** Minimum Docker API version we exercise for image/volume/port ops. */
export const MIN_DOCKER_API_VERSION = "1.44";

export type DockerReadinessCheckId =
  | "cli"
  | "daemon"
  | "linux-containers"
  | "api-version"
  | "image-ops"
  | "volume-ops"
  | "port-binding";

export type DockerReadinessCheck = {
  id: DockerReadinessCheckId;
  ok: boolean;
  detail: string;
  remediation?: string;
};

export type DockerReadinessReport = {
  ready: boolean;
  checks: DockerReadinessCheck[];
  clientVersion?: string;
  apiVersion?: string;
  osType?: string;
  serverVersion?: string;
};

export type ProbeDockerReadinessOptions = {
  /**
   * When true (default), run an ephemeral `docker run --rm … alpine` loopback
   * publish probe. UI status polls should pass false — that check is expensive
   * and must not run on every bootstrap refresh.
   */
  includePortBinding?: boolean;
};

/**
 * Probe Docker CLI + daemon readiness for harness Docker execution mode.
 * Failures are classified as `execution` with actionable remediation.
 */
export async function probeDockerReadiness(
  client: DockerClient,
  options: ProbeDockerReadinessOptions = {},
): Promise<DockerReadinessReport> {
  const includePortBinding = options.includePortBinding !== false;
  const checks: DockerReadinessCheck[] = [];

  let clientVersion: string | undefined;
  let apiVersion: string | undefined;
  let osType: string | undefined;
  let serverVersion: string | undefined;

  try {
    const version = await client.version();
    clientVersion = version.client;
    apiVersion = version.api;
    if (!version.client || version.client === "unknown") {
      checks.push({
        id: "cli",
        ok: false,
        detail: "Docker CLI did not report a client version.",
        remediation: "Install Docker and ensure `docker` is on PATH.",
      });
    } else {
      checks.push({
        id: "cli",
        ok: true,
        detail: `Docker CLI ${version.client}`,
      });
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    checks.push({
      id: "cli",
      ok: false,
      detail: `Docker CLI probe failed: ${detail}`,
      remediation: "Install Docker Desktop / Engine and ensure `docker version` works.",
    });
    return { ready: false, checks };
  }

  try {
    const info = await client.info();
    osType = info.osType;
    serverVersion = info.serverVersion;
    if (!info.serverVersion && !info.osType) {
      checks.push({
        id: "daemon",
        ok: false,
        detail: "Docker daemon did not respond to `docker info`.",
        remediation:
          process.platform === "win32"
            ? "Start Docker Desktop and switch to Linux containers."
            : "Start the Docker daemon (`systemctl start docker` or equivalent).",
      });
    } else {
      checks.push({
        id: "daemon",
        ok: true,
        detail: `Docker daemon ${info.serverVersion ?? "ok"}`,
      });
    }

    const linux =
      (info.osType ?? "").toLowerCase() === "linux" ||
      // Some Desktop setups omit OSType in JSON format; treat missing as unknown fail-closed.
      false;
    if ((info.osType ?? "").toLowerCase() === "linux") {
      checks.push({
        id: "linux-containers",
        ok: true,
        detail: "Linux container mode",
      });
    } else if (!info.osType) {
      checks.push({
        id: "linux-containers",
        ok: false,
        detail: "Could not determine container OS type from `docker info`.",
        remediation: "Ensure Docker reports OSType=linux (Linux containers / WSL2 backend).",
      });
    } else {
      checks.push({
        id: "linux-containers",
        ok: false,
        detail: `Container OS type is ${info.osType}; the harness requires Linux containers.`,
        remediation:
          process.platform === "win32"
            ? "In Docker Desktop, switch from Windows containers to Linux containers."
            : "Use a Linux Docker engine (not Windows container mode).",
      });
    }
    void linux;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    checks.push({
      id: "daemon",
      ok: false,
      detail: `Docker daemon probe failed: ${detail}`,
      remediation: "Start Docker and verify `docker info` succeeds.",
    });
  }

  if (apiVersion) {
    const ok = compareApiVersion(apiVersion, MIN_DOCKER_API_VERSION) >= 0;
    checks.push({
      id: "api-version",
      ok,
      detail: ok
        ? `Docker API ${apiVersion}`
        : `Docker API ${apiVersion} is below required ${MIN_DOCKER_API_VERSION}`,
      remediation: ok
        ? undefined
        : `Upgrade Docker so the API is at least ${MIN_DOCKER_API_VERSION}.`,
    });
  } else {
    checks.push({
      id: "api-version",
      ok: false,
      detail: "Docker API version unavailable.",
      remediation: "Upgrade Docker / ensure `docker version` reports ApiVersion.",
    });
  }

  // Image ops
  {
    const probe = await client.exec([
      "image",
      "ls",
      "--format",
      "{{.ID}}",
    ]);
    checks.push({
      id: "image-ops",
      ok: probe.exitCode === 0,
      detail:
        probe.exitCode === 0
          ? "Image list succeeded"
          : `Image list failed: ${probe.stderr || probe.stdout}`,
      remediation:
        probe.exitCode === 0
          ? undefined
          : "Fix Docker permissions so `docker image ls` works for this user.",
    });
  }

  // Volume ops
  {
    const probe = await client.exec(["volume", "ls", "--format", "{{.Name}}"]);
    checks.push({
      id: "volume-ops",
      ok: probe.exitCode === 0,
      detail:
        probe.exitCode === 0
          ? "Volume list succeeded"
          : `Volume list failed: ${probe.stderr || probe.stdout}`,
      remediation:
        probe.exitCode === 0
          ? undefined
          : "Fix Docker permissions so `docker volume ls` works for this user.",
    });
  }

  // Port binding on loopback (ephemeral container; fake client no-ops successfully).
  // Skipped on frequent UI polls — assertDockerReadiness / run creation still exercise it.
  if (includePortBinding) {
    const probe = await client.exec([
      "run",
      "--rm",
      "--network",
      "bridge",
      "--publish",
      "127.0.0.1::8000",
      "--entrypoint",
      "true",
      "alpine:3.20",
    ]);
    // Missing alpine is acceptable for readiness — distinguish daemon/permission failures.
    const missingImage = /unable to find image|not found|pull access denied/i.test(
      `${probe.stderr}\n${probe.stdout}`,
    );
    const ok = probe.exitCode === 0 || missingImage;
    checks.push({
      id: "port-binding",
      ok,
      detail: ok
        ? missingImage
          ? "Port-binding argv accepted (probe image missing; skipped full bind)"
          : "Loopback port publish probe succeeded"
        : `Port-binding probe failed: ${probe.stderr || probe.stdout}`,
      remediation: ok
        ? undefined
        : "Ensure Docker can publish ports on 127.0.0.1 (no conflicting firewall/Desktop setting).",
    });
  }

  const ready = checks.every((check) => check.ok);
  return {
    ready,
    checks,
    clientVersion,
    apiVersion,
    osType,
    serverVersion,
  };
}

/** Throw HarnessFailure(kind=execution) when Docker is not ready for Docker-mode runs. */
export async function assertDockerReadiness(client: DockerClient): Promise<DockerReadinessReport> {
  const report = await probeDockerReadiness(client);
  if (report.ready) return report;
  const failed = report.checks.filter((check) => !check.ok);
  const lines = failed.map((check) => {
    const rem = check.remediation ? ` Remediation: ${check.remediation}` : "";
    return `- ${check.id}: ${check.detail}.${rem}`;
  });
  throw new HarnessFailure(
    `Docker execution runtime is not ready:\n${lines.join("\n")}`,
    "execution",
    false,
  );
}

/** Compare dotted API versions; returns negative when a < b. */
export function compareApiVersion(a: string, b: string): number {
  const pa = a.split(".").map((part) => Number(part) || 0);
  const pb = b.split(".").map((part) => Number(part) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

/** Skip reason for real-Docker CI lanes that are not available locally. */
export function realDockerSkipReason(
  report: DockerReadinessReport | undefined,
): string | undefined {
  if (!report) return "Docker readiness not probed";
  if (report.ready) return undefined;
  const failed = report.checks.find((check) => !check.ok);
  return failed
    ? `Skipping real-Docker test: ${failed.id} — ${failed.detail}`
    : "Skipping real-Docker test: Docker not ready";
}
