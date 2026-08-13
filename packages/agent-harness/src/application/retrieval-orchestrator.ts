import type { HarnessConfig } from "../config/schema.js";
import type { RepositoryIntelligenceBroker } from "../infrastructure/repository-intelligence/index.js";
import {
  capResultCharacters,
  capResultCharactersWithOmissions,
  cloneSearchAudit,
  diversifyBySource,
  isVisibleForRun,
  isVisibleToProject,
  pathAffinityBoost,
  rankHybridResults,
  rememberFifo,
  searchResultCacheKey,
  toKeptEntry,
  tokenize,
} from "../infrastructure/knowledge/lexical-search.js";
import { normalizePath } from "../infrastructure/knowledge/document-index.js";
import type {
  IndexedSearchResult,
  KnowledgeChunk,
  KnowledgeSearchAudit,
  KnowledgeSearchOptions,
  RetrievalOmission,
  SearchResult,
} from "../infrastructure/knowledge/types.js";

export type RetrievalOrchestratorDependencies = {
  loadChunks(): Promise<KnowledgeChunk[]>;
  semanticSearch(query: string, allowedIds: Set<string>): Promise<Map<string, number>>;
  repository: RepositoryIntelligenceBroker;
};

/**
 * Owns hybrid document/repository retrieval policy. Persistence and guidance
 * compilation remain in LocalKnowledgeBase.
 */
export class RetrievalOrchestrator {
  private readonly cache = new Map<string, KnowledgeSearchAudit>();
  private static readonly CACHE_LIMIT = 64;

  constructor(
    private readonly config: HarnessConfig,
    private readonly dependencies: RetrievalOrchestratorDependencies,
  ) {}

  async search(
    query: string,
    limit: number,
    options: KnowledgeSearchOptions,
    documentGeneration: string,
  ): Promise<KnowledgeSearchAudit> {
    const cacheKey = searchResultCacheKey(query, limit, options, documentGeneration);
    const cached = this.cache.get(cacheKey);
    if (cached) return cloneSearchAudit(cached);
    const result = await this.searchUncached(query, limit, options);
    rememberFifo(
      this.cache,
      cacheKey,
      cloneSearchAudit(result),
      RetrievalOrchestrator.CACHE_LIMIT,
    );
    return cloneSearchAudit(result);
  }

  clear(): void {
    this.cache.clear();
  }

  private async searchUncached(
    query: string,
    limit: number,
    options: KnowledgeSearchOptions,
  ): Promise<KnowledgeSearchAudit> {
    const omitted: RetrievalOmission[] = [];
    const emptyRepository = {
      shapedQuery: "",
      usedFallback: false,
      included: false,
      skippedReason: "not-requested" as string | undefined,
      providerId: undefined as string | undefined,
      attempts: [] as Array<{
        providerId: string;
        outcome: string;
        reason?: string;
        refreshed?: boolean;
      }>,
    };
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0 || limit <= 0) {
      return {
        results: [],
        audit: {
          query,
          fallbackQuery: options.fallbackQuery,
          repository: { ...emptyRepository, skippedReason: "empty-query" },
          kept: [],
          omitted,
        },
      };
    }

    const documentsEnabled = options.documents !== false;
    const activeProjectId = options.projectId ?? this.config.knowledge.projectId;
    const [chunks, repositoryLookup] = await Promise.all([
      documentsEnabled
        ? this.dependencies.loadChunks()
        : Promise.resolve([] as KnowledgeChunk[]),
      options.repository === false
        ? Promise.resolve({
            result: undefined,
            shapedQuery: "",
            usedFallback: false,
            skippedReason: "repository-disabled",
            attempts: [],
          })
        : this.dependencies.repository.retrieve({
            capability: "search",
            query,
            fallbackQuery: options.fallbackQuery,
            pathHints: options.pathHints,
            maxCharacters: this.config.workflow.repositoryContextCharacters,
          }),
    ]);
    const repositoryAudit = {
      shapedQuery: repositoryLookup.shapedQuery,
      usedFallback: repositoryLookup.usedFallback,
      included: false,
      providerId: repositoryLookup.result?.providerId,
      skippedReason: repositoryLookup.skippedReason,
      attempts: repositoryLookup.attempts.map((attempt) => ({
        providerId: attempt.providerId,
        outcome: attempt.outcome,
        reason: attempt.reason,
        refreshed: attempt.refreshed,
      })),
    };
    if (
      repositoryLookup.skippedReason &&
      !repositoryLookup.result &&
      repositoryLookup.skippedReason !== "repository-disabled" &&
      repositoryLookup.skippedReason !== "disabled"
    ) {
      omitted.push({
        source: repositoryLookup.attempts.at(-1)?.providerId
          ? `repository:${repositoryLookup.attempts.at(-1)!.providerId}`
          : "repository:unavailable",
        title: "Repository relationships",
        score: 0,
        reason: "repository-skipped",
      });
    }

    const repositoryResult = repositoryLookup.result
      ? toCurrentProjectResult(repositoryLookup.result, activeProjectId)
      : undefined;
    if (!documentsEnabled) {
      const results = repositoryResult ? [repositoryResult] : [];
      repositoryAudit.included = Boolean(repositoryResult);
      if (repositoryResult) repositoryAudit.skippedReason = undefined;
      const capped = capResultCharacters(results, options.maxCharacters);
      return {
        results: capped,
        audit: {
          query,
          fallbackQuery: options.fallbackQuery,
          repository: repositoryAudit,
          kept: capped.map(toKeptEntry),
          omitted,
          skipped: "rag-disabled",
        },
      };
    }

