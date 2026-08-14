import type { Context } from "@deepseek-ai/cordis";
import { hardenedSpecToRunArgv } from "../../infrastructure/container/container-spec.js";
import type { DockerClient } from "../../infrastructure/container/types.js";
import type { ContainerRuntimeService } from "../services/contracts.js";

export type DockerRuntimePluginConfig = {
  docker: DockerClient;
};

export function createDockerRuntimeService(docker: DockerClient): ContainerRuntimeService {
  return {
    async ensureImage(reference) {
      let image = await docker.inspectImage(reference);
      if (!image) {
        const pulled = await docker.exec(["pull", reference], { timeoutMs: 300_000 });
        if (pulled.exitCode !== 0) {
          throw new Error(`Unable to pull immutable worker image: ${pulled.stderr || pulled.stdout}`);
        }
        image = await docker.inspectImage(reference);
      }
      if (!image) throw new Error(`Docker image did not resolve after pull: ${reference}`);
      const digest = image.digest ?? image.id;
      if (!/^sha256:[a-f0-9]{64}$/i.test(digest)) {
        throw new Error(`Docker returned a non-digest image identity for ${reference}: ${digest}`);
      }
      return { reference, digest: digest.toLowerCase() };
    },
    async createVolume(name, labels) {
      const existing = await docker.inspectVolume(name);
      if (existing) return;
      const argv = ["volume", "create"];
      for (const [key, value] of Object.entries(labels)) argv.push("--label", `${key}=${value}`);
      argv.push(name);
      const created = await docker.exec(argv);
      if (created.exitCode !== 0) {
        throw new Error(`Unable to create workspace volume ${name}: ${created.stderr || created.stdout}`);
      }
    },
    async start(spec, command) {
      const result = await docker.exec(hardenedSpecToRunArgv(spec, { command }), {
        timeoutMs: 120_000,
      });
      if (result.exitCode !== 0) {
        throw new Error(`Unable to start worker ${spec.name}: ${result.stderr || result.stdout}`);
      }
      return { containerId: result.stdout.trim() || spec.name };
    },
    async stop(containerId) {
      const result = await docker.exec(["stop", containerId]);
      if (result.exitCode !== 0 && !/no such container/i.test(result.stderr)) {
        throw new Error(`Unable to stop container ${containerId}: ${result.stderr || result.stdout}`);
      }
    },
    async removeContainer(containerId) {
      const result = await docker.exec(["rm", "-f", containerId]);
      if (result.exitCode !== 0 && !/no such container/i.test(result.stderr)) {
        throw new Error(`Unable to remove container ${containerId}: ${result.stderr || result.stdout}`);
      }
    },
    async removeVolume(name) {
      const result = await docker.exec(["volume", "rm", name]);
      if (result.exitCode !== 0 && !/no such volume/i.test(result.stderr)) {
        throw new Error(`Unable to remove volume ${name}: ${result.stderr || result.stdout}`);
      }
    },
  };
}

/**
 * Raw Docker adapter. Production profiles expose it only through
 * securedContainerRuntimePlugin so container creation cannot bypass policy.
 */
export function dockerRuntimePlugin(ctx: Context, config: DockerRuntimePluginConfig): void {
  if (!config.docker) throw new Error("Docker runtime plugin requires a Docker client");
  ctx.provide("containerRuntime", createDockerRuntimeService(config.docker));
}
