export type Mount = {
  host: string;
  container: string;
  readOnly?: boolean;
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
};

const FORBIDDEN_ENV = ["GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN"];

export function buildRunSpec(input: {
  runId: string;
  image: string;
  worktreeHost: string;
  cursorApiKey?: string;
}): ContainerSpec {
  return {
    name: containerName(input.runId),
    image: input.image,
    worktreeHost: input.worktreeHost,
    mounts: [{ host: input.worktreeHost, container: "/workspace" }],
    env: {
      CURSOR_API_KEY: input.cursorApiKey,
      HOME: "/tmp",
    },
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
    const host = normalize(mount.host);
    if (host === normalize(spec.worktreeHost)) continue;
    if (containedBy(host, normalize(policy.harnessHome))) {
      throw new Error("Harness home must not be mounted into the sandbox");
    }
    if (containedBy(host, normalize(policy.controlRoot))) {
      throw new Error("Control checkout must not be mounted into the sandbox");
    }
    for (const sibling of policy.siblingRunRoots) {
      if (containedBy(host, normalize(sibling))) {
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
