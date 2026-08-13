import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const lines = readFileSync(path.join(root, "src", "knowledge.ts.phase3-backup"), "utf8").split(/\r?\n/);

// Class body: lines 190-823 (export class ... through closing brace)
let classBody = lines.slice(189, 823).join("\n");

// Patch cache keys and guidance selection + persist chunking
classBody = classBody
  .replace(
    "const cacheKey = `${query}\\0${JSON.stringify(options)}\\0${limit}\\0${generation}`;",
    "const cacheKey = searchResultCacheKey(query, limit, options, generation);",
  )
  .replace(
    "const cacheKey = `${query}\\0${JSON.stringify(options)}\\0${generation}`;",
    "const cacheKey = guidanceResultCacheKey(query, options, generation);",
  );

// Replace selectGuidanceWithAuditUncached body with delegation
const selectStart = classBody.indexOf("private async selectGuidanceWithAuditUncached(");
const selectEnd = classBody.indexOf("private async loadDocuments(");
if (selectStart < 0 || selectEnd < 0) {
  throw new Error("Could not locate guidance selection method bounds");
}
const selectReplacement = `private async selectGuidanceWithAuditUncached(
    query: string,
    options: GuidanceSelectionOptions,
  ): Promise<GuidanceSelectionAudit> {
    const documents = await this.loadDocuments();
    return selectGuidanceFromDocuments(
      documents,
      query,
      { ...options, chunkCharacters: this.config.knowledge.chunkCharacters },
      {
        maxResults: this.config.knowledge.guidance.maxResults,
        maxCharacters: this.config.knowledge.guidance.maxCharacters,
        projectId: this.config.knowledge.projectId,
      },
    );
  }

  `;
classBody = classBody.slice(0, selectStart) + selectReplacement + classBody.slice(selectEnd);

// Replace persist chunk building with buildChunksFromDocuments
classBody = classBody.replace(
  /const chunks = normalizedDocuments\.flatMap\(\(document\) =>\s*chunkText\(document\.content, this\.config\.knowledge\.chunkCharacters\)\.map\(\(text, index\) => \(\{[\s\S]*?\}\)\),\s*\);/,
  "const chunks = buildChunksFromDocuments(normalizedDocuments, this.config.knowledge.chunkCharacters);",
);

const facade = `import path from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { z } from "zod";
import type {
  HarnessConfig,
  KnowledgeScope,
  KnowledgeVisibility,
} from "./config.js";
import { LocalEmbeddingIndex } from "./embeddings.js";
import {
  CodegraphRepositoryLookup,
  GRAPH_PATH,
  type RepositoryLookup,
} from "./graphify.js";
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
import { compactDomainSeed, toCurrentProjectResult } from "./infrastructure/knowledge/graphify-lookup.js";
import {
  cloneGuidanceAudit,
  guidanceResultCacheKey,
  matchesGlob,
  selectGuidanceFromDocuments,
} from "./infrastructure/knowledge/guidance-selector.js";
import {
  capResultCharactersWithOmissions,
  cloneSearchAudit,
  diversifyBySource,
  isVisibleForRun,
  isVisibleToProject,
  rankHybridResults,
  rememberFifo,
  searchResultCacheKey,
  toKeptEntry,
  tokenize,
} from "./infrastructure/knowledge/lexical-search.js";
import {
  ChunkSchema,
  DocumentSchema,
  type GuidanceSelection,
  type GuidanceSelectionAudit,
  type GuidanceSelectionOptions,
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
export { compactDomainSeed } from "./infrastructure/knowledge/graphify-lookup.js";

${classBody}
`;

writeFileSync(path.join(root, "src", "knowledge.ts"), facade.endsWith("\n") ? facade : `${facade}\n`, "utf8");
console.log("wrote knowledge.ts facade", facade.split("\n").length, "lines");
