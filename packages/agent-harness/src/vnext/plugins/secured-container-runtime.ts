import type { Context } from "@deepseek-ai/cordis";
import type { ContainerRuntimeService } from "../services/contracts.js";

export type SecuredContainerRuntimeConfig = {
  runtime: ContainerRuntimeService;
};

export const securedContainerRuntimePlugin = Object.assign(
  (ctx: Context, config: SecuredContainerRuntimeConfig): void => {
    if (!config.runtime) throw new Error("containerRuntime implementation is required");
    const secured: ContainerRuntimeService = {
      ensureImage: (reference) => config.runtime.ensureImage(reference),
      createVolume: (name, labels) => config.runtime.createVolume(name, labels),
      async start(spec, command) {
        ctx.securityPolicy.validate(spec);
        return config.runtime.start(spec, command);
      },
      stop: (containerId) => config.runtime.stop(containerId),
      removeContainer: (containerId) => config.runtime.removeContainer(containerId),
      removeVolume: (name) => config.runtime.removeVolume(name),
    };
    ctx.provide("containerRuntime", secured);
  },
  { inject: ["securityPolicy"] },
);
