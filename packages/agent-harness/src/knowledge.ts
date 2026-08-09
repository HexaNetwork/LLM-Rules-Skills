import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import yaml from "js-yaml";
import { z } from "zod";
import type {
  HarnessConfig,
  KnowledgeScope,
  KnowledgeVisibility,
} from "./config.js";
import { LocalEmbeddingIndex } from "./embeddings.js";
import {
  GraphifyRepositoryLookup,
  GRAPH_PATH,
  buildGraphifyQuery,
  type RepositoryLookup,
} from "./graphify.js";

const GuidanceKindSchema = z.enum(["document", "rule", "skill"]);
export type GuidanceKind = z.infer<typeof GuidanceKindSchema>;

const GuidanceMetadataSchema = z.object({
  kind: GuidanceKindSchema.default("document"),
  /** Stable override key: skill front-matter name, else rule basename / skill folder. */
  name: z.string().default(""),
  description: z.string().default(""),
  globs: z.array(z.string()).default([]),
  alwaysApply: z.boolean().default(false),
  roles: z.array(z.string()).default([]),
});
type GuidanceMetadata = z.infer<typeof GuidanceMetadataSchema>;

/** Prefer project guidance over otherwise-comparable global guidance (stronger than search +0.001). */
const PROJECT_SCOPE_GUIDANCE_BONUS = 10;

const DocumentSchema = z.object({
  id: z.string(),
  source: z.string(),
  title: z.string(),
  content: z.string(),
  hash: z.string(),
  updatedAt: z.string(),
  scope: z.enum(["global", "project"]).default("project"),
  projectId: z.string().optional(),
  visibility: z.enum(["private", "shared", "restricted"]).default("private"),
  managedByConfig: z.boolean().default(true),
  guidance: GuidanceMetadataSchema.default({}),
});
type KnowledgeDocument = z.infer<typeof DocumentSchema>;

const TermFrequenciesSchema = z.record(
  z.union([z.number(), z.string()]).transform((value) =>
    typeof value === "number" ? value : (Number(value) || 0),
  ),
);

const ChunkSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  source: z.string(),
  title: z.string(),
  text: z.string(),
  terms: TermFrequenciesSchema,
  scope: z.enum(["global", "project"]).default("project"),
  projectId: z.string().optional(),
  visibility: z.enum(["private", "shared", "restricted"]).default("private"),
  kind: GuidanceKindSchema.default("document"),
});
type KnowledgeChunk = z.infer<typeof ChunkSchema>;

export type KnowledgeClassification = {
  scope?: KnowledgeScope;
  projectId?: string;
  visibility?: KnowledgeVisibility;
};

export type KnowledgeSearchOptions = {
  repository?: boolean;
  projectId?: string;
  includeProjects?: string[];
  maxCharacters?: number;
  excludeGuidance?: boolean;
  /** When set, only this run's `.agent-harness/runs/<id>/*` artifacts are visible. */
  runId?: string;
  /** Domain seed tried when Graphify shaping of `query` is empty/generic. */
  fallbackQuery?: string;
};

export type SearchResult = {
  source: string;
  title: string;
  excerpt: string;
  score: number;
  scope: KnowledgeScope;
  projectId?: string;
  visibility: KnowledgeVisibility;
  kind?: GuidanceKind;
};

export type RetrievalOmission = {
  source: string;
  title: string;
  score: number;
  reason:
    | "below-min-lexical"
    | "below-floor"
    | "per-source-cap"
    | "limit"
    | "graphify-skipped"
    | "character-budget";
};

export type RetrievalAudit = {
  query: string;
  fallbackQuery?: string;
  graphify: {
    shapedQuery: string;
    usedFallback: boolean;
    included: boolean;
    skippedReason?: string;
  };
  kept: Array<{ source: string; title: string; score: number; kind?: GuidanceKind }>;
  omitted: RetrievalOmission[];
  /** Present when the whole retrieval pass was skipped for this invocation. */
  skipped?: string;
};

export type KnowledgeSearchAudit = {
  results: SearchResult[];
  audit: RetrievalAudit;
};

export type KnowledgeRefreshProgress = {
  stage: "discovering" | "indexing" | "embedding" | "complete";
  completed: number;
  total: number;
  message: string;
};

type IndexedSearchResult = SearchResult & { id: string };

export type GuidanceSelection = {
  source: string;
  title: string;
  kind: "rule" | "skill";
  excerpt: string;
  reason: string;
  score: number;
};

