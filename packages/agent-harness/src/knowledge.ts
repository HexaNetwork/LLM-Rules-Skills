import path from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { z } from "zod";
import { resolveFrozenGuidanceRoot } from "./application/component-freeze.js";
import { resolveHarnessPaths, type HarnessPaths } from "./application/paths.js";
import type { HarnessConfig, KnowledgeScope, KnowledgeVisibility } from "./config/schema.js";
import { LocalEmbeddingIndex } from "./embeddings.js";
import {
  CodegraphRepositoryLookup,
  INDEX_SOURCE,
  type RepositoryLookup,
} from "./codegraph.js";
import {
  TEXT_EXTENSIONS,
  assertInside,
  buildChunksFromDocuments,
  collectFiles,
  guidanceMetadata,
  hash,
  normalizePath,
  resolveClassification,
} from "./infrastructure/knowledge/document-index.js";
import {
  guidanceRootsGeneration,
  loadGuidanceDocuments,
  type GuidanceLoadRoot,
} from "./infrastructure/knowledge/guidance-loader.js";
import {
  cloneCompiledGuidancePack,
  compileRoleGuidancePack,
  guidancePackCacheKey,
} from "./infrastructure/knowledge/guidance-pack.js";
import { matchesGlob } from "./infrastructure/knowledge/guidance-selector.js";
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
} from "./infrastructure/knowledge/lexical-search.js";
import {
  ChunkSchema,
  DocumentSchema,
  type CompiledGuidancePack,
  type GuidanceSelection,
  type GuidanceSelectionAudit,
  type GuidanceSelectionOptions,
  type IndexedSearchResult,
  type KnowledgeChunk,
  type KnowledgeClassification,
  type KnowledgeDocument,
  type KnowledgeRefreshProgress,
  type KnowledgeSearchAudit,
  type KnowledgeSearchOptions,
  type RetrievalOmission,
  type SearchResult,
} from "./infrastructure/knowledge/types.js";

export type {
  CompiledGuidancePack,
  GuidanceKind,
  GuidanceOmission,
  GuidanceSelection,
  GuidanceSelectionAudit,
  GuidanceSelectionOptions,
  KnowledgeClassification,
  KnowledgeRefreshProgress,
  KnowledgeSearchAudit,
  KnowledgeSearchOptions,
  RetrievalAudit,
  RetrievalOmission,
  SearchResult,
} from "./infrastructure/knowledge/types.js";
export { isVisibleForRun } from "./infrastructure/knowledge/lexical-search.js";
export { matchesGlob } from "./infrastructure/knowledge/guidance-selector.js";
export { compactDomainSeed } from "./codegraph.js";

/** Optional filesystem roots for injected-only guidance (not knowledge.sources). */
export type KnowledgeGuidanceRoots = {
  projectRoot?: string;
  sharedRoot?: string;
  /** Parent of per-run directories; used with `runId` to resolve frozen guidance. */
  runsRoot?: string;
};

export class LocalKnowledgeBase {
  private readonly directory: string;
  private readonly documentsPath: string;
  private readonly chunksPath: string;
  private readonly embeddings: LocalEmbeddingIndex;
  private readonly repositoryLookup: RepositoryLookup;
  private readonly paths: HarnessPaths;
  private readonly guidanceRoots: KnowledgeGuidanceRoots;
  private cachedDocuments?: KnowledgeDocument[];
  private cachedChunks?: KnowledgeChunk[];
  private cachedGuidanceDocuments?: KnowledgeDocument[];
  private indexGeneration = "";
  private guidanceGeneration = "";
  private readonly searchResultCache = new Map<string, KnowledgeSearchAudit>();
  private readonly guidancePackCache = new Map<string, CompiledGuidancePack>();
  private static readonly RESULT_CACHE_LIMIT = 64;

