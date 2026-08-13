/**
 * Hardened container specification builders and deny rules (ADR 0015 §5).
 *
 * Network policy: MVP runtime mode is explicit `bridge` (filesystem isolation,
 * not exfiltration-proof). Provider/package-registry allowlisted proxy is later.
 */

import type { DockerExecutionPolicy } from "../../config/schema.js";

/** Must match application/paths.ts WORKER_* constants (avoid infra→application import). */
const WORKER_RUN_STATE_PATH = "/run-state" as const;
const WORKER_WORKSPACE_PATH = "/workspace" as const;

export const HARNESS_CONTAINER_LABEL_PREFIX = "io.agent-harness" as const;

export type NetworkMode = "bridge" | "none" | "allowlist-proxy";

export type ContainerResourceLimits = {
  cpus: number;
  memoryMb: number;
  pidsLimit: number;
};

export type HardenedContainerSpec = {
  name: string;
  image: string;
  labels: Record<string, string>;
  /** Runtime network mode — MVP uses bridge. */
  network: NetworkMode;
  user: string;
  readOnlyRootfs: true;
  dropAllCapabilities: true;
  noNewPrivileges: true;
  limits: ContainerResourceLimits;
  tmpfs: ReadonlyArray<{ path: string; options: string }>;
  mounts: ReadonlyArray<ContainerMount>;
  publishLoopback?: { hostPort: number; containerPort: number };
};

export type ContainerMount =
  | {
      kind: "volume";
      source: string;
      target: typeof WORKER_WORKSPACE_PATH;
      readOnly: false;
    }
  | {
      kind: "bind";
      source: string;
      target: typeof WORKER_RUN_STATE_PATH;
      readOnly: false;
    };

export type MountDenyReason =
  | "docker-socket"
  | "privileged"
  | "host-namespace"
  | "host-network"
  | "extra-bind-mount"
  | "control-checkout"
  | "harness-home"
  | "sibling-run-state";

const FORBIDDEN_BIND_SUFFIXES = [
  "/var/run/docker.sock",
  "\\var\\run\\docker.sock",
  "/run/docker.sock",
  "\\run\\docker.sock",
] as const;

/**
 * Encode deny rules for privileged / host namespaces / docker.sock / extra mounts.
 * Used by builders and later lifecycle code even before full container create lands.
 */
export function denyMountOrFlag(input: {
  privileged?: boolean;
  pidHost?: boolean;
  ipcHost?: boolean;
  networkHost?: boolean;
  mounts?: ReadonlyArray<{ source: string; target: string; kind?: string }>;
  allowedBindSources?: ReadonlySet<string>;
  controlRoot?: string;
  harnessHomeRoot?: string;
}): { allowed: true } | { allowed: false; reason: MountDenyReason; detail: string } {
  if (input.privileged) {
    return {
      allowed: false,
      reason: "privileged",
      detail: "Privileged containers are forbidden for harness runs.",
    };
  }
  if (input.pidHost || input.ipcHost) {
    return {
      allowed: false,
      reason: "host-namespace",
      detail: "Host PID/IPC namespaces are forbidden for harness runs.",
    };
  }
  if (input.networkHost) {
    return {
      allowed: false,
      reason: "host-network",
      detail: "Host networking is forbidden; use bridge (MVP) or a later allowlist proxy.",
    };
  }
  for (const mount of input.mounts ?? []) {
    const sourceNorm = mount.source.replaceAll("\\", "/").toLowerCase();
    for (const suffix of FORBIDDEN_BIND_SUFFIXES) {
      if (sourceNorm.endsWith(suffix.replaceAll("\\", "/").toLowerCase())) {
        return {
          allowed: false,
          reason: "docker-socket",
          detail: "Mounting the Docker socket into a run container is forbidden.",
        };
      }
    }
    if (mount.kind === "bind" || mount.kind === undefined) {
      if (mount.target === WORKER_WORKSPACE_PATH) {
        return {
          allowed: false,
          reason: "extra-bind-mount",
          detail: "Workspace must be a named volume, not a host bind mount.",
        };
      }
      if (mount.target === WORKER_RUN_STATE_PATH) {
        const allowed = input.allowedBindSources;
        if (allowed && ![...allowed].some((item) => pathsEqualLoose(item, mount.source))) {
          return {
            allowed: false,
            reason: "sibling-run-state",
            detail: "Only the current run's state directory may be bind-mounted at /run-state.",
          };
        }
      } else if (mount.target !== WORKER_RUN_STATE_PATH) {
        // Extra binds beyond the single run-state mount are denied.
        if (mount.target !== "/tmp") {
          return {
            allowed: false,
            reason: "extra-bind-mount",
            detail: `Extra bind mount to ${mount.target} is forbidden.`,
          };
        }
      }
      if (input.controlRoot && isPathUnder(mount.source, input.controlRoot)) {
        return {
          allowed: false,
          reason: "control-checkout",
          detail: "The control checkout must never be mounted into a run container.",
        };
      }
      if (
        input.harnessHomeRoot &&
        isPathUnder(mount.source, input.harnessHomeRoot) &&
        !(input.allowedBindSources && [...input.allowedBindSources].some((item) => pathsEqualLoose(item, mount.source)))
      ) {
        return {
          allowed: false,
          reason: "harness-home",
          detail: "Harness home (except the current run-state bind) must not be mounted.",
        };
      }
    }
  }
  return { allowed: true };
}

