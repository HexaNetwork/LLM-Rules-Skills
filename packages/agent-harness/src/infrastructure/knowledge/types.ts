import { z } from "zod";
import type { KnowledgeScope, KnowledgeVisibility } from "../../config.js";

export const GuidanceKindSchema = z.enum(["document", "rule", "skill"]);
export type GuidanceKind = z.infer<typeof GuidanceKindSchema>;

export const GuidanceMetadataSchema = z.object({
  kind: GuidanceKindSchema.default("document"),
  /** Stable override key: skill front-matter name, else rule basename / skill folder. */
  name: z.string().default(""),
  description: z.string().default(""),
  globs: z.array(z.string()).default([]),
  alwaysApply: z.boolean().default(false),
  roles: z.array(z.string()).default([]),
  /** When true, exclude from harness auto-injection (Cursor slash-entrypoint skills). */
  disableModelInvocation: z.boolean().default(false),
});
export type GuidanceMetadata = z.infer<typeof GuidanceMetadataSchema>;

export const DocumentSchema = z.object({
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
export type KnowledgeDocument = z.infer<typeof DocumentSchema>;

export const TermFrequenciesSchema = z.record(
  z.union([z.number(), z.string()]).transform((value) =>
    typeof value === "number" ? value : (Number(value) || 0),
  ),
);

export const ChunkSchema = z.object({
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
export type KnowledgeChunk = z.infer<typeof ChunkSchema>;

export type KnowledgeClassification = {
  scope?: KnowledgeScope;
  projectId?: string;
  visibility?: KnowledgeVisibility;
};

export type KnowledgeSearchOptions = {
  repository?: boolean;
  /** When false, skip document lexical/semantic search (Graphify-only path). Default true. */
  documents?: boolean;
  projectId?: string;
  includeProjects?: string[];
  maxCharacters?: number;
  /** When set, only this run's `.agent-harness/runs/<id>/*` artifacts are visible. */
  runId?: string;
  /** Domain seed tried when Graphify shaping of `query` is empty/generic. */
  fallbackQuery?: string;
  /** Paths from the invocation (affectedPaths / changedFiles) for ranking affinity. */
  pathHints?: string[];
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
    | "diversity-gap"
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

export type IndexedSearchResult = SearchResult & { id: string };

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
  /** Authoritative name lists for this role. Undefined retains relevance-based selection. */
  assignment?: {
    rules: string[];
    skills: string[];
  };
  knownPaths?: string[];
  projectId?: string;
  includeProjects?: string[];
  maxResults?: number;
  maxCharacters?: number;
  /** When set, prefer the run's frozen guidance tree over live roots. */
  runId?: string;
};

export type GuidanceOmission = {
  source: string;
  title: string;
  reason: string;
};

export type GuidanceSelectionAudit = {
  selected: GuidanceSelection[];
  /** Explicitly assigned names that had neither an active-project nor General entry. */
  missingAssignments: Array<{ kind: "rule" | "skill"; name: string; reason: string }>;
  omittedAlwaysApply: GuidanceOmission[];
  /** Global guidance dropped because a same-name project entry won. */
  omittedOverrides: GuidanceOmission[];
};
