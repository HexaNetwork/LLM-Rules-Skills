import { HarnessConfigSchema, type HarnessConfig } from "./schema.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize a frozen per-run config snapshot into a HarnessConfig.
 * Snapshots without knowledge.guidance keep guidance disabled so
 * in-progress deliveries do not silently change retrieval behavior (ADR 0006).
 */
export function normalizeFrozenRunConfig(raw: unknown): HarnessConfig {
  const { configVersion: _configVersion, ...withoutVersion } = isRecord(raw)
    ? raw
    : { configVersion: undefined };
  const candidate: Record<string, unknown> = isRecord(withoutVersion)
    ? { ...withoutVersion }
    : {};

  if (
    isRecord(candidate.knowledge) &&
    !Object.hasOwn(candidate.knowledge, "guidance")
  ) {
    return HarnessConfigSchema.parse({
      ...candidate,
      knowledge: { ...candidate.knowledge, guidance: { enabled: false } },
    });
  }
  return HarnessConfigSchema.parse(candidate);
}
