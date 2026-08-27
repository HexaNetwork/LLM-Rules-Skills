import { readFile } from "node:fs/promises";
import path from "node:path";
import type { EffectiveConfig, JsonObject } from "./types.js";

export const DEFAULT_CONFIG: EffectiveConfig = {
  coordinatorUrl: "http://127.0.0.1:8787",
  runnerImage: "hexanetwork/agent-harness-runner:1.0.0",
  agentDeadlineMs: 30 * 60_000,
  implementationAttemptLimit: 3,
  finalRepairAttemptLimit: 2,
  dockerBuildConcurrency: 1,
  models: {},
  publication: { remote: "origin", draft: false },
};

export async function readConfig(home: string, projectOverrides?: JsonObject): Promise<EffectiveConfig> {
  let disk: JsonObject = {};
  try { disk = JSON.parse(await readFile(path.join(home, "config.json"), "utf8")) as JsonObject; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return mergeConfig(DEFAULT_CONFIG, disk, projectOverrides ?? {});
}

export function mergeConfig(...values: Array<Partial<EffectiveConfig> | JsonObject>): EffectiveConfig {
  const merged = Object.assign({}, ...values) as EffectiveConfig;
  merged.models = Object.assign({}, DEFAULT_CONFIG.models, ...values.map((v) => v.models ?? {}));
  merged.publication = Object.assign({}, DEFAULT_CONFIG.publication, ...values.map((v) => v.publication ?? {}));
  if (!Number.isFinite(merged.agentDeadlineMs) || merged.agentDeadlineMs <= 0) throw new Error("agentDeadlineMs must be positive");
  return merged;
}
