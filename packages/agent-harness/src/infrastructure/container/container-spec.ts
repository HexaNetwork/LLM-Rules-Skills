/**
 * Hardened container specification builders and deny rules (ADR 0015 §5).
 *
 * Network policy: MVP runtime mode is explicit `bridge` (filesystem isolation,
 * not exfiltration-proof). Provider/package-registry allowlisted proxy is later.
 */

import type { DockerExecutionPolicy } from "../../config/schema.js";

/** Must match application/paths.ts WORKER_* constants (avoid infra→application import). */
const WORKER_WORKSPACE_PATH = "/workspace" as const;

export const HARNESS_CONTAINER_LABEL_PREFIX = "io.agent-harness" as const;

export type NetworkMode = "bridge" | "none" | "allowlist-proxy";

/**
 * Seccomp profile requested through `--security-opt seccomp=…`.
 *
 * The Cursor SDK sandbox helper builds its filesystem boundary inside an
 * unprivileged user namespace, and Docker's default profile answers
 * `unshare(CLONE_NEWUSER)` with EPERM unless the container holds CAP_SYS_ADMIN.
 * Without `unconfined` the SDK silently downgrades every agent tool call to
 * `insecure_none`, which is the isolation the credential proof depends on.
 * Capabilities stay fully dropped in both modes.
 */
export type SeccompProfile = "docker-default" | "unconfined";

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
  seccomp: SeccompProfile;
  limits: ContainerResourceLimits;
  tmpfs: ReadonlyArray<{ path: string; options: string }>;
  workingDir?: string;
  /** Non-secret environment variables (`KEY=VALUE`). Never include CURSOR_API_KEY. */
  env?: ReadonlyArray<string>;
  extraHosts?: ReadonlyArray<string>;
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
      target: typeof WORKER_WORKSPACE_PATH;
      readOnly: false;
    }
  | {
      kind: "bind";
      source: string;
      target: string;
      readOnly: true;
    };

export type HardenedWorkspace =
  | { kind: "volume"; volumeName: string }
  | { kind: "bind"; hostPath: string };

const PUBLIC_TRUST_ROOT = "/run/agent-harness-public/" as const;
const FORBIDDEN_PROVIDER_ENV =
  /^(?:CURSOR_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GH_TOKEN|GITHUB_TOKEN)=/i;