export function harnessContainerLabels(input: {
  projectKey: string;
  runId: string;
  harnessVersion: string;
}): Record<string, string> {
  return {
    [`${HARNESS_CONTAINER_LABEL_PREFIX}.project-key`]: input.projectKey,
    [`${HARNESS_CONTAINER_LABEL_PREFIX}.run-id`]: input.runId,
    [`${HARNESS_CONTAINER_LABEL_PREFIX}.version`]: input.harnessVersion,
    [`${HARNESS_CONTAINER_LABEL_PREFIX}.managed`]: "true",
  };
}

/**
 * Build the hardened per-run container specification.
 * Does not start a container — argv encoding lives in docker-client builders.
 */
export function buildHardenedContainerSpec(input: {
  name: string;
  image: string;
  projectKey: string;
  runId: string;
  harnessVersion: string;
  dockerPolicy: DockerExecutionPolicy;
  workspaceVolumeName: string;
  runStateHostPath: string;
  /** Non-root user inside the image (numeric preferred). */
  user?: string;
  publishHostPort?: number;
  workerPort?: number;
}): HardenedContainerSpec {
  const network = input.dockerPolicy.network.runtime;
  return {
    name: input.name,
    image: input.image,
    labels: harnessContainerLabels({
      projectKey: input.projectKey,
      runId: input.runId,
      harnessVersion: input.harnessVersion,
    }),
    network,
    user: input.user ?? "10001:10001",
    readOnlyRootfs: true,
    dropAllCapabilities: true,
    noNewPrivileges: true,
    limits: {
      cpus: input.dockerPolicy.limits.cpus,
      memoryMb: input.dockerPolicy.limits.memoryMb,
      pidsLimit: input.dockerPolicy.limits.pidsLimit,
    },
    tmpfs: [{ path: "/tmp", options: "rw,noexec,nosuid,size=64m" }],
    mounts: [
      {
        kind: "volume",
        source: input.workspaceVolumeName,
        target: WORKER_WORKSPACE_PATH,
        readOnly: false,
      },
      {
        kind: "bind",
        source: input.runStateHostPath,
        target: WORKER_RUN_STATE_PATH,
        readOnly: false,
      },
    ],
    publishLoopback:
      input.publishHostPort !== undefined
        ? {
            hostPort: input.publishHostPort,
            containerPort: input.workerPort ?? 8787,
          }
        : undefined,
  };
}

/** Documented MVP network policy note for operators / status payloads. */
export function networkPolicyDocumentation(mode: NetworkMode): string {
  switch (mode) {
    case "bridge":
      return (
        "Runtime network mode is bridge: the container has filesystem isolation " +
        "but unrestricted egress (not exfiltration-proof). Package-install networking " +
        "is configured separately (execution.docker.network.packageInstall) and may " +
        "differ from runtime. Provider allowlisted proxy is a later hardening option."
      );
    case "none":
      return "Runtime network mode is none: no egress. Cursor provider calls will fail.";
    case "allowlist-proxy":
      return "Allowlisted proxy mode is not implemented yet; configure bridge for MVP.";
  }
}

