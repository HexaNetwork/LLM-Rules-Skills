import type { Context } from "@deepseek-ai/cordis";
import {
  readMainDockerfile,
  readRunDockerfile,
  runImageTag,
} from "./image-repair.js";
import type { Run } from "./types.js";

export type VerificationRuntime = {
  mode: "docker" | "none";
  image: string;
  dockerfile?: string;
};

/** Effective sandbox mode, worker image, and Dockerfile for verification-aware roles. */
export async function resolveVerificationRuntime(
  ctx: Context,
  run: Run,
): Promise<VerificationRuntime> {
  const mode = ctx.sandbox.mode;
  if (mode === "none") {
    return {
      mode: "none",
      image: ctx.sandbox.image,
    };
  }

  const runDockerfile = await readRunDockerfile(ctx.store.home, run.identity.runId);
  if (runDockerfile !== undefined) {
    return {
      mode: "docker",
      image: runImageTag(run.identity.runId),
      dockerfile: runDockerfile,
    };
  }

  return {
    mode: "docker",
    image: ctx.sandbox.image,
    dockerfile: await readMainDockerfile(),
  };
}