export type MountDenyReason =
  | "docker-socket"
  | "privileged"
  | "host-namespace"
  | "host-network"
  | "extra-bind-mount"
  | "control-checkout"
  | "harness-home";

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
  mounts?: ReadonlyArray<{ source: string; target: string; kind?: string; readOnly?: boolean }>;
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
        if (mount.readOnly === false) {
          continue;
        }
        return {
          allowed: false,
          reason: "extra-bind-mount",
          detail: "Workspace bind mounts must be writable.",
        };
      }
      const publicTrust =
        mount.target.startsWith(PUBLIC_TRUST_ROOT) && mount.readOnly === true;
      if (!publicTrust) {
        return {
          allowed: false,
          reason: "extra-bind-mount",
          detail: `Only the assigned workspace or public trust files may be bind-mounted; ${mount.target} is forbidden.`,
        };
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
        isPathUnder(mount.source, input.harnessHomeRoot)
      ) {
        return {
          allowed: false,
          reason: "harness-home",
          detail: "Harness home must not be mounted into a run container.",
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
  /** @deprecated Prefer `workspace`. Probe volumes still use this. */
  workspaceVolumeName?: string;
  workspace?: HardenedWorkspace;
  /** Non-secret trust/configuration files delivered read-only. */
  publicReadOnlyMounts?: ReadonlyArray<{ source: string; target: string }>;
  /** Non-root user inside the image (numeric preferred). */
  user?: string;
  /** Fixed in-container process cwd. */
  workingDir?: string;
  /** Additional non-secret process configuration. */
  environment?: ReadonlyArray<string>;
  /**
   * The container runs agent tools under the Cursor SDK sandbox, which needs an
   * unprivileged user namespace. Set false only for containers that never start
   * the SDK (structural self-checks).
   */
  runsCursorSandbox?: boolean;
  publishHostPort?: number;
  workerPort?: number;
}): HardenedContainerSpec {
  const network = input.dockerPolicy.network.runtime;
  const workspace = input.workspace
    ?? (input.workspaceVolumeName
      ? { kind: "volume" as const, volumeName: input.workspaceVolumeName }
      : undefined);
  if (!workspace) {
    throw new Error("buildHardenedContainerSpec requires workspace or workspaceVolumeName");
  }
  const workspaceMount: ContainerMount =
    workspace.kind === "bind"
      ? {
          kind: "bind",
          source: workspace.hostPath,
          target: WORKER_WORKSPACE_PATH,
          readOnly: false,
        }
      : {
          kind: "volume",
          source: workspace.volumeName,
          target: WORKER_WORKSPACE_PATH,
          readOnly: false,
        };
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
    seccomp: input.runsCursorSandbox === false ? "docker-default" : "unconfined",
    limits: {
      cpus: input.dockerPolicy.limits.cpus,
      memoryMb: input.dockerPolicy.limits.memoryMb,
      pidsLimit: input.dockerPolicy.limits.pidsLimit,
    },
    tmpfs: [
      { path: "/tmp", options: "rw,noexec,nosuid,size=64m" },
      // Cursor SDK writes under $HOME/.cursor; rootfs is read-only.
      // uid/gid must match the non-root worker user or mkdir fails with EACCES.
      { path: "/home/harness", options: "rw,nosuid,size=512m,uid=10001,gid=10001,mode=755" },
    ],
    workingDir: input.workingDir,
    env: [
      "HOME=/home/harness",
      ...(input.publicReadOnlyMounts?.some(
        (mount) => mount.target === "/run/agent-harness-public/cursor-provider-ca.pem",
      )
        ? ["NODE_EXTRA_CA_CERTS=/run/agent-harness-public/cursor-provider-ca.pem"]
        : []),
      ...(input.environment ?? []),
    ],
    extraHosts: ["host.docker.internal:host-gateway"],
    mounts: [
      workspaceMount,
      ...(input.publicReadOnlyMounts ?? []).map((mount) => ({
        kind: "bind" as const,
        source: mount.source,
        target: mount.target,
        readOnly: true as const,
      })),
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
): {
  allowed: true;
} | {
  allowed: false;
  reason: MountDenyReason | "secret-env" | "tls-verification-disabled";
  detail: string;
} {
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
      if (FORBIDDEN_PROVIDER_ENV.test(value) || /^(?:CURSOR_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GH_TOKEN|GITHUB_TOKEN)$/i.test(value)) {
        return {
          allowed: false,
          reason: "secret-env",
          detail: "Durable provider and host credentials must remain on the host, never container env.",
        };
      }
    }
    if (/^--env=(?:CURSOR_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GH_TOKEN|GITHUB_TOKEN)=/i.test(arg)) {
      return {
        allowed: false,
        reason: "secret-env",
        detail: "Durable provider and host credentials must remain on the host, never container env.",
      };
    }
    if (
      /^(?:NODE_TLS_REJECT_UNAUTHORIZED|CURSOR_TLS_REJECT_UNAUTHORIZED)=0$/i.test(arg) ||
      ((arg === "-e" || arg === "--env") &&
        /^(?:NODE_TLS_REJECT_UNAUTHORIZED|CURSOR_TLS_REJECT_UNAUTHORIZED)=0$/i.test(
          argv[i + 1] ?? "",
        ))
    ) {
      return {
        allowed: false,
        reason: "tls-verification-disabled",
        detail: "Disabling TLS verification for the host provider proxy is forbidden.",
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
  if (spec.seccomp === "unconfined") {
    args.push("--security-opt", "seccomp=unconfined");
  }
  if (spec.workingDir) {
    args.push("--workdir", spec.workingDir);
  }
  for (const [key, value] of Object.entries(spec.labels)) {
    args.push("--label", `${key}=${value}`);
  }
  for (const tmp of spec.tmpfs) {
    args.push("--tmpfs", `${tmp.path}:${tmp.options}`);
  }
  for (const entry of spec.env ?? []) {
    args.push("--env", entry);
  }
  for (const entry of spec.extraHosts ?? []) {
    args.push("--add-host", entry);
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
        mount.readOnly
          ? `type=bind,source=${mount.source},target=${mount.target},readonly`
          : `type=bind,source=${mount.source},target=${mount.target}`,
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

const PROVIDER_KEY_SHAPED_ARG =
  /^(?:cursor_[A-Za-z0-9_-]{12,}|key_[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9]{12,})$/i;

/**
 * True when container argv contains durable provider/host credential bytes or env.
 */
export function argvLeaksProviderCredential(
  argv: readonly string[],
  apiKey?: string,
): boolean {
  const expectedKey = apiKey?.trim();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (expectedKey && arg.includes(expectedKey)) return true;
    if (PROVIDER_KEY_SHAPED_ARG.test(arg)) return true;
    if (arg === "-e" || arg === "--env") {
      const value = argv[i + 1] ?? "";
      if (FORBIDDEN_PROVIDER_ENV.test(value) || /^(?:CURSOR_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GH_TOKEN|GITHUB_TOKEN)$/i.test(value)) {
        return true;
      }
    }
    if (/^--env=(?:CURSOR_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GH_TOKEN|GITHUB_TOKEN)=/i.test(arg)) {
      return true;
    }
  }
  return false;
}

function pathsEqualLoose(a: string, b: string): boolean {
  return a.replaceAll("\\", "/").toLowerCase() === b.replaceAll("\\", "/").toLowerCase();
}

function isPathUnder(candidate: string, root: string): boolean {
  const c = candidate.replaceAll("\\", "/").toLowerCase();
  const r = root.replaceAll("\\", "/").toLowerCase().replace(/\/+$/, "");
  return c === r || c.startsWith(`${r}/`);
}