    const stateDirectory = normalizePath(this.config.stateDirectory);
    // ADR 0005 invariant: visibility filtering occurs before document frequency.
    const allowedChunks = chunks.filter(
      (chunk) =>
        isVisibleToProject(chunk, activeProjectId, options.includeProjects ?? []) &&
        isVisibleForRun(chunk.source, options.runId, stateDirectory),
    );
    if (allowedChunks.length === 0) {
      const results = repositoryResult ? [repositoryResult] : [];
      repositoryAudit.included = Boolean(repositoryResult);
      if (repositoryResult) repositoryAudit.skippedReason = undefined;
      const capped = capResultCharacters(results, options.maxCharacters);
      return {
        results: capped,
        audit: {
          query,
          fallbackQuery: options.fallbackQuery,
          repository: repositoryAudit,
          kept: capped.map(toKeptEntry),
          omitted,
        },
      };
    }

    const documentFrequency = new Map<string, number>();
    for (const chunk of allowedChunks) {
      for (const term of new Set(Object.keys(chunk.terms))) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }
    const pathHints = options.pathHints ?? [];
    const scoredLexical: IndexedSearchResult[] = allowedChunks
      .map((chunk) => {
        let score = 0;
        for (const term of terms) {
          const frequency = chunk.terms[term] ?? 0;
          if (frequency === 0) continue;
          const inverseDocumentFrequency = Math.log(
            1 + allowedChunks.length / (1 + (documentFrequency.get(term) ?? 0)),
          );
          score += (1 + Math.log(frequency)) * inverseDocumentFrequency;
        }
        if (score > 0 && chunk.scope === "project" && chunk.projectId === activeProjectId) {
          score += 0.001;
        }
        if (score > 0) score += pathAffinityBoost(chunk.source, terms, pathHints);
        return {
          source: chunk.source,
          title: chunk.title,
          excerpt: chunk.text,
          score: Number(score.toFixed(6)),
          id: chunk.id,
          scope: chunk.scope,
          projectId: chunk.projectId,
          visibility: chunk.visibility,
          kind: chunk.kind,
        };
      })
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

    const {
      relevanceFloor,
      minLexicalScore,
      maxChunksPerSource,
      maxForTopSource,
    } = this.config.knowledge;
    const topLexical = scoredLexical[0]?.score ?? 0;
    const relativeFloor = topLexical > 0 ? topLexical * relevanceFloor : 0;
    const lexical: IndexedSearchResult[] = [];
    for (const result of scoredLexical) {
      if (result.score < minLexicalScore) {
        omitted.push({ ...toOmission(result), reason: "below-min-lexical" });
      } else if (result.score < relativeFloor) {
        omitted.push({ ...toOmission(result), reason: "below-floor" });
      } else {
        lexical.push(result);
      }
    }

    const semanticScores = await this.dependencies.semanticSearch(
      query,
      new Set(allowedChunks.map((chunk) => chunk.id)),
    );
    const scoredLexicalIds = new Set(scoredLexical.map((result) => result.id));
    const acceptedLexicalIds = new Set(lexical.map((result) => result.id));
    const semanticCandidates: IndexedSearchResult[] = allowedChunks
      .filter((chunk) => {
        if (!semanticScores.has(chunk.id)) return false;
        if (scoredLexicalIds.has(chunk.id) && !acceptedLexicalIds.has(chunk.id)) return false;
        if (
          !acceptedLexicalIds.has(chunk.id) &&
          (semanticScores.get(chunk.id) ?? 0) <
            this.config.knowledge.embeddings.minSemanticOnlySimilarity
        ) {
          return false;
        }
        return true;
      })
      .map((chunk) => ({
        source: chunk.source,
        title: chunk.title,
        excerpt: chunk.text,
        score: semanticScores.get(chunk.id) ?? 0,
        id: chunk.id,
        scope: chunk.scope,
        projectId: chunk.projectId,
        visibility: chunk.visibility,
        kind: chunk.kind,
      }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

    const ranked = rankHybridResults(lexical, semanticCandidates, this.config);
    const documentSlots = repositoryResult ? Math.max(0, limit - 1) : limit;
    const diversified = diversifyBySource(
      ranked,
      documentSlots,
      {
        maxPerSource: maxChunksPerSource,
        maxForTopSource,
        newSourceScoreRatio: 0.85,
      },
      omitted,
    );
    const merged = repositoryResult ? [repositoryResult, ...diversified] : diversified;
    repositoryAudit.included = Boolean(repositoryResult);
    if (repositoryResult) repositoryAudit.skippedReason = undefined;
    const capped = capResultCharactersWithOmissions(merged, options.maxCharacters, omitted);
    return {
      results: capped,
      audit: {
        query,
        fallbackQuery: options.fallbackQuery,
        repository: repositoryAudit,
        kept: capped.map(toKeptEntry),
        omitted,
      },
    };
  }
}

function toCurrentProjectResult(
  result: {
    source: string;
    title: string;
    excerpt: string;
    score: number;
  },
  projectId: string,
): SearchResult {
  return {
    ...result,
    scope: "project",
    projectId,
    visibility: "private",
    kind: "document",
  };
}

function toOmission(result: IndexedSearchResult) {
  return { source: result.source, title: result.title, score: result.score };
}
