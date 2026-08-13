import type { HarnessConfig } from "../../config/schema.js";
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

/** Distinctive query tokens that also appear in a path get a ranking boost. */
export function pathAffinityBoost(
  source: string,
  terms: string[],
  pathHints: string[] = [],
): number {
  const pathTerms = new Set(tokenize(source.replace(/[\\/._-]+/g, " ")));
  let boost = 0;
  for (const term of terms) {
    // Short tokens are too generic for path affinity (e.g. "md", "ts", "to").
    if (term.length < 4) continue;
    if (pathTerms.has(term)) boost += 0.35;
  }
  if (pathHints.length === 0) return Number(boost.toFixed(6));
  const normalizedSource = normalizePath(source).toLocaleLowerCase();
  for (const hint of pathHints) {
    const normalizedHint = normalizePath(hint).toLocaleLowerCase();
    if (!normalizedHint) continue;
    if (
      normalizedSource === normalizedHint ||
      normalizedSource.endsWith(`/${normalizedHint}`) ||
      normalizedHint.endsWith(`/${normalizedSource}`) ||
      normalizedSource.includes(normalizedHint) ||
      normalizedHint.includes(normalizedSource)
    ) {
      boost += 0.2;
      continue;
    }
    const hintTerms = tokenize(hint.replace(/[\\/._-]+/g, " "));
    if (hintTerms.some((term) => term.length >= 4 && pathTerms.has(term))) {
      boost += 0.1;
    }
  }
  return Number(boost.toFixed(6));
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
  // Normalize raw RRF into 0–1 so dual-channel rank-1 ≈ 1.0 and single-channel ≈ 0.5.
  const maxRrf = lexicalWeight / 61 + semanticWeight / 61;
  return [...byId.values()]
    .map((result) => {
      const raw =
        (lexicalRanks.has(result.id) ? lexicalWeight / (60 + (lexicalRanks.get(result.id) ?? 0)) : 0) +
        (semanticRanks.has(result.id) ? semanticWeight / (60 + (semanticRanks.get(result.id) ?? 0)) : 0);
      const score = maxRrf > 0 ? raw / maxRrf : 0;
      return { ...result, score: Number(score.toFixed(6)) };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .map(({ id: _id, ...result }) => result);
}

export function diversifyBySource(
  results: SearchResult[],
  limit: number,
  options: {
    maxPerSource: number;
    maxForTopSource: number;
    /** Require new sources to score at least this fraction of the top score. */
    newSourceScoreRatio?: number;
  },
  omitted: RetrievalOmission[],
): SearchResult[] {
  const topSource = results[0]?.source;
  const topScore = results[0]?.score ?? 0;
  const newSourceRatio = options.newSourceScoreRatio ?? 0;
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
    const seenSource = counts.has(result.source);
    if (
      !seenSource &&
      counts.size > 0 &&
      newSourceRatio > 0 &&
      topScore > 0 &&
      result.score < topScore * newSourceRatio
    ) {
      omitted.push({
        source: result.source,
        title: result.title,
        score: result.score,
        reason: "diversity-gap",
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
      repository: {
        ...value.audit.repository,
        attempts: value.audit.repository.attempts.map((attempt) => ({ ...attempt })),
      },
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
