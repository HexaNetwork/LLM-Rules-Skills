import type { HarnessConfig } from "../../config.js";
import { normalizePath } from "./path-utils.js";
import type {
  IndexedSearchResult,
  KnowledgeChunk,
  KnowledgeSearchAudit,
  RetrievalAudit,
  RetrievalOmission,
  SearchResult,
} from "./types.js";

export function tokenize(value: string): string[] {
  return value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
}

export function scoreText(value: string, terms: string[]): number {
  const termSet = new Set(terms);
  let score = 0;
  for (const term of tokenize(value)) {
    if (termSet.has(term)) score += 1;
  }
  return score;
}

export function isVisibleToProject(
  chunk: Pick<KnowledgeChunk, "scope" | "projectId" | "visibility">,
  activeProjectId: string,
  includedProjects: string[],
): boolean {
  if (chunk.scope === "global") return true;
  if (chunk.projectId === activeProjectId) return true;
  return chunk.visibility === "shared" && includedProjects.includes(chunk.projectId ?? "");
}

/**
 * Defense in depth: run artifacts under `<stateDirectory>/runs/<id>/` are visible
 * only when `runId` matches that id (leftover indexed chunks from older runs).
 * New runs no longer upsert those paths into knowledge. Repo and docs stay global.
 */
export function isVisibleForRun(
  source: string,
  runId: string | undefined,
  stateDirectory: string,
): boolean {
  const normalizedSource = normalizePath(source);
  const prefix = `${normalizePath(stateDirectory).replace(/^\.\//, "")}/runs/`;
  const relative = normalizedSource.startsWith("./")
    ? normalizedSource.slice(2)
    : normalizedSource;
  if (!relative.startsWith(prefix)) return true;
  const remainder = relative.slice(prefix.length);
  const artifactRunId = remainder.split("/")[0];
  if (!artifactRunId) return true;
  return runId != null && artifactRunId === runId;
}

export function rankHybridResults(
  lexical: IndexedSearchResult[],
  semantic: IndexedSearchResult[],
  config: HarnessConfig,
): SearchResult[] {
  // Preserve legacy lexical scores and ordering exactly when semantic retrieval
  // is unavailable, stale, or does not meet its configured similarity floor.
  if (semantic.length === 0) {
    return lexical.map(({ id: _id, ...result }) => result);
  }
  const byId = new Map<string, IndexedSearchResult>();
  for (const result of [...lexical, ...semantic]) {
    byId.set(result.id, byId.get(result.id) ?? result);
  }
  const lexicalRanks = new Map(lexical.map((result, index) => [result.id, index + 1]));
  const semanticRanks = new Map(semantic.map((result, index) => [result.id, index + 1]));
  const { lexicalWeight, semanticWeight } = config.knowledge.embeddings;
  return [...byId.values()]
    .map((result) => {
      const score =
        (lexicalRanks.has(result.id) ? lexicalWeight / (60 + (lexicalRanks.get(result.id) ?? 0)) : 0) +
        (semanticRanks.has(result.id) ? semanticWeight / (60 + (semanticRanks.get(result.id) ?? 0)) : 0);
      return { ...result, score: Number(score.toFixed(6)) };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .map(({ id: _id, ...result }) => result);
}

export function diversifyBySource(
  results: SearchResult[],
  limit: number,
  options: { maxPerSource: number; maxForTopSource: number },
  omitted: RetrievalOmission[],
): SearchResult[] {
  const topSource = results[0]?.source;
  const counts = new Map<string, number>();
  const kept: SearchResult[] = [];
  for (const result of results) {
    if (kept.length >= limit) {
      omitted.push({
        source: result.source,
        title: result.title,
        score: result.score,
        reason: "limit",
      });
      continue;
    }
    const count = counts.get(result.source) ?? 0;
    const cap =
      result.source === topSource ? options.maxForTopSource : options.maxPerSource;
    if (count >= cap) {
      omitted.push({
        source: result.source,
        title: result.title,
        score: result.score,
        reason: "per-source-cap",
      });
      continue;
    }
    counts.set(result.source, count + 1);
    kept.push(result);
  }
  return kept;
}

export function rememberFifo<T>(cache: Map<string, T>, key: string, value: T, limit: number): void {
  cache.set(key, value);
  while (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest == null) break;
    cache.delete(oldest);
  }
}

export function cloneSearchAudit(value: KnowledgeSearchAudit): KnowledgeSearchAudit {
  return {
    results: value.results.map((result) => ({ ...result })),
    audit: {
      ...value.audit,
      graphify: { ...value.audit.graphify },
      kept: value.audit.kept.map((item) => ({ ...item })),
      omitted: value.audit.omitted.map((item) => ({ ...item })),
    },
  };
}


export function toKeptEntry(result: SearchResult): RetrievalAudit["kept"][number] {
  return {
    source: result.source,
    title: result.title,
    score: result.score,
    kind: result.kind,
  };
}

export function capResultCharacters(results: SearchResult[], maxCharacters?: number): SearchResult[] {
  return capResultCharactersWithOmissions(results, maxCharacters, []);
}

export function capResultCharactersWithOmissions(
  results: SearchResult[],
  maxCharacters: number | undefined,
  omitted: RetrievalOmission[],
): SearchResult[] {
  if (maxCharacters == null) return results;
  if (!Number.isInteger(maxCharacters) || maxCharacters <= 0) return [];
  let remaining = maxCharacters;
  const capped: SearchResult[] = [];
  for (const result of results) {
    if (remaining <= 0) {
      omitted.push({
        source: result.source,
        title: result.title,
        score: result.score,
        reason: "character-budget",
      });
      continue;
    }
    const excerpt = result.excerpt.slice(0, remaining);
    if (!excerpt) continue;
    capped.push({ ...result, excerpt });
    remaining -= excerpt.length;
  }
  return capped;
}

export function searchResultCacheKey(
  query: string,
  limit: number,
  options: unknown,
  generation: string,
): string {
  return `${query}\0${JSON.stringify(options)}\0${limit}\0${generation}`;
}