export type GuidanceSelectionOptions = {
  role: string;
  knownPaths?: string[];
  projectId?: string;
  includeProjects?: string[];
  maxResults?: number;
  maxCharacters?: number;
};

export type GuidanceOmission = {
  source: string;
  title: string;
  reason: string;
};

export type GuidanceSelectionAudit = {
  selected: GuidanceSelection[];
  omittedAlwaysApply: GuidanceOmission[];
  /** Global guidance dropped because a same-name project entry won. */
  omittedOverrides: GuidanceOmission[];
};

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".mdc",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".java",
  ".kt",
  ".kts",
]);

export class LocalKnowledgeBase {
  private readonly directory: string;
  private readonly documentsPath: string;
  private readonly chunksPath: string;
  private readonly embeddings: LocalEmbeddingIndex;
  private cachedDocuments?: KnowledgeDocument[];
  private cachedChunks?: KnowledgeChunk[];
  private indexGeneration = "";
  private readonly searchResultCache = new Map<string, KnowledgeSearchAudit>();
  private readonly guidanceResultCache = new Map<string, GuidanceSelectionAudit>();
  private static readonly RESULT_CACHE_LIMIT = 64;

  constructor(
    private readonly config: HarnessConfig,
    private readonly repositoryLookup: RepositoryLookup = new GraphifyRepositoryLookup(config),
  ) {
    this.directory = config.knowledge.sharedIndexDirectory
      ? path.resolve(config.repositoryRoot, config.knowledge.sharedIndexDirectory)
      : path.resolve(config.repositoryRoot, config.stateDirectory, "knowledge");
    this.documentsPath = path.join(this.directory, "documents.json");
    this.chunksPath = path.join(this.directory, "chunks.json");
    this.embeddings = new LocalEmbeddingIndex(this.directory, config.knowledge.embeddings);
  }

  async refresh(onProgress?: (progress: KnowledgeRefreshProgress) => void): Promise<number> {
    onProgress?.({ stage: "discovering", completed: 0, total: 0, message: "Discovering configured documents" });
    const files: Array<{
      filePath: string;
      classification: { scope: KnowledgeScope; projectId?: string; visibility: KnowledgeVisibility };
    }> = [];
    for (const source of this.config.knowledge.sources) {
      const resolved = path.resolve(this.config.repositoryRoot, source.path);
      assertInside(this.config.repositoryRoot, resolved);
      const discovered: string[] = [];
      await collectFiles(resolved, discovered);
      const classification = resolveClassification(this.config, source);
      files.push(...discovered.map((filePath) => ({ filePath, classification })));
    }
    const sortedFiles = files.sort((a, b) =>
      `${a.classification.scope}:${a.classification.projectId}:${a.filePath}`.localeCompare(
        `${b.classification.scope}:${b.classification.projectId}:${b.filePath}`,
      ),
    );
    let changed = 0;
    onProgress?.({
      stage: "indexing",
      completed: 0,
      total: sortedFiles.length,
      message: `Indexing 0 of ${sortedFiles.length} configured documents`,
    });
    for (const [index, { filePath, classification }] of sortedFiles.entries()) {
      if (await this.upsertFile(filePath, classification, false, true)) changed += 1;
      onProgress?.({
        stage: "indexing",
        completed: index + 1,
        total: sortedFiles.length,
        message: `Indexing ${index + 1} of ${sortedFiles.length} configured documents`,
      });
    }
    // Rebuild chunk terms even when source text is unchanged. This also repairs
    // indexes created before term maps used null-prototype objects.
    const configuredDocumentIds = new Set(sortedFiles.map(({ filePath, classification }) => hash(
      `${classification.scope}:${classification.projectId}:${normalizePath(path.relative(this.config.repositoryRoot, filePath))}`,
    )));
    const documents = await this.loadDocuments();
    // A shared index can be maintained by more than one project config, so it
    // must never delete another project's configured sources. A private local
    // index, on the other hand, drops stale automatically-managed entries when
    // the source list changes (for example, when source code is removed from
    // document retrieval in favour of Graphify).
    const retained = this.config.knowledge.sharedIndexDirectory
      ? documents
      : documents.filter((document) => !document.managedByConfig || configuredDocumentIds.has(document.id));
    await this.persist(retained);
    await this.syncEmbeddings(onProgress);
    await this.repositoryLookup.refresh();
    onProgress?.({ stage: "complete", completed: sortedFiles.length, total: sortedFiles.length, message: "Knowledge index is ready" });
    return changed;
  }

