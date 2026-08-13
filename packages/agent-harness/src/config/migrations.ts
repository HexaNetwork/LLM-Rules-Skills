import { HarnessConfigSchema, type HarnessConfig } from "./schema.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read compatibility for Graphify and CodeGraph-era live/frozen configs. */
export function rewriteGraphifyConfigKeys(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const candidate: Record<string, unknown> = { ...raw };

  if (isRecord(candidate.workflow)) {
    const {
      graphifyCharacters,
      codegraphCharacters,
      ...workflow
    } = candidate.workflow;
    candidate.workflow = Object.hasOwn(workflow, "repositoryContextCharacters")
      ? workflow
      : {
          ...workflow,
          repositoryContextCharacters: codegraphCharacters ?? graphifyCharacters,
        };
  }

  if (!isRecord(candidate.knowledge)) {
    return candidate;
  }

  const { graphify, codegraph, ...knowledge } = candidate.knowledge;
  if (!Object.hasOwn(knowledge, "repositoryIntelligence")) {
    const legacyCodegraph = isRecord(codegraph)
      ? codegraph
      : isRecord(graphify)
        ? mapGraphifySettings(graphify)
        : undefined;
    if (legacyCodegraph) {
      knowledge.repositoryIntelligence = mapCodegraphSettings(legacyCodegraph);
    }
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

function mapCodegraphSettings(codegraph: Record<string, unknown>): Record<string, unknown> {
  const provider: Record<string, unknown> = {
    command: typeof codegraph.command === "string" ? codegraph.command : "codegraph",
  };
  for (const key of ["enabled", "updateTimeoutMs", "queryTimeoutMs", "stopwords"] as const) {
    if (codegraph[key] !== undefined) provider[key] = codegraph[key];
  }
  if (typeof codegraph.maxFiles === "number") provider.maxResults = codegraph.maxFiles;
  return {
    enabled: typeof codegraph.enabled === "boolean" ? codegraph.enabled : true,
    ...(Array.isArray(codegraph.roles) ? { roles: codegraph.roles } : {}),
    ...(Array.isArray(codegraph.sourceExtensions)
      ? { sourceExtensions: codegraph.sourceExtensions }
      : {}),
    providers: {
      gitnexus: { enabled: false, command: "gitnexus" },
      codegraph: provider,
    },
    routes: {
      search: ["codegraph"],
      "symbol-context": ["codegraph"],
      impact: [],
      trace: [],
      "change-impact": [],
    },
  };
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
