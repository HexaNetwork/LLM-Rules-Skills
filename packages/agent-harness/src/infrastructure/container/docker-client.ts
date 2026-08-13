import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  DockerClient,
  DockerContainerInspect,
  DockerExecOptions,
  DockerExecResult,
  DockerImageInspect,
  DockerVolumeInspect,
} from "./types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

export type CreateDockerClientOptions = {
  /** Docker CLI binary; defaults to `docker` on PATH. */
  dockerBin?: string;
  execFile?: typeof execFileAsync;
};

/**
 * Argv-only Docker CLI client. Never constructs a shell command string.
 */
export function createDockerClient(options: CreateDockerClientOptions = {}): DockerClient {
  const bin = options.dockerBin?.trim() || "docker";
  const run = options.execFile ?? execFileAsync;

  async function exec(
    args: readonly string[],
    execOptions: DockerExecOptions = {},
  ): Promise<DockerExecResult> {
    const timeoutMs = execOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
      const result = await run(bin, [...args], {
        cwd: execOptions.cwd,
        timeout: timeoutMs,
        maxBuffer: execOptions.maxBuffer ?? DEFAULT_MAX_BUFFER,
        windowsHide: true,
        signal: execOptions.signal,
      });
      return {
        exitCode: 0,
        stdout: String(result.stdout ?? ""),
        stderr: String(result.stderr ?? ""),
        timedOut: false,
      };
    } catch (error) {
      const err = error as Error & {
        code?: string | number;
        killed?: boolean;
        stdout?: string;
        stderr?: string;
      };
      const timedOut = err.killed === true;
      const exitCode =
        typeof err.code === "number" ? err.code : timedOut ? 124 : 1;
      return {
        exitCode,
        stdout: String(err.stdout ?? ""),
        stderr: String(err.stderr ?? err.message ?? ""),
        timedOut,
      };
    }
  }

  return {
    exec,

    async version() {
      const result = await exec(["version", "--format", "{{json .}}"]);
      if (result.exitCode !== 0) {
        const fallback = await exec(["version"]);
        return { client: "unknown", raw: fallback.stdout || fallback.stderr };
      }
      try {
        const parsed = JSON.parse(result.stdout) as {
          Client?: { Version?: string; ApiVersion?: string };
          Server?: { ApiVersion?: string };
        };
        return {
          client: parsed.Client?.Version ?? "unknown",
          api: parsed.Client?.ApiVersion ?? parsed.Server?.ApiVersion,
          raw: result.stdout,
        };
      } catch {
        return { client: "unknown", raw: result.stdout };
      }
    },

    async info() {
      const result = await exec(["info", "--format", "{{json .}}"]);
      if (result.exitCode !== 0) {
        const fallback = await exec(["info"]);
        return { raw: fallback.stdout || fallback.stderr };
      }
      try {
        const parsed = JSON.parse(result.stdout) as {
          OSType?: string;
          ServerVersion?: string;
        };
        return {
          raw: result.stdout,
          osType: parsed.OSType,
          serverVersion: parsed.ServerVersion,
        };
      } catch {
        return { raw: result.stdout };
      }
    },

    async imageExists(reference: string) {
      const inspected = await this.inspectImage(reference);
      return inspected !== undefined;
    },

    async inspectImage(reference: string) {
      const result = await exec([
        "image",
        "inspect",
        reference,
        "--format",
        "{{json .}}",
      ]);
      if (result.exitCode !== 0) return undefined;
      try {
        const parsed = JSON.parse(result.stdout) as {
          Id?: string;
          RepoDigests?: string[];
          RepoTags?: string[];
          Size?: number;
        };
        const digest = parsed.RepoDigests?.[0]?.split("@")[1];
        return {
          id: parsed.Id ?? reference,
          digest,
          repoTags: parsed.RepoTags ?? [],
          size: parsed.Size,
        } satisfies DockerImageInspect;
      } catch {
        return undefined;
      }
    },

    async inspectVolume(name: string) {
      const result = await exec(["volume", "inspect", name, "--format", "{{json .}}"]);
      if (result.exitCode !== 0) return undefined;
      try {
        const parsed = JSON.parse(result.stdout) as {
          Name?: string;
          Driver?: string;
          Mountpoint?: string;
        };
        return {
          name: parsed.Name ?? name,
          driver: parsed.Driver ?? "unknown",
          mountpoint: parsed.Mountpoint,
        } satisfies DockerVolumeInspect;
      } catch {
        return undefined;
      }
    },

    async inspectContainer(nameOrId: string) {
      const result = await exec([
        "inspect",
        nameOrId,
        "--format",
        "{{json .}}",
      ]);
      if (result.exitCode !== 0) return undefined;
      try {
        const parsed = JSON.parse(result.stdout) as {
          Id?: string;
          Name?: string;
          State?: { Status?: string };
          Config?: { Labels?: Record<string, string>; Image?: string };
          NetworkSettings?: {
            Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
          };
        };
        const publishedPorts: NonNullable<DockerContainerInspect["publishedPorts"]> = [];
        for (const [key, bindings] of Object.entries(parsed.NetworkSettings?.Ports ?? {})) {
          const containerPort = Number(key.split("/")[0]);
          if (!Number.isFinite(containerPort) || !bindings) continue;
          for (const binding of bindings) {
            const hostPort = Number(binding.HostPort);
            if (!Number.isFinite(hostPort)) continue;
            publishedPorts.push({
              containerPort,
              hostPort,
              hostIp: binding.HostIp,
            });
          }
        }
        return {
          id: parsed.Id ?? nameOrId,
          name: (parsed.Name ?? nameOrId).replace(/^\//, ""),
          state: parsed.State?.Status ?? "unknown",
          labels: parsed.Config?.Labels ?? {},
          image: parsed.Config?.Image ?? "",
          publishedPorts,
        } satisfies DockerContainerInspect;
      } catch {
        return undefined;
      }
    },

    async build(args) {
      const argv = [
        "build",
        "-f",
        args.dockerfilePath,
        "-t",
        args.tag,
        ...Object.entries(args.buildArgs ?? {}).flatMap(([key, value]) => [
          "--build-arg",
          `${key}=${value}`,
        ]),
        args.contextDir,
      ];
      return exec(argv, { timeoutMs: args.timeoutMs, signal: args.signal });
    },
  };
}

