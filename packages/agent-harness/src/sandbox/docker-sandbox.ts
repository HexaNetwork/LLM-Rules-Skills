import { HARNESS_PACKAGE_VERSION } from "../worker/protocol.js";
import { HarnessFailure } from "../errors.js";
import {
  buildHardenedContainerSpec,
  denyInsecureContainerArgv,
  hardenedSpecToRunArgv,
} from "../infrastructure/container/container-spec.js";
import type { DockerClient } from "../infrastructure/container/types.js";
import {
  HARNESS_RPC_URL_ENV,
  HARNESS_WORKER_TOKEN_ENV,
  type Sandbox,
  type SandboxCreateInput,
  type SandboxProvider,
} from "./types.js";

const FORBIDDEN_ENV = /^(CURSOR_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GH_TOKEN|GITHUB_TOKEN)=/i;

/**
 * Docker adapter for disposable create/exec/destroy sandboxes.
 * Workspace and host-owned state survive destroy; only the container is removed.
 */
export class DockerSandboxProvider implements SandboxProvider {
  constructor(private readonly docker: DockerClient) {}

  async create(input: SandboxCreateInput): Promise<Sandbox> {
    const env = [...(input.env ?? [])];
    if (env.some((entry) => FORBIDDEN_ENV.test(entry))) {
      throw new HarnessFailure(
        "Sandbox env must not carry durable provider or host credentials",
        "execution",
        false,
      );
    }
    const spec = buildHardenedContainerSpec({
      name: input.name,
      image: input.image,
      projectKey: input.projectKey,
      runId: input.runId,
      harnessVersion: HARNESS_PACKAGE_VERSION,
      dockerPolicy: input.dockerPolicy,
      workspace:
        input.workspace.kind === "bind"
          ? { kind: "bind", hostPath: input.workspace.hostPath }
          : { kind: "volume", volumeName: input.workspace.volumeName },
      environment: env,
      publicReadOnlyMounts: input.publicReadOnlyMounts,
      workingDir: input.workingDir ?? "/workspace",
      user: input.user,
      runsCursorSandbox: input.runsCursorSandbox,
    });
    const argv = hardenedSpecToRunArgv(spec, {
      ...(input.command
        ? { command: input.command }
        : { entrypoint: ["sleep"], command: ["infinity"] }),
    });
    const denied = denyInsecureContainerArgv(argv);
    if (!denied.allowed) {
      throw new HarnessFailure(denied.detail, "execution", false);
    }
    const started = await this.docker.exec(argv);
    if (started.exitCode !== 0) {
      throw new HarnessFailure(
        `Failed to create sandbox: ${started.stderr || started.stdout}`,
        "execution",
        true,
      );
    }
    const id = started.stdout.trim().slice(0, 64) || input.name;
    return new DockerSandbox(this.docker, id, input.name);
  }
}

class DockerSandbox implements Sandbox {
  constructor(
    private readonly docker: DockerClient,
    readonly id: string,
    readonly name: string,
  ) {}

  async exec(
    command: readonly string[],
    options: { timeoutMs?: number; input?: string; signal?: AbortSignal } = {},
  ): Promise<import("../infrastructure/container/types.js").DockerExecResult> {
    return this.docker.exec(["exec", ...(options.input === undefined ? [] : ["-i"]), this.name, ...command], {
      timeoutMs: options.timeoutMs,
      input: options.input,
      signal: options.signal,
    });
  }

  async destroy(): Promise<void> {
    await this.docker.exec(["rm", "-f", this.name]);
  }
}

export function harnessWorkerEnv(input: {
  rpcUrl: string;
  token: string;
}): string[] {
  return [`${HARNESS_RPC_URL_ENV}=${input.rpcUrl}`, `${HARNESS_WORKER_TOKEN_ENV}=${input.token}`];
}
