import path from "node:path";
import { HarnessConfigSchema, type HarnessConfig } from "./schema.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Paths that historically pointed harness guidance into knowledge.sources.
 * Guidance is injected-only now and must not be indexed.
 */
export function isLegacyGuidanceSourcePath(sourcePath: string): boolean {
  const normalized = sourcePath.replaceAll("\\", "/").replace(/\/+$/, "");
  if (
    normalized === "agent-harness/guidance/General" ||
    normalized === "agent-harness/guidance" ||
    normalized === "General"
  ) {
    return true;
  }
  if (
    /(?:^|\/)agent-harness\/guidance(?:\/General)?$/i.test(normalized) ||
    /(?:^|\/)agent-harness\/guidance\//i.test(normalized)
  ) {
    return true;
  }
  // Absolute harness-home guidance trees (platform-local AppData / Library / .local).
  if (/\/agent-harness\/guidance(?:\/|$)/i.test(normalized)) return true;
  return false;
}

export function stripLegacyGuidanceSources(
  sources: unknown[] | undefined,
): { sources: unknown[] | undefined; sharedRoot?: string } {
  if (!sources) return { sources: undefined };
  let sharedRoot: string | undefined;
  const retained: unknown[] = [];
  for (const source of sources) {
    const sourcePath =
      typeof source === "string"
        ? source
        : isRecord(source) && typeof source.path === "string"
          ? source.path
          : undefined;
    if (sourcePath && isLegacyGuidanceSourcePath(sourcePath)) {
      if (path.isAbsolute(sourcePath) && !sharedRoot) {
        const normalized = sourcePath.replaceAll("\\", "/").replace(/\/+$/, "");
        sharedRoot = normalized.replace(/\/General$/i, "");
      }
      continue;
    }
    retained.push(source);
  }
  return { sources: retained, sharedRoot };
}

/**
 * Normalize a frozen per-run config snapshot into a HarnessConfig.
 * Older snapshots without knowledge.guidance keep guidance disabled so
 * in-progress deliveries do not silently change retrieval behavior.
 * Legacy guidance paths are stripped from knowledge.sources.
 */
export function normalizeFrozenRunConfig(raw: unknown): HarnessConfig {
  const { configVersion: _configVersion, ...withoutVersion } = isRecord(raw)
    ? raw
    : { configVersion: undefined };
  let candidate: Record<string, unknown> = isRecord(withoutVersion)
    ? { ...withoutVersion }
    : {};

  if (isRecord(candidate.knowledge) && Array.isArray(candidate.knowledge.sources)) {
    const knowledge = { ...candidate.knowledge };
    const stripped = stripLegacyGuidanceSources(knowledge.sources as unknown[]);
    knowledge.sources = stripped.sources ?? [];
    if (stripped.sharedRoot) {
      const guidance = isRecord(knowledge.guidance) ? { ...knowledge.guidance } : {};
      if (typeof guidance.sharedRoot !== "string" || !guidance.sharedRoot.trim()) {
        guidance.sharedRoot = stripped.sharedRoot;
      }
      knowledge.guidance = guidance;
    }
    candidate = { ...candidate, knowledge };
  }

  if (
    isRecord(candidate) &&
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
