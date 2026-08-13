import { HarnessConfigSchema, type HarnessConfig } from "./schema.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rewrite retired Graphify config keys onto CodeGraph before schema parse.
 * Live YAML and frozen run snapshots that still say `knowledge.graphify` keep
 * their enabled/timeout/budget choices instead of falling through to the
 * CodeGraph schema default (enabled).
 */
export function rewriteGraphifyConfigKeys(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const candidate: Record<string, unknown> = { ...raw };

  if (isRecord(candidate.workflow) && Object.hasOwn(candidate.workflow, "graphifyCharacters")) {
    const { graphifyCharacters, ...workflow } = candidate.workflow;
    candidate.workflow = Object.hasOwn(workflow, "codegraphCharacters")
      ? workflow
      : { ...workflow, codegraphCharacters: graphifyCharacters };
  }

  if (!isRecord(candidate.knowledge) || !Object.hasOwn(candidate.knowledge, "graphify")) {
    return candidate;
  }

  const { graphify, ...knowledge } = candidate.knowledge;
  if (!Object.hasOwn(knowledge, "codegraph") && isRecord(graphify)) {
    knowledge.codegraph = mapGraphifySettings(graphify);
  }
  candidate.knowledge = knowledge;
  return candidate;
}

function mapGraphifySettings(graphify: Record<string, unknown>): Record<string, unknown> {
  const codegraph: Record<string, unknown> = {};
  if (typeof graphify.enabled === "boolean") codegraph.enabled = graphify.enabled;
  if (typeof graphify.command === "string") codegraph.command = graphify.command;
  if (typeof graphify.updateOnRefresh === "boolean") {
    codegraph.updateOnRefresh = graphify.updateOnRefresh;
  }
  if (typeof graphify.updateTimeoutMs === "number") {
    codegraph.updateTimeoutMs = graphify.updateTimeoutMs;
  }
  if (typeof graphify.queryTimeoutMs === "number") {
    codegraph.queryTimeoutMs = graphify.queryTimeoutMs;
  }
  if (typeof graphify.maxFiles === "number") codegraph.maxFiles = graphify.maxFiles;
  else if (typeof graphify.queryBudgetTokens === "number") {
    codegraph.maxFiles = graphify.queryBudgetTokens;
  }
  if (Array.isArray(graphify.roles)) codegraph.roles = graphify.roles;
  if (Array.isArray(graphify.stopwords)) codegraph.stopwords = graphify.stopwords;
  if (Array.isArray(graphify.sourceExtensions)) {
    codegraph.sourceExtensions = graphify.sourceExtensions;
  }
  return codegraph;
}

/**
 * Normalize a frozen per-run config snapshot into a HarnessConfig.
 * Snapshots without knowledge.guidance keep guidance disabled so
 * in-progress deliveries do not silently change retrieval behavior (ADR 0006).
 */
export function normalizeFrozenRunConfig(raw: unknown): HarnessConfig {
  const rewritten = rewriteGraphifyConfigKeys(raw);
  const { configVersion: _configVersion, ...withoutVersion } = isRecord(rewritten)
    ? rewritten
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