  constructor(
    private readonly config: HarnessConfig,
    repositoryLookup?: RepositoryLookup,
    paths: HarnessPaths = resolveHarnessPaths(config),
    guidanceRoots: KnowledgeGuidanceRoots = {},
  ) {
    this.paths = paths;
    this.guidanceRoots = {
      projectRoot: guidanceRoots.projectRoot ?? config.knowledge.guidance.projectRoot,
      sharedRoot: guidanceRoots.sharedRoot ?? config.knowledge.guidance.sharedRoot,
      runsRoot: guidanceRoots.runsRoot ?? path.join(paths.stateRoot, "runs"),
    };
    this.repositoryLookup = repositoryLookup ?? new CodegraphRepositoryLookup(config, undefined, paths);
    this.directory = config.knowledge.sharedIndexDirectory
      ? path.resolve(paths.controlRoot, config.knowledge.sharedIndexDirectory)
      : path.join(paths.stateRoot, "knowledge");
    this.documentsPath = path.join(this.directory, "documents.json");
    this.chunksPath = path.join(this.directory, "chunks.json");
    this.embeddings = new LocalEmbeddingIndex(this.directory, config.knowledge.embeddings);
  }

  private get workspaceRoot(): string {
    return this.paths.workspaceRoot;
  }

  async refresh(onProgress?: (progress: KnowledgeRefreshProgress) => void): Promise<number> {
    onProgress?.({ stage: "discovering", completed: 0, total: 0, message: "Discovering configured documents" });
    const files: Array<{
      filePath: string;
      classification: { scope: KnowledgeScope; projectId?: string; visibility: KnowledgeVisibility };
    }> = [];
    for (const source of this.config.knowledge.sources) {
      const resolved = path.resolve(this.workspaceRoot, source.path);
      assertInside(this.workspaceRoot, resolved);
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
      `${classification.scope}:${classification.projectId}:${normalizePath(path.relative(this.workspaceRoot, filePath))}`,
    )));
    const documents = await this.loadDocuments();
    // A shared index can be maintained by more than one project config, so it
    // must never delete another project's configured sources. A private local
      // index, on the other hand, drops stale automatically-managed entries when
    // the source list changes (for example, when source code is removed from
    // document retrieval in favour of CodeGraph).
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
    const source = normalizePath(path.relative(this.workspaceRoot, filePath));
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
    const cacheKey = searchResultCacheKey(query, limit, options, generation);
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
    const emptyCodegraph = {
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
          codegraph: { ...emptyCodegraph, skippedReason: "empty-query" },
          kept: [],
          omitted,
        },
      };
    }
    const documentsEnabled = options.documents !== false;
    const activeProjectId = options.projectId ?? this.config.knowledge.projectId;
    const [chunks, repositoryLookup] = await Promise.all([
      documentsEnabled
        ? this.loadChunks()
        : Promise.resolve([] as KnowledgeChunk[]),
      options.repository === false
        ? Promise.resolve({
            result: undefined,
            shapedQuery: "",
            usedFallback: false,
            skippedReason: "repository-disabled",
          } satisfies Awaited<ReturnType<RepositoryLookup["search"]>>)
        : this.repositoryLookup.search(query, {
            fallbackQuery: options.fallbackQuery,
            pathHints: options.pathHints,
          }),
    ]);
    const codegraphAudit = {
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
        source: INDEX_SOURCE,
        title: "Repository relationships (CodeGraph)",
        score: 0,
        reason: "codegraph-skipped",
      });
    }
    if (!documentsEnabled) {
      const repositoryResult = repositoryLookup.result
        ? toCurrentProjectResult(repositoryLookup.result, activeProjectId)
        : undefined;
      const results = repositoryResult ? [repositoryResult] : [];
      codegraphAudit.included = Boolean(repositoryResult);
      if (repositoryResult) codegraphAudit.skippedReason = undefined;
      return {
        results: capResultCharacters(results, options.maxCharacters),
        audit: {
          query,
          fallbackQuery: options.fallbackQuery,
          codegraph: codegraphAudit,
          kept: results.map(toKeptEntry),
          omitted,
          skipped: "rag-disabled",
        },
      };
    }
    const stateDirectory = normalizePath(this.config.stateDirectory);
    // Guidance is injected-only and never indexed; every chunk is a document.
    const allowedChunks = chunks.filter(
      (chunk) =>
        isVisibleToProject(chunk, activeProjectId, options.includeProjects ?? []) &&
        isVisibleForRun(chunk.source, options.runId, stateDirectory),
    );
    if (allowedChunks.length === 0) {
      const repositoryResult = repositoryLookup.result
        ? toCurrentProjectResult(repositoryLookup.result, activeProjectId)
        : undefined;
      const results = repositoryResult ? [repositoryResult] : [];
      codegraphAudit.included = Boolean(repositoryResult);
      if (repositoryResult) codegraphAudit.skippedReason = undefined;
      return {
        results: capResultCharacters(results, options.maxCharacters),
        audit: {
          query,
          fallbackQuery: options.fallbackQuery,
          codegraph: codegraphAudit,
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
        // Prefer the active project's conventions when lexical evidence is otherwise equal.
        if (score > 0 && chunk.scope === "project" && chunk.projectId === activeProjectId) score += 0.001;
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
      new Set(allowedChunks.map((chunk) => chunk.id)),
    );
    const scoredLexicalIds = new Set(scoredLexical.map((result) => result.id));
    const acceptedLexicalIds = new Set(lexical.map((result) => result.id));
    const { minSemanticOnlySimilarity } = this.config.knowledge.embeddings;
    const semanticCandidates: IndexedSearchResult[] = allowedChunks
      .filter((chunk) => {
        if (!semanticScores.has(chunk.id)) return false;
        // Embeddings must not resurrect lexical rows already refused by the floor.
        if (scoredLexicalIds.has(chunk.id) && !acceptedLexicalIds.has(chunk.id)) return false;
        // Semantic-only hits (no lexical evidence) need a stricter cosine floor.
        if (!acceptedLexicalIds.has(chunk.id)) {
          const cosine = semanticScores.get(chunk.id) ?? 0;
          if (cosine < minSemanticOnlySimilarity) return false;
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
    const documentSlots = repositoryLookup.result ? Math.max(0, limit - 1) : limit;
    const diversified = diversifyBySource(
      ranked,
      documentSlots,
      {
        maxPerSource: maxChunksPerSource,
        maxForTopSource,
        // Soft diversity: do not pad weak secondary sources to fill slots.
        newSourceScoreRatio: 0.85,
      },
      omitted,
    );
    const merged = repositoryLookup.result
      ? [toCurrentProjectResult(repositoryLookup.result, activeProjectId), ...diversified]
      : diversified;
    codegraphAudit.included = Boolean(repositoryLookup.result);
    if (repositoryLookup.result) codegraphAudit.skippedReason = undefined;
    const capped = capResultCharactersWithOmissions(merged, options.maxCharacters, omitted);
    return {
      results: capped,
      audit: {
        query,
        fallbackQuery: options.fallbackQuery,
        codegraph: codegraphAudit,
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

  async compileRoleGuidancePack(
    role: string,
    options: Omit<GuidanceSelectionOptions, "role"> = {},
  ): Promise<CompiledGuidancePack> {
    const assignment = options.assignment ?? { rules: [], skills: [] };
    const { documents, generation } = await this.loadGuidanceDocumentsForSelection(options.runId);
    const maxCharacters = options.maxCharacters ?? this.config.knowledge.guidance.maxCharacters;
    const projectId = options.projectId ?? this.config.knowledge.projectId;
    const cacheKey = guidancePackCacheKey(
      role,
      generation,
      assignment,
      maxCharacters,
      projectId,
      options.includeProjects ?? [],
    );
    const cached = this.guidancePackCache.get(cacheKey);
    if (cached) return cloneCompiledGuidancePack(cached);

    const result = compileRoleGuidancePack(documents, {
      assignment,
      maxCharacters,
      projectId,
      includeProjects: options.includeProjects,
    });
    rememberFifo(
      this.guidancePackCache,
      cacheKey,
      cloneCompiledGuidancePack(result),
      LocalKnowledgeBase.RESULT_CACHE_LIMIT,
    );
    return cloneCompiledGuidancePack(result);
  }

  async selectGuidanceWithAudit(
    query: string,
    options: GuidanceSelectionOptions,
  ): Promise<GuidanceSelectionAudit> {
    const pack = await this.compileRoleGuidancePack(options.role, {
      ...options,
      assignment: options.assignment ?? { rules: [], skills: [] },
    });
    return {
      selected: pack.selected.map((item, index) => ({
        ...item,
        excerpt: "",
        reason: "agent assignment",
        score: 1_000 - index,
      })),
      missingAssignments: pack.missingAssignments,
      omittedAlwaysApply: [],
      omittedOverrides: pack.omittedOverrides,
      sources: pack.sources,
      guidancePack: pack.text,
      ...(pack.truncated ? { truncated: pack.truncated } : {}),
    };
  }

  private async loadGuidanceDocumentsForSelection(
    runId?: string,
  ): Promise<{ documents: KnowledgeDocument[]; generation: string }> {
    const roots = await this.resolveGuidanceLoadRoots(runId);
    const frozenHash =
      runId && this.guidanceRoots.runsRoot
        ? (await resolveFrozenGuidanceRoot(this.guidanceRoots.runsRoot, runId))?.sha256
        : undefined;
    const generation = await guidanceRootsGeneration(roots, frozenHash);
    if (generation === this.guidanceGeneration && this.cachedGuidanceDocuments) {
      return { documents: this.cachedGuidanceDocuments, generation };
    }
    const documents = await loadGuidanceDocuments(roots, {
      projectId: this.config.knowledge.projectId,
    });
    this.cachedGuidanceDocuments = documents;
    this.guidanceGeneration = generation;
    this.guidancePackCache.clear();
    return { documents, generation };
  }

  private async resolveGuidanceLoadRoots(runId?: string): Promise<GuidanceLoadRoot[]> {
    if (runId && this.guidanceRoots.runsRoot) {
      const frozen = await resolveFrozenGuidanceRoot(this.guidanceRoots.runsRoot, runId);
      if (frozen) {
        return [{ absolutePath: frozen.path, scope: "global", visibility: "private" }];
      }
    }
    const roots: GuidanceLoadRoot[] = [];
    const projectRoot = this.guidanceRoots.projectRoot?.trim();
    if (projectRoot) {
      roots.push({
        absolutePath: path.resolve(projectRoot),
        scope: "project",
        projectId: this.config.knowledge.projectId,
        visibility: "private",
      });
    }
    const sharedRoot = this.guidanceRoots.sharedRoot?.trim();
    if (sharedRoot) {
      roots.push({
        absolutePath: path.resolve(sharedRoot),
        scope: "global",
        visibility: "private",
      });
    }
    return roots;
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
  }

  private async persist(documents: KnowledgeDocument[]): Promise<void> {
    this.invalidateCaches();
    await mkdir(this.directory, { recursive: true });
    const normalizedDocuments = documents.map((document) => ({
      ...document,
      guidance: guidanceMetadata(document.source, document.content),
    }));
    const chunks = buildChunksFromDocuments(normalizedDocuments, this.config.knowledge.chunkCharacters);
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
        chunks.map((chunk) => ({ id: chunk.id, text: chunk.text, textHash: hash(chunk.text) })),
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

function toCurrentProjectResult(
  result: Omit<SearchResult, "scope" | "projectId" | "visibility" | "kind">,
  projectId: string,
): SearchResult {
  return { ...result, scope: "project", projectId, visibility: "private", kind: "document" };
}