  /** Rebuild structural repository context after a verified source commit. */
  async rebuildRepositoryGraph(): Promise<boolean> {
    return this.repositoryLookup.rebuild();
  }

  async upsertFile(
    filePath: string,
    classification: KnowledgeClassification = {},
    syncEmbeddings = true,
    managedByConfig = false,
  ): Promise<boolean> {
    const info = await stat(filePath);
    if (!info.isFile() || info.size > 2_000_000) return false;
    if (!TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return false;
    const content = await readFile(filePath, "utf8");
    const source = normalizePath(path.relative(this.config.repositoryRoot, filePath));
    return this.upsertText(
      source,
      path.basename(filePath),
      content,
      classification,
      syncEmbeddings,
      managedByConfig,
    );
  }

  async upsertText(
    source: string,
    title: string,
    content: string,
    classification: KnowledgeClassification = {},
    syncEmbeddings = true,
    managedByConfig = false,
  ): Promise<boolean> {
    const documents = await this.loadDocuments();
    const resolvedClassification = resolveClassification(this.config, classification);
    const id = hash(
      `${resolvedClassification.scope}:${resolvedClassification.projectId}:${normalizePath(source)}`,
    );
    const contentHash = hash(content);
    const existing = documents.find((document) => document.id === id);
    if (existing?.hash === contentHash) {
      // Allow `knowledge add` to repair a missing/stale vector index after
      // embeddings were enabled, even though the source document is unchanged.
      if (syncEmbeddings) await this.syncEmbeddings();
      return false;
    }
    const next: KnowledgeDocument = {
      id,
      source: normalizePath(source),
      title,
      content,
      hash: contentHash,
      updatedAt: new Date().toISOString(),
      ...resolvedClassification,
      managedByConfig,
      guidance: guidanceMetadata(source, content),
    };
    const updated = [...documents.filter((document) => document.id !== id), next].sort((a, b) =>
      `${a.scope}:${a.projectId ?? ""}:${a.source}`.localeCompare(
        `${b.scope}:${b.projectId ?? ""}:${b.source}`,
      ),
    );
    await this.persist(updated);
    if (syncEmbeddings) await this.syncEmbeddings();
    return true;
  }

  async search(
    query: string,
    limit = 6,
    options: KnowledgeSearchOptions = {},
  ): Promise<SearchResult[]> {
    return (await this.searchWithAudit(query, limit, options)).results;
  }

  async searchWithAudit(
    query: string,
    limit = 6,
    options: KnowledgeSearchOptions = {},
  ): Promise<KnowledgeSearchAudit> {
    const generation = await this.ensureIndexGeneration();
    const cacheKey = `${query}\0${JSON.stringify(options)}\0${limit}\0${generation}`;
    const cached = this.searchResultCache.get(cacheKey);
    if (cached) return cloneSearchAudit(cached);

    const result = await this.searchWithAuditUncached(query, limit, options);
    rememberFifo(this.searchResultCache, cacheKey, cloneSearchAudit(result), LocalKnowledgeBase.RESULT_CACHE_LIMIT);
    return cloneSearchAudit(result);
  }

  private async searchWithAuditUncached(
    query: string,
    limit = 6,
    options: KnowledgeSearchOptions = {},
  ): Promise<KnowledgeSearchAudit> {
    const omitted: RetrievalOmission[] = [];
    const emptyGraphify = {
      shapedQuery: "",
      usedFallback: false,
      included: false,
      skippedReason: "not-requested" as string | undefined,
    };
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0 || limit <= 0) {
      return {
        results: [],
        audit: {
          query,
          fallbackQuery: options.fallbackQuery,
          graphify: { ...emptyGraphify, skippedReason: "empty-query" },
          kept: [],
          omitted,
        },
      };
    }
    const activeProjectId = options.projectId ?? this.config.knowledge.projectId;
    const [chunks, repositoryLookup] = await Promise.all([
      this.loadChunks(),
      options.repository === false
        ? Promise.resolve({
            result: undefined,
            shapedQuery: "",
            usedFallback: false,
            skippedReason: "repository-disabled",
          } satisfies Awaited<ReturnType<RepositoryLookup["search"]>>)
        : this.repositoryLookup.search(query, { fallbackQuery: options.fallbackQuery }),
    ]);
    const graphifyAudit = {
      shapedQuery: repositoryLookup.shapedQuery,
      usedFallback: repositoryLookup.usedFallback,
      included: false,
      skippedReason: repositoryLookup.skippedReason,
    };
    if (
      repositoryLookup.skippedReason &&
      !repositoryLookup.result &&
      repositoryLookup.skippedReason !== "repository-disabled" &&
      repositoryLookup.skippedReason !== "disabled"
    ) {
      omitted.push({
        source: `graphify:${GRAPH_PATH}`,
        title: "Repository relationships (Graphify)",
        score: 0,
        reason: "graphify-skipped",
      });
    }
    const stateDirectory = normalizePath(this.config.stateDirectory);
    const allowedChunks = chunks.filter(
      (chunk) =>
        isVisibleToProject(chunk, activeProjectId, options.includeProjects ?? []) &&
        isVisibleForRun(chunk.source, options.runId, stateDirectory) &&
        (!options.excludeGuidance || chunk.kind === "document"),
    );
    if (allowedChunks.length === 0) {
      const repositoryResult = repositoryLookup.result
        ? toCurrentProjectResult(repositoryLookup.result, activeProjectId)
        : undefined;
      const results = repositoryResult ? [repositoryResult] : [];
      graphifyAudit.included = Boolean(repositoryResult);
      if (repositoryResult) graphifyAudit.skippedReason = undefined;
      return {
        results: capResultCharacters(results, options.maxCharacters),
        audit: {
          query,
          fallbackQuery: options.fallbackQuery,
          graphify: graphifyAudit,
          kept: results.map(toKeptEntry),
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
        // Prefer the active project's conventions when lexical evidence is otherwise equal.
        if (score > 0 && chunk.scope === "project" && chunk.projectId === activeProjectId) score += 0.001;
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
        omitted.push({
          source: result.source,
          title: result.title,
          score: result.score,
          reason: "below-min-lexical",
        });
        continue;
      }
      if (result.score < relativeFloor) {
        omitted.push({
          source: result.source,
          title: result.title,
          score: result.score,
          reason: "below-floor",
        });
        continue;
      }
      lexical.push(result);
    }

    const semanticScores = await this.embeddings.search(
      query,
      new Set(allowedChunks.filter((chunk) => chunk.kind === "document").map((chunk) => chunk.id)),
    );
    const scoredLexicalIds = new Set(scoredLexical.map((result) => result.id));
    const acceptedLexicalIds = new Set(lexical.map((result) => result.id));
    const semanticCandidates: IndexedSearchResult[] = allowedChunks
      .filter((chunk) => {
        if (chunk.kind !== "document" || !semanticScores.has(chunk.id)) return false;
        // Embeddings must not resurrect lexical rows already refused by the floor.
        if (scoredLexicalIds.has(chunk.id) && !acceptedLexicalIds.has(chunk.id)) return false;
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
    const documentSlots = repositoryLookup.result ? Math.max(0, limit - 1) : limit;
    const diversified = diversifyBySource(
      ranked,
      documentSlots,
      { maxPerSource: maxChunksPerSource, maxForTopSource },
      omitted,
    );
    const merged = repositoryLookup.result
      ? [toCurrentProjectResult(repositoryLookup.result, activeProjectId), ...diversified]
      : diversified;
    graphifyAudit.included = Boolean(repositoryLookup.result);
    if (repositoryLookup.result) graphifyAudit.skippedReason = undefined;
    const capped = capResultCharactersWithOmissions(merged, options.maxCharacters, omitted);
    return {
      results: capped,
      audit: {
        query,
        fallbackQuery: options.fallbackQuery,
        graphify: graphifyAudit,
        kept: capped.map(toKeptEntry),
        omitted,
      },
    };
  }

  async selectGuidance(
    query: string,
    options: GuidanceSelectionOptions,
  ): Promise<GuidanceSelection[]> {
    return (await this.selectGuidanceWithAudit(query, options)).selected;
  }

  async selectGuidanceWithAudit(
    query: string,
    options: GuidanceSelectionOptions,
  ): Promise<GuidanceSelectionAudit> {
    const generation = await this.ensureIndexGeneration();
    const cacheKey = `${query}\0${JSON.stringify(options)}\0${generation}`;
    const cached = this.guidanceResultCache.get(cacheKey);
    if (cached) return cloneGuidanceAudit(cached);

    const result = await this.selectGuidanceWithAuditUncached(query, options);
    rememberFifo(
      this.guidanceResultCache,
      cacheKey,
      cloneGuidanceAudit(result),
      LocalKnowledgeBase.RESULT_CACHE_LIMIT,
    );
    return cloneGuidanceAudit(result);
  }

  private async selectGuidanceWithAuditUncached(
    query: string,
    options: GuidanceSelectionOptions,
  ): Promise<GuidanceSelectionAudit> {
    const terms = [...new Set(tokenize(`${options.role} ${query}`))];
    const maxResults = options.maxResults ?? this.config.knowledge.guidance.maxResults;
    const maxCharacters = options.maxCharacters ?? this.config.knowledge.guidance.maxCharacters;
    if (terms.length === 0 || maxResults <= 0 || maxCharacters <= 0) {
      return { selected: [], omittedAlwaysApply: [], omittedOverrides: [] };
    }
    const activeProjectId = options.projectId ?? this.config.knowledge.projectId;
    const knownPaths = uniquePaths(options.knownPaths ?? []);
    const documents = (await this.loadDocuments()).filter(
      (document) =>
        document.guidance.kind !== "document" &&
        isVisibleToProject(document, activeProjectId, options.includeProjects ?? []),
    );

    const scored = documents
      .flatMap((document) => {
        const guidance = document.guidance;
        if (guidance.roles.length > 0 && !guidance.roles.includes(options.role)) return [];
        const matchingGlobs = guidance.globs.filter((glob) =>
          knownPaths.some((filePath) => matchesGlob(glob, filePath)),
        );
        // A file-scoped rule is not applicable when the worker has a known
        // target set that does not match it. With no paths yet, lexical/RAG
        // relevance may still surface it for planning and research workers.
        if (guidance.kind === "rule" && knownPaths.length > 0 && guidance.globs.length > 0 && matchingGlobs.length === 0) {
          return [];
        }
        const lexicalScore = scoreText(
          `${document.title}\n${guidance.description}\n${document.content}`,
          terms,
        );
        const roleMatch = guidance.roles.includes(options.role);
        const globMatch = matchingGlobs.length > 0;
        // `alwaysApply` preserves its authors' intent as a strong ranking
        // signal, but never turns unrelated rules into universal prompt bloat.
        if (!roleMatch && !globMatch && lexicalScore === 0) return [];
        const projectScope =
          document.scope === "project" &&
          (document.projectId === undefined || document.projectId === activeProjectId);
        const score = lexicalScore + (roleMatch ? 100 : 0) + (globMatch ? 80 : 0) +
          (guidance.alwaysApply ? 20 : 0) +
          (projectScope ? PROJECT_SCOPE_GUIDANCE_BONUS : 0);
        const reason = [
          ...(roleMatch ? ["role match"] : []),
          ...(globMatch ? [`path matches ${matchingGlobs.join(", ")}`] : []),
          ...(guidance.alwaysApply ? ["alwaysApply priority"] : []),
          ...(projectScope ? ["project scope"] : []),
          ...(lexicalScore > 0 ? ["lexical relevance"] : []),
        ].join("; ");
        return [{ document, score: Number(score.toFixed(6)), reason }];
      })
      .sort((a, b) => b.score - a.score || a.document.id.localeCompare(b.document.id));

    const projectGuidanceNames = new Set(
      scored
        .filter((candidate) => candidate.document.scope === "project")
        .map((candidate) => guidanceOverrideName(candidate.document)),
    );
    const omittedOverrides: GuidanceOmission[] = [];
    const candidates = scored.filter((candidate) => {
      if (candidate.document.scope !== "global") return true;
      const name = guidanceOverrideName(candidate.document);
      if (!projectGuidanceNames.has(name)) return true;
      omittedOverrides.push({
        source: candidate.document.source,
        title: candidate.document.title,
        reason: "overridden by project guidance",
      });
      return false;
    });

    let remaining = maxCharacters;
    const selected: GuidanceSelection[] = [];
    for (const candidate of candidates) {
      if (selected.length >= maxResults || remaining <= 0) break;
      const excerpt = bestGuidanceExcerpt(candidate.document.content, terms, this.config.knowledge.chunkCharacters)
        .slice(0, remaining);
      if (!excerpt) continue;
      selected.push({
        source: candidate.document.source,
        title: candidate.document.title,
        kind: candidate.document.guidance.kind as "rule" | "skill",
        excerpt,
        reason: candidate.reason,
        score: candidate.score,
      });
      remaining -= excerpt.length;
    }
    const selectedSources = new Set(selected.map((item) => item.source));
    const overriddenSources = new Set(omittedOverrides.map((item) => item.source));
    const candidateSources = new Set(candidates.map((item) => item.document.source));
    const omittedAlwaysApply = documents
      .filter(
        (document) =>
          document.guidance.alwaysApply &&
          !selectedSources.has(document.source) &&
          !overriddenSources.has(document.source),
      )
      .map((document) => ({
        source: document.source,
        title: document.title,
        reason: candidateSources.has(document.source)
          ? "lower-ranked or omitted by the guidance budget"
          : omissionReason(document, options.role, knownPaths, terms),
      }));
    return { selected, omittedAlwaysApply, omittedOverrides };
  }

  private async loadDocuments(): Promise<KnowledgeDocument[]> {
    await this.ensureIndexGeneration();
    if (this.cachedDocuments) return this.cachedDocuments;
    try {
      const raw: unknown = JSON.parse(await readFile(this.documentsPath, "utf8"));
      this.cachedDocuments = z.array(DocumentSchema)
        .parse(raw)
        .map((document) => ({
          ...document,
          projectId:
            document.scope === "project"
              ? (document.projectId ?? this.config.knowledge.projectId)
              : undefined,
        }));
      return this.cachedDocuments;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.cachedDocuments = [];
        return this.cachedDocuments;
      }
      throw error;
    }
  }

  private async loadChunks(): Promise<KnowledgeChunk[]> {
    await this.ensureIndexGeneration();
    if (this.cachedChunks) return this.cachedChunks;
    try {
      const raw: unknown = JSON.parse(await readFile(this.chunksPath, "utf8"));
      this.cachedChunks = z.array(ChunkSchema)
        .parse(raw)
        .map((chunk) => ({
          ...chunk,
          projectId:
            chunk.scope === "project" ? (chunk.projectId ?? this.config.knowledge.projectId) : undefined,
        }));
      return this.cachedChunks;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.cachedChunks = [];
        return this.cachedChunks;
      }
      throw error;
    }
  }

  private async ensureIndexGeneration(): Promise<string> {
    const generation = await this.readIndexGeneration();
    if (generation !== this.indexGeneration) {
      this.cachedDocuments = undefined;
      this.cachedChunks = undefined;
      this.searchResultCache.clear();
      this.guidanceResultCache.clear();
      this.indexGeneration = generation;
    }
    return this.indexGeneration;
  }

  private async readIndexGeneration(): Promise<string> {
    const [documentsStat, chunksStat] = await Promise.all([
      stat(this.documentsPath).catch(() => undefined),
      stat(this.chunksPath).catch(() => undefined),
    ]);
    return [
      documentsStat ? `${documentsStat.mtimeMs}:${documentsStat.size}` : "missing-docs",
      chunksStat ? `${chunksStat.mtimeMs}:${chunksStat.size}` : "missing-chunks",
    ].join("|");
  }

  private invalidateCaches(): void {
    this.cachedDocuments = undefined;
    this.cachedChunks = undefined;
    this.indexGeneration = "";
    this.searchResultCache.clear();
    this.guidanceResultCache.clear();
  }

  private async persist(documents: KnowledgeDocument[]): Promise<void> {
    this.invalidateCaches();
    await mkdir(this.directory, { recursive: true });
    const normalizedDocuments = documents.map((document) => ({
      ...document,
      guidance: guidanceMetadata(document.source, document.content),
    }));
    const chunks = normalizedDocuments.flatMap((document) =>
      chunkText(document.content, this.config.knowledge.chunkCharacters).map((text, index) => ({
        id: `${document.id}:${String(index).padStart(5, "0")}`,
        documentId: document.id,
        source: document.source,
        title: document.title,
        text,
        terms: frequencies(tokenize(text)),
        scope: document.scope,
        projectId: document.projectId,
        visibility: document.visibility,
        kind: document.guidance.kind,
      })),
    );
    await Promise.all([
      writeFile(this.documentsPath, `${JSON.stringify(normalizedDocuments, null, 2)}\n`, "utf8"),
      writeFile(this.chunksPath, `${JSON.stringify(chunks, null, 2)}\n`, "utf8"),
    ]);
  }

  private async syncEmbeddings(onProgress?: (progress: KnowledgeRefreshProgress) => void): Promise<void> {
    if (!this.config.knowledge.embeddings.enabled) return;
    try {
      const chunks = await this.loadChunks();
      await this.embeddings.sync(
        chunks
          .filter((chunk) => chunk.kind === "document")
          .map((chunk) => ({ id: chunk.id, text: chunk.text, textHash: hash(chunk.text) })),
        (progress) => onProgress?.({
          stage: "embedding",
          completed: progress.completed,
          total: progress.total,
          message: progress.total === 0
            ? "Embedding index is already current"
            : `Embedding ${progress.completed} of ${progress.total} changed chunks`,
        }),
      );
    } catch (error) {
      // The durable lexical index has already been written. Retain it when an
      // optional embedding service is unreachable or misconfigured.
      console.warn(`Embedding index unavailable; continuing with lexical retrieval: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function resolveClassification(
  config: HarnessConfig,
  classification: KnowledgeClassification,
): { scope: KnowledgeScope; projectId?: string; visibility: KnowledgeVisibility } {
  const scope = classification.scope ?? "project";
  return {
    scope,
    projectId: scope === "project" ? (classification.projectId ?? config.knowledge.projectId) : undefined,
    visibility: classification.visibility ?? "private",
  };
}

function isVisibleToProject(
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

function rankHybridResults(
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

function diversifyBySource(
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

function rememberFifo<T>(cache: Map<string, T>, key: string, value: T, limit: number): void {
  cache.set(key, value);
  while (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest == null) break;
    cache.delete(oldest);
  }
}

function cloneSearchAudit(value: KnowledgeSearchAudit): KnowledgeSearchAudit {
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

function cloneGuidanceAudit(value: GuidanceSelectionAudit): GuidanceSelectionAudit {
  return {
    selected: value.selected.map((item) => ({ ...item })),
    omittedAlwaysApply: value.omittedAlwaysApply.map((item) => ({ ...item })),
    omittedOverrides: (value.omittedOverrides ?? []).map((item) => ({ ...item })),
  };
}

/** Same-name override key: skill `name:` / folder, or rule basename without extension. */
function guidanceOverrideName(document: Pick<KnowledgeDocument, "source" | "guidance">): string {
  const explicit = document.guidance.name.trim().toLowerCase();
  if (explicit) return explicit;
  const normalized = normalizePath(document.source);
  if (document.guidance.kind === "skill") {
    const parts = normalized.split("/");
    const skillIndex = parts.findIndex((part) => part.toLowerCase() === "skill.md");
    if (skillIndex > 0) return parts[skillIndex - 1]!.toLowerCase();
  }
  return path.basename(normalized, path.extname(normalized)).toLowerCase();
}

function toKeptEntry(result: SearchResult): RetrievalAudit["kept"][number] {
  return {
    source: result.source,
    title: result.title,
    score: result.score,
    kind: result.kind,
  };
}

/**
 * Compact a bounded domain seed from idea / destination text: prefer
 * identifier-like and distinctive tokens, drop harness meta-language.
 */
export function compactDomainSeed(
  ...parts: Array<string | undefined | null>
): string {
  const text = parts.filter((part): part is string => Boolean(part?.trim())).join(" ");
  if (!text) return "";
  return buildGraphifyQuery(text, 8);
}

function toCurrentProjectResult(
  result: Omit<SearchResult, "scope" | "projectId" | "visibility" | "kind">,
  projectId: string,
): SearchResult {
  return { ...result, scope: "project", projectId, visibility: "private", kind: "document" };
}

function capResultCharacters(results: SearchResult[], maxCharacters?: number): SearchResult[] {
  return capResultCharactersWithOmissions(results, maxCharacters, []);
}

function capResultCharactersWithOmissions(
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

function tokenize(value: string): string[] {
  return value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
}

function scoreText(value: string, terms: string[]): number {
  const termSet = new Set(terms);
  let score = 0;
  for (const term of tokenize(value)) {
    if (termSet.has(term)) score += 1;
  }
  return score;
}

function bestGuidanceExcerpt(content: string, terms: string[], chunkSize: number): string {
  const chunks = chunkText(content, chunkSize);
  if (chunks.length === 0) return "";
  return chunks
    .map((text, index) => ({ text, index, score: scoreText(text, terms) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)[0]!.text;
}

function guidanceMetadata(source: string, content: string): GuidanceMetadata {
  const normalized = source.toLowerCase();
  const kind: GuidanceKind = normalized.endsWith(".mdc")
    ? "rule"
    : normalized.endsWith("/skill.md") || normalized === "skill.md"
      ? "skill"
      : "document";
  if (kind === "document") return GuidanceMetadataSchema.parse({ kind });
  const frontMatter = parseFrontMatter(content);
  const globs = frontMatter.globs;
  const explicitName = typeof frontMatter.name === "string" ? frontMatter.name.trim() : "";
  const fallbackName = kind === "skill"
    ? (() => {
        const parts = normalizePath(source).split("/");
        const skillIndex = parts.findIndex((part) => part.toLowerCase() === "skill.md");
        return skillIndex > 0 ? parts[skillIndex - 1]! : path.basename(source, path.extname(source));
      })()
    : path.basename(source, path.extname(source));
  return GuidanceMetadataSchema.parse({
    kind,
    name: explicitName || fallbackName,
    description: typeof frontMatter.description === "string" ? frontMatter.description : "",
    globs: typeof globs === "string" ? splitGlobList(globs) : Array.isArray(globs)
      ? globs.filter((value): value is string => typeof value === "string")
      : [],
    alwaysApply: frontMatter.alwaysApply === true,
    roles: Array.isArray(frontMatter.roles)
      ? frontMatter.roles.filter((value): value is string => typeof value === "string")
      : typeof frontMatter.roles === "string" ? [frontMatter.roles] : [],
  });
}

function omissionReason(
  document: KnowledgeDocument,
  role: string,
  knownPaths: string[],
  terms: string[],
): string {
  const guidance = document.guidance;
  if (guidance.roles.length > 0 && !guidance.roles.includes(role)) {
    return `worker role ${role} is outside declared roles`;
  }
  if (
    guidance.kind === "rule" &&
    knownPaths.length > 0 &&
    guidance.globs.length > 0 &&
    !guidance.globs.some((glob) => knownPaths.some((filePath) => matchesGlob(glob, filePath)))
  ) {
    return "known target paths do not match the rule globs";
  }
  if (scoreText(`${document.title}\n${guidance.description}\n${document.content}`, terms) === 0) {
    return "no role, path, or lexical relevance signal";
  }
  return "not selected";
}

function parseFrontMatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  try {
    const parsed: unknown = yaml.load(match[1]!);
    return isRecord(parsed) ? parsed : {};
  } catch {
    // A malformed optional header must not prevent ordinary knowledge indexing.
    return {};
  }
}

function splitGlobList(value: string): string[] {
  const result: string[] = [];
  let start = 0;
  let braceDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "{") braceDepth += 1;
    if (value[index] === "}") braceDepth = Math.max(0, braceDepth - 1);
    if (value[index] === "," && braceDepth === 0) {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  result.push(value.slice(start).trim());
  return result.filter(Boolean);
}

export function matchesGlob(glob: string, filePath: string): boolean {
  const pattern = glob.trim().replace(/^['"]|['"]$/g, "");
  if (!pattern) return false;
  const source = globToRegex(pattern);
  return new RegExp(`^${source}$`, "i").test(filePath.replaceAll("\\", "/"));
}

function globToRegex(pattern: string): string {
  let result = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        result += "(?:.*/)?";
        index += 2;
      } else {
        result += ".*";
        index += 1;
      }
    } else if (char === "*") {
      result += "[^/]*";
    } else if (char === "?") {
      result += "[^/]";
    } else if (char === "{") {
      const end = pattern.indexOf("}", index + 1);
      if (end >= 0) {
        result += `(?:${pattern.slice(index + 1, end).split(",").map(escapeRegex).join("|")})`;
        index = end;
      } else {
        result += "\\{";
      }
    } else {
      result += escapeRegex(char);
    }
  }
  return result;
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((item) => item.replaceAll("\\", "/").replace(/^\.\//, "").trim()).filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function frequencies(terms: string[]): Record<string, number> {
  const result: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const term of terms) result[term] = (result[term] ?? 0) + 1;
  return result;
}

function chunkText(content: string, size: number): string[] {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + size);
    if (end < normalized.length) {
      const boundary = normalized.lastIndexOf("\n", end);
      if (boundary > start + Math.floor(size / 2)) end = boundary;
    }
    chunks.push(normalized.slice(start, end).trim());
    if (end >= normalized.length) break;
    start = Math.max(end - Math.min(200, Math.floor(size / 10)), start + 1);
  }
  return chunks;
}

async function collectFiles(target: string, output: string[]): Promise<void> {
  let info;
  try {
    info = await stat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (info.isFile()) {
    output.push(target);
    return;
  }
  if (!info.isDirectory()) return;
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") continue;
    await collectFiles(path.join(target, entry.name), output);
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Knowledge source escapes repository: ${target}`);
  }
}
