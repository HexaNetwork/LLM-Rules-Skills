import {
  GRADLE_SANDBOX_ENV,
  gradleBuildVolumeName,
  gradleCacheVolumeName,
} from "./gradle-sandbox.js";

export type Mount = {
  host: string;
  container: string;
  readOnly?: boolean;
  /** Bind mount (host path) or Docker named volume. Defaults to bind. */
  kind?: "bind" | "volume";
};

export type ContainerSpec = {
  name: string;
  image: string;
  worktreeHost: string;
  mounts: Mount[];
  env: Record<string, string | undefined>;
  bindsSocket?: boolean;
};

export type IsolationPolicy = {
  controlRoot: string;
  harnessHome: string;
  siblingRunRoots: string[];
  projectKey?: string;
};

const FORBIDDEN_ENV = ["GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN"];

export function buildRunSpec(input: {
  runId: string;
  image: string;
  worktreeHost: string;
  cursorApiKey?: string;
  projectKey?: string;
}): ContainerSpec {
  const mounts: Mount[] = [{ host: input.worktreeHost, container: "/workspace", kind: "bind" }];
  const env: Record<string, string | undefined> = {
    CURSOR_API_KEY: input.cursorApiKey,
    HOME: "/tmp",
  };
  if (input.projectKey) {
    mounts.push(
      { host: gradleCacheVolumeName(input.projectKey), container: "/gradle-cache", kind: "volume" },
      { host: gradleBuildVolumeName(input.projectKey), container: "/gradle-build", kind: "volume" },
    );
    Object.assign(env, GRADLE_SANDBOX_ENV);
  }
  return {
    name: containerName(input.runId),
    image: input.image,
    worktreeHost: input.worktreeHost,
    mounts,
    env,
  };
}

export function containerName(runId: string): string {
  return `agent-harness-run-${runId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48)}`;
}

export function validateMounts(spec: ContainerSpec, policy: IsolationPolicy): void {
  const workspace = spec.mounts.filter((mount) => mount.container === "/workspace");
  if (workspace.length !== 1 || workspace[0]?.readOnly) {
    throw new Error("Sandbox must bind exactly one read-write worktree at /workspace");
  }
  if (normalize(workspace[0]!.host) !== normalize(spec.worktreeHost)) {
    throw new Error("Workspace bind must be the run worktree");
  }
  if (spec.bindsSocket || spec.mounts.some((mount) => mount.container === "/var/run/docker.sock")) {
    throw new Error("Docker socket mounts are forbidden");
  }
  for (const mount of spec.mounts) {
    const host = mount.host;
    const normalizedHost = normalize(host);
    if (mount.container === "/workspace") continue;
    if (mount.kind === "volume") {
      if (!isHarnessNamedVolume(host, mount.container, policy.projectKey)) {
        throw new Error(`Unexpected named volume ${host} at ${mount.container}`);
      }
      continue;
    }
    if (mount.container === "/gradle-cache" || mount.container === "/gradle-build") {
      throw new Error(`${mount.container} must use a Docker named volume, not a host bind mount`);
    }
    if (normalizedHost === normalize(spec.worktreeHost)) continue;
    if (containedBy(normalizedHost, normalize(policy.harnessHome))) {
      throw new Error("Harness home must not be mounted into the sandbox");
    }
    if (containedBy(normalizedHost, normalize(policy.controlRoot))) {
      throw new Error("Control checkout must not be mounted into the sandbox");
    }
    for (const sibling of policy.siblingRunRoots) {
      if (containedBy(normalizedHost, normalize(sibling))) {
        throw new Error("Sibling run paths must not be mounted into the sandbox");
      }
    }
  }
  for (const name of FORBIDDEN_ENV) {
    if (spec.env[name]) throw new Error(`${name} must not enter the sandbox`);
  }
}

export function forbiddenEnvNames(): readonly string[] {
  return FORBIDDEN_ENV;
}

function normalize(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function containedBy(pathValue: string, root: string): boolean {
  return pathValue === root || pathValue.startsWith(`${root}/`);
}

function isHarnessNamedVolume(name: string, container: string, projectKey?: string): boolean {
  if (container === "/gradle-cache") {
    const expected = projectKey ? gradleCacheVolumeName(projectKey) : undefined;
    return expected ? name === expected : /^agent-harness-gradle-[a-z0-9._-]+$/i.test(name);
  }
  if (container === "/gradle-build") {
    const expected = projectKey ? gradleBuildVolumeName(projectKey) : undefined;
    return expected ? name === expected : /^agent-harness-build-[a-z0-9._-]+$/i.test(name);
  }
  return false;
}
