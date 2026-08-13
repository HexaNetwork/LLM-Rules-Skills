import type {
  DockerClient,
  DockerContainerInspect,
  DockerExecOptions,
  DockerExecResult,
  DockerImageInspect,
  DockerVolumeInspect,
} from "./types.js";

export type FakeDockerCall = {
  args: string[];
  options?: DockerExecOptions;
};

export type FakeDockerClientOptions = {
  /** Scripted responses keyed by joined argv (space-separated). First match wins FIFO. */
  scripted?: Array<{ match: RegExp | string; result: DockerExecResult }>;
  images?: Map<string, DockerImageInspect>;
  volumes?: Map<string, DockerVolumeInspect>;
  containers?: Map<string, DockerContainerInspect>;
  /** When true, version/info succeed as a healthy Linux daemon. */
  healthy?: boolean;
  clientVersion?: string;
  apiVersion?: string;
  osType?: string;
  serverVersion?: string;
};

/**
 * In-memory DockerClient for unit tests. Never touches a real Docker daemon.
 */
export function createFakeDockerClient(
  options: FakeDockerClientOptions = {},
): DockerClient & {
  calls: FakeDockerCall[];
  scripted: NonNullable<FakeDockerClientOptions["scripted"]>;
  images: Map<string, DockerImageInspect>;
  volumes: Map<string, DockerVolumeInspect>;
  containers: Map<string, DockerContainerInspect>;
} {
  const calls: FakeDockerCall[] = [];
  const scripted = [...(options.scripted ?? [])];
  const images = options.images ?? new Map<string, DockerImageInspect>();
  const volumes = options.volumes ?? new Map<string, DockerVolumeInspect>();
  const containers = options.containers ?? new Map<string, DockerContainerInspect>();
  const healthy = options.healthy ?? true;
  const clientVersion = options.clientVersion ?? "27.0.0";
  const apiVersion = options.apiVersion ?? "1.45";
  const osType = options.osType ?? "linux";
  const serverVersion = options.serverVersion ?? "27.0.0";

  function nextScripted(args: readonly string[]): DockerExecResult | undefined {
    const joined = args.join(" ");
    const index = scripted.findIndex((entry) =>
      typeof entry.match === "string" ? joined.includes(entry.match) : entry.match.test(joined),
    );
    if (index < 0) return undefined;
    const [entry] = scripted.splice(index, 1);
    return entry?.result;
  }

  const client: DockerClient & {
    calls: FakeDockerCall[];
    scripted: NonNullable<FakeDockerClientOptions["scripted"]>;
    images: Map<string, DockerImageInspect>;
    volumes: Map<string, DockerVolumeInspect>;
    containers: Map<string, DockerContainerInspect>;
  } = {
    calls,
    scripted,
    images,
    volumes,
    containers,

    async exec(args, execOptions) {
      calls.push({ args: [...args], options: execOptions });
      const scriptedResult = nextScripted(args);
      if (scriptedResult) return scriptedResult;

      const head = args[0];
      if (head === "version") {
        if (!healthy) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "Cannot connect to the Docker daemon",
            timedOut: false,
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            Client: { Version: clientVersion, ApiVersion: apiVersion },
            Server: { ApiVersion: apiVersion },
          }),
          stderr: "",
          timedOut: false,
        };
      }
      if (head === "info") {
        if (!healthy) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "Cannot connect to the Docker daemon",
            timedOut: false,
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({ OSType: osType, ServerVersion: serverVersion }),
          stderr: "",
          timedOut: false,
        };
      }
      if (head === "image" && args[1] === "inspect") {
        const reference = args[2] ?? "";
        const image = images.get(reference);
        if (!image) {
          return { exitCode: 1, stdout: "", stderr: "No such image", timedOut: false };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            Id: image.id,
            RepoDigests: image.digest ? [`repo@${image.digest}`] : [],
            RepoTags: image.repoTags,
            Size: image.size,
          }),
          stderr: "",
          timedOut: false,
        };
      }
      if (head === "volume" && args[1] === "inspect") {
        const name = args[2] ?? "";
        const volume = volumes.get(name);
        if (!volume) {
          return { exitCode: 1, stdout: "", stderr: "No such volume", timedOut: false };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify(volume),
          stderr: "",
          timedOut: false,
        };
      }
      if (head === "volume" && args[1] === "create") {
        const name = args[2] ?? "vol";
        volumes.set(name, { name, driver: "local" });
        return { exitCode: 0, stdout: name, stderr: "", timedOut: false };
      }
      if (head === "inspect") {
        const name = args[1] ?? "";
        const container = containers.get(name);
        if (!container) {
          return { exitCode: 1, stdout: "", stderr: "No such container", timedOut: false };
        }
        const ports: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
        for (const published of container.publishedPorts ?? []) {
          const key = `${published.containerPort}/tcp`;
          ports[key] = [
            {
              HostIp: published.hostIp ?? "127.0.0.1",
              HostPort: String(published.hostPort),
            },
          ];
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            Id: container.id,
            Name: `/${container.name}`,
            State: { Status: container.state },
            Config: { Labels: container.labels, Image: container.image },
            NetworkSettings: { Ports: ports },
          }),
          stderr: "",
          timedOut: false,
        };
      }
      if (head === "pull") {
        const reference = args[1] ?? "image";
        const digestMatch = reference.match(/@sha256:([a-f0-9]{64})$/i);
        const digest = digestMatch ? `sha256:${digestMatch[1]}` : `sha256:${"d".repeat(64)}`;
        const nameTag = reference.includes("@")
          ? reference.slice(0, reference.indexOf("@"))
          : reference;
        images.set(reference, {
          id: digest,
          digest,
          repoTags: [nameTag],
        });
        if (nameTag !== reference) {
          images.set(nameTag, {
            id: digest,
            digest,
            repoTags: [nameTag],
          });
        }
        return { exitCode: 0, stdout: `Pulled ${reference}\n`, stderr: "", timedOut: false };
      }
      if (head === "build") {
        return { exitCode: 0, stdout: "Successfully built fake\n", stderr: "", timedOut: false };
      }
      if (head === "rm") {
        const force = args.includes("-f");
        const name = args.find((arg, i) => i > 0 && !arg.startsWith("-")) ?? "";
        if (containers.has(name) || force) {
          containers.delete(name);
          return { exitCode: 0, stdout: name, stderr: "", timedOut: false };
        }
        return { exitCode: 1, stdout: "", stderr: "No such container", timedOut: false };
      }
      if (head === "volume" && args[1] === "rm") {
        const name = args.find((arg, i) => i > 1 && !arg.startsWith("-")) ?? "";
        volumes.delete(name);
        return { exitCode: 0, stdout: name, stderr: "", timedOut: false };
      }
      if (head === "ps") {
        const lines = [...containers.values()].map((container) =>
          JSON.stringify({
            ID: container.id,
            Names: container.name,
            State: container.state,
            Image: container.image,
            Labels: Object.entries(container.labels)
              .map(([k, v]) => `${k}=${v}`)
              .join(","),
            CreatedAt: new Date(0).toISOString(),
          }),
        );
        return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "", timedOut: false };
      }
      if (head === "run") {
        const nameIdx = args.indexOf("--name");
        const name = nameIdx >= 0 ? (args[nameIdx + 1] ?? "fake") : "fake";
        const publishIdx = args.indexOf("--publish");
        const publish = publishIdx >= 0 ? args[publishIdx + 1] : undefined;
        let hostPort: number | undefined;
        let containerPort: number | undefined;
        if (publish) {
          const match = publish.match(/127\.0\.0\.1:(\d+):(\d+)/);
          if (match) {
            hostPort = Number(match[1]);
            containerPort = Number(match[2]);
          }
        }
        const id = `fake-container-${name}`;
        containers.set(name, {
          id,
          name,
          state: "running",
          labels: {},
          image: args[args.length - 1] ?? "image",
          publishedPorts:
            hostPort && containerPort
              ? [{ hostPort, containerPort, hostIp: "127.0.0.1" }]
              : undefined,
        });
        return { exitCode: 0, stdout: `${id}\n`, stderr: "", timedOut: false };
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    },

    async version() {
      const result = await this.exec(["version", "--format", "{{json .}}"]);
      if (result.exitCode !== 0) {
        return { client: "unknown", raw: result.stderr };
      }
      const parsed = JSON.parse(result.stdout) as {
        Client?: { Version?: string; ApiVersion?: string };
      };
      return {
        client: parsed.Client?.Version ?? clientVersion,
        api: parsed.Client?.ApiVersion ?? apiVersion,
        raw: result.stdout,
      };
    },

    async info() {
      const result = await this.exec(["info", "--format", "{{json .}}"]);
      if (result.exitCode !== 0) {
        return { raw: result.stderr };
      }
      const parsed = JSON.parse(result.stdout) as {
        OSType?: string;
        ServerVersion?: string;
      };
      return {
        raw: result.stdout,
        osType: parsed.OSType,
        serverVersion: parsed.ServerVersion,
      };
    },

    async imageExists(reference) {
      return (await this.inspectImage(reference)) !== undefined;
    },

    async inspectImage(reference) {
      const result = await this.exec([
        "image",
        "inspect",
        reference,
        "--format",
        "{{json .}}",
      ]);
      if (result.exitCode !== 0) return undefined;
      const parsed = JSON.parse(result.stdout) as {
        Id?: string;
        RepoDigests?: string[];
        RepoTags?: string[];
        Size?: number;
      };
      return {
        id: parsed.Id ?? reference,
        digest: parsed.RepoDigests?.[0]?.split("@")[1],
        repoTags: parsed.RepoTags ?? [],
        size: parsed.Size,
      };
    },

    async inspectVolume(name) {
      const result = await this.exec(["volume", "inspect", name, "--format", "{{json .}}"]);
      if (result.exitCode !== 0) return undefined;
      return JSON.parse(result.stdout) as DockerVolumeInspect;
    },

    async inspectContainer(nameOrId) {
      const result = await this.exec(["inspect", nameOrId, "--format", "{{json .}}"]);
      if (result.exitCode !== 0) return undefined;
      const direct = containers.get(nameOrId);
      if (direct) return direct;
      for (const container of containers.values()) {
        if (container.id === nameOrId || container.name === nameOrId) return container;
      }
      return undefined;
    },

    async build(args) {
      const result = await this.exec(
        [
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
        ],
        { timeoutMs: args.timeoutMs, signal: args.signal },
      );
      if (result.exitCode === 0) {
        const digest = `sha256:${"c".repeat(64)}`;
        images.set(args.tag, {
          id: digest,
          digest,
          repoTags: [args.tag],
        });
      }
      return result;
    },
  };

  return client;
}
