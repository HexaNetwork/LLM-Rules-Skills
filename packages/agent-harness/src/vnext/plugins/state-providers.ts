import type { Context } from "@deepseek-ai/cordis";
import type { RunStatePort } from "../../application/run-state-port.js";
import type { RunArtifactsService } from "../services/contracts.js";

export type RunStateProviderConfig = {
  port: RunStatePort;
  artifacts: RunArtifactsService;
};

/** Mount either the filesystem (host/test) or RPC (worker) adapter as services. */
export function runStateProviderPlugin(ctx: Context, config: RunStateProviderConfig): void {
  if (!config.port || !config.artifacts) {
    throw new Error("runState provider requires both the typed state port and artifact adapter");
  }
  ctx.provide("runState", config.port);
  ctx.provide("runArtifacts", config.artifacts);
}
