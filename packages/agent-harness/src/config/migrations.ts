import { HarnessConfigSchema, type HarnessConfig } from "./schema.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize a frozen per-run config snapshot into a HarnessConfig.
 * Older snapshots without knowledge.guidance keep guidance disabled so
 * in-progress deliveries do not silently change retrieval behavior.
 */
export function normalizeFrozenRunConfig(raw: unknown): HarnessConfig {
  const { configVersion: _configVersion, ...withoutVersion } = isRecord(raw)
    ? raw
    : { configVersion: undefined };
  if (
    isRecord(withoutVersion) &&
    isRecord(withoutVersion.knowledge) &&
    !Object.hasOwn(withoutVersion.knowledge, "guidance")
  ) {
    return HarnessConfigSchema.parse({
      ...withoutVersion,
      knowledge: { ...withoutVersion.knowledge, guidance: { enabled: false } },
    });
  }
  return HarnessConfigSchema.parse(withoutVersion);
}

/**
 * Apply live project policy overlays that are intentionally not frozen
 * (and omitted from configurationHash).
 */
export function applyLiveProjectPolicy(
  frozen: HarnessConfig,
  _projectConfig: HarnessConfig,
): HarnessConfig {
  return frozen;
}
