/**
 * Docker control-plane ports (ADR 0015). Implementations must use argv arrays only —
 * never shell command construction.
 */

export type DockerExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type DockerExecOptions = {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Max combined stdout/stderr retained (bytes). */
  maxBuffer?: number;
};

export type DockerImageInspect = {
  id: string;
  digest?: string;
  repoTags: string[];
  size?: number;
};

export type DockerVolumeInspect = {
  name: string;
  driver: string;
  mountpoint?: string;
};

export type DockerContainerInspect = {
  id: string;
  name: string;
  state: string;
  labels: Record<string, string>;
  image: string;
  /** Published ports rediscovered from inspect (loopback preferred). */
  publishedPorts?: Array<{
    containerPort: number;
    hostPort: number;
    hostIp?: string;
  }>;
};

/**
 * Narrow argv-based Docker CLI surface used by the harness control plane.
 * Real implementation shells out via execFile; tests inject FakeDockerClient.
 */
export type DockerClient = {
  /** Run `docker <args…>` with no shell. */
  exec(args: readonly string[], options?: DockerExecOptions): Promise<DockerExecResult>;
  version(): Promise<{ client: string; api?: string; raw: string }>;
  info(): Promise<{ raw: string; osType?: string; serverVersion?: string }>;
  imageExists(reference: string): Promise<boolean>;
  inspectImage(reference: string): Promise<DockerImageInspect | undefined>;
  inspectVolume(name: string): Promise<DockerVolumeInspect | undefined>;
  /** Optional until all fakes implement it; session affinity uses name/id. */
  inspectContainer?(nameOrId: string): Promise<DockerContainerInspect | undefined>;
  build(args: {
    contextDir: string;
    dockerfilePath: string;
    tag: string;
    buildArgs?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<DockerExecResult>;
};