/**
 * Reject worker/container argv that would inject provider secrets via -e/--env,
 * or enable privileged/host namespaces. Complements denyMountOrFlag.
 */
export function denyInsecureContainerArgv(
  argv: readonly string[],
): { allowed: true } | { allowed: false; reason: MountDenyReason | "secret-env"; detail: string } {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--privileged") {
      return {
        allowed: false,
        reason: "privileged",
        detail: "Privileged containers are forbidden for harness runs.",
      };
    }
    if (arg === "--pid" && argv[i + 1] === "host") {
      return {
        allowed: false,
        reason: "host-namespace",
        detail: "Host PID namespace is forbidden.",
      };
    }
    if (arg === "--ipc" && argv[i + 1] === "host") {
      return {
        allowed: false,
        reason: "host-namespace",
        detail: "Host IPC namespace is forbidden.",
      };
    }
    if (arg === "--network" && argv[i + 1] === "host") {
      return {
        allowed: false,
        reason: "host-network",
        detail: "Host networking is forbidden.",
      };
    }
    if (arg === "-e" || arg === "--env") {
      const value = argv[i + 1] ?? "";
      if (/^CURSOR_API_KEY=/i.test(value) || value === "CURSOR_API_KEY") {
        return {
          allowed: false,
          reason: "secret-env",
          detail: "CURSOR_API_KEY must be injected via the run-state secret file, not container env.",
        };
      }
    }
    if (/^--env=CURSOR_API_KEY=/i.test(arg)) {
      return {
        allowed: false,
        reason: "secret-env",
        detail: "CURSOR_API_KEY must be injected via the run-state secret file, not container env.",
      };
    }
    if (/docker\.sock/i.test(arg)) {
      return {
        allowed: false,
        reason: "docker-socket",
        detail: "Docker socket must never appear in run argv.",
      };
    }
  }
  return { allowed: true };
}

/** Encode a HardenedContainerSpec into `docker run` argv (excluding the docker binary). */
export function hardenedSpecToRunArgv(
  spec: HardenedContainerSpec,
  options: { command?: string[]; entrypoint?: string[] } = {},
): string[] {
  const args: string[] = [
    "run",
    "-d",
    "--name",
    spec.name,
    "--network",
    spec.network,
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
  ];
  for (const [key, value] of Object.entries(spec.labels)) {
    args.push("--label", `${key}=${value}`);
  }
  for (const tmp of spec.tmpfs) {
    args.push("--tmpfs", `${tmp.path}:${tmp.options}`);
  }
  for (const mount of spec.mounts) {
    if (mount.kind === "volume") {
      args.push(
        "--mount",
        `type=volume,source=${mount.source},target=${mount.target}`,
      );
    } else {
      args.push(
        "--mount",
        `type=bind,source=${mount.source},target=${mount.target}`,
      );
    }
  }
  if (spec.publishLoopback) {
    args.push(
      "--publish",
      `127.0.0.1:${spec.publishLoopback.hostPort}:${spec.publishLoopback.containerPort}`,
    );
  }
  if (options.entrypoint?.length) {
    args.push("--entrypoint", options.entrypoint[0]!);
  }
  args.push(spec.image);
  if (options.command?.length) {
    args.push(...options.command);
  } else if (options.entrypoint && options.entrypoint.length > 1) {
    args.push(...options.entrypoint.slice(1));
  }
  return args;
}

function pathsEqualLoose(a: string, b: string): boolean {
  return a.replaceAll("\\", "/").toLowerCase() === b.replaceAll("\\", "/").toLowerCase();
}

function isPathUnder(candidate: string, root: string): boolean {
  const c = candidate.replaceAll("\\", "/").toLowerCase();
  const r = root.replaceAll("\\", "/").toLowerCase().replace(/\/+$/, "");
  return c === r || c.startsWith(`${r}/`);
}
