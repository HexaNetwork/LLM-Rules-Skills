import type { Context } from "@deepseek-ai/cordis";
import type { EnvironmentService } from "../services/contracts.js";

const DIGEST_REFERENCE = /@(?<digest>sha256:[a-f0-9]{64})$/i;

export type ImmutableEnvironmentConfig = {
  image: string;
};

export const immutableEnvironmentPlugin = Object.assign(
  (ctx: Context, config: ImmutableEnvironmentConfig): void => {
    const expected = DIGEST_REFERENCE.exec(config.image)?.groups?.digest?.toLowerCase();
    if (!expected) {
      throw new Error(
        `Environment image must be an immutable digest reference (name@sha256:<64 hex>): ${config.image}`,
      );
    }
    const environment: EnvironmentService = {
      image: config.image,
      async resolve() {
        const resolved = await ctx.containerRuntime.ensureImage(config.image);
        if (resolved.digest.toLowerCase() !== expected) {
          throw new Error(
            `Environment digest mismatch: expected ${expected}, Docker resolved ${resolved.digest}`,
          );
        }
        return resolved;
      },
    };
    ctx.provide("environment", environment);
  },
  { inject: ["containerRuntime"] },
);