/** Pure argv builder for `docker run` hardened flags (no execution). */
export function buildDockerRunArgv(spec: {
  image: string;
  name: string;
  labels: Record<string, string>;
  network: string;
  cpus: number;
  memoryMb: number;
  pidsLimit: number;
  workspaceVolume: string;
  workspaceMountPath: string;
  runStateBind: string;
  runStateMountPath: string;
  user?: string;
  entrypoint?: string[];
  command?: string[];
  publishHostPort?: { hostPort: number; containerPort: number };
}): string[] {
  const args: string[] = ["run", "-d", "--name", spec.name];
  for (const [key, value] of Object.entries(spec.labels)) {
    args.push("--label", `${key}=${value}`);
  }
  args.push(
    "--network",
    spec.network,
    "--read-only",
    "--security-opt",
    "no-new-privileges:true",
    "--cap-drop",
    "ALL",
    "--pids-limit",
    String(spec.pidsLimit),
    "--cpus",
    String(spec.cpus),
    "--memory",
    `${spec.memoryMb}m`,
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--mount",
    `type=volume,source=${spec.workspaceVolume},target=${spec.workspaceMountPath}`,
    "--mount",
    `type=bind,source=${spec.runStateBind},target=${spec.runStateMountPath},readonly=false`,
  );
  if (spec.user) {
    args.push("--user", spec.user);
  }
  if (spec.publishHostPort) {
    args.push(
      "--publish",
      `127.0.0.1:${spec.publishHostPort.hostPort}:${spec.publishHostPort.containerPort}`,
    );
  }
  if (spec.entrypoint) {
    args.push("--entrypoint", spec.entrypoint[0]!);
    // Remaining entrypoint args become command when using --entrypoint binary form;
    // callers should pass full command separately when needed.
  }
  args.push(spec.image);
  if (spec.command) {
    args.push(...spec.command);
  } else if (spec.entrypoint && spec.entrypoint.length > 1) {
    args.push(...spec.entrypoint.slice(1));
  }
  return args;
}

/** @deprecated Prefer DockerClient; retained for inspect helpers in later slices. */
export type { DockerContainerInspect };
