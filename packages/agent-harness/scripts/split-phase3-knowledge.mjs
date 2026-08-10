import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const lines = readFileSync(path.join(root, "src", "knowledge.ts.phase3-backup"), "utf8").split(/\r?\n/);
const outDir = path.join(root, "src", "infrastructure", "knowledge");
mkdirSync(outDir, { recursive: true });

function slice(a, b) {
  return lines.slice(a - 1, b).join("\n");
}
function write(name, contents) {
  const file = path.join(outDir, name);
  if (!contents.endsWith("\n")) contents += "\n";
  writeFileSync(file, contents, "utf8");
  console.log("wrote", name, contents.split("\n").length - 1);
}

write(
  "types.ts",
  `import { z } from "zod";
import type { KnowledgeScope, KnowledgeVisibility } from "../../config.js";

${slice(19, 171).replace(/^type GuidanceMetadata = .+$/m, "export type GuidanceMetadata = z.infer<typeof GuidanceMetadataSchema>;")
  .replace(/^type KnowledgeDocument = .+$/m, "export type KnowledgeDocument = z.infer<typeof DocumentSchema>;")
  .replace(/^type KnowledgeChunk = .+$/m, "export type KnowledgeChunk = z.infer<typeof ChunkSchema>;")
  .replace(/^const GuidanceKindSchema/m, "export const GuidanceKindSchema")
  .replace(/^const GuidanceMetadataSchema/m, "export const GuidanceMetadataSchema")
  .replace(/^const DocumentSchema/m, "export const DocumentSchema")
  .replace(/^const TermFrequenciesSchema/m, "export const TermFrequenciesSchema")
  .replace(/^const ChunkSchema/m, "export const ChunkSchema")
  .replace(/^type IndexedSearchResult = .+$/m, "export type IndexedSearchResult = SearchResult & { id: string };")
  .replace(/^const PROJECT_SCOPE_GUIDANCE_BONUS[\s\S]*?\n\n/m, "")}
`,
);

write(
  "path-utils.ts",
  `import path from "node:path";
import { createHash } from "node:crypto";

export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

export function assertInside(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(\`Knowledge source escapes repository: \${target}\`);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
`,
);

write(
  "lexical-search.ts",
  `import type { HarnessConfig } from "../../config.js";
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
  return value.toLocaleLowerCase().match(/[\\p{L}\\p{N}_-]{2,}/gu) ?? [];
}

export function scoreText(value: string, terms: string[]): number {
  const termSet = new Set(terms);
  let score = 0;
  for (const term of tokenize(value)) {
    if (termSet.has(term)) score += 1;
  }
  return score;
}

${slice(837, 867)
  .replace(/^function isVisibleToProject/m, "export function isVisibleToProject")
  .replaceAll("normalizePath(", "normalizePath(")}

${slice(869, 961)
  .replace(/^function rankHybridResults/m, "export function rankHybridResults")
  .replace(/^function diversifyBySource/m, "export function diversifyBySource")
  .replace(/^function rememberFifo/m, "export function rememberFifo")
  .replace(/^function cloneSearchAudit/m, "export function cloneSearchAudit")
  .replace(/^function cloneGuidanceAudit[\\s\\S]*?^}/m, "")}

${slice(976, 983).replace(/^function toKeptEntry/m, "export function toKeptEntry")}

${slice(1004, 1033)
  .replace(/^function capResultCharacters/m, "export function capResultCharacters")
  .replace(/^function capResultCharactersWithOmissions/m, "export function capResultCharactersWithOmissions")}

export function searchResultCacheKey(
  query: string,
  limit: number,
  options: unknown,
  generation: string,
): string {
  return \`\${query}\\0\${JSON.stringify(options)}\\0\${limit}\\0\${generation}\`;
}
`,
);

// Fix tokenize regex - the unicode escape got double-escaped. Write tokenize plainly:
{
  let text = readFileSync(path.join(outDir, "lexical-search.ts"), "utf8");
  text = text.replace(
    "return value.toLocaleLowerCase().match(/[\\\\p{L}\\\\p{N}_-]{2,}/gu) ?? [];",
    "return value.toLocaleLowerCase().match(/[\\p{L}\\p{N}_-]{2,}/gu) ?? [];",
  );
  // remove leftover cloneGuidanceAudit if present broken
  text = text.replace(/\nfunction cloneGuidanceAudit[\s\S]*?\n}\n/, "\n");
  writeFileSync(path.join(outDir, "lexical-search.ts"), text, "utf8");
}

write(
  "document-index.ts",
  `import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import yaml from "js-yaml";
import type { HarnessConfig, KnowledgeScope, KnowledgeVisibility } from "../../config.js";
import { tokenize } from "./lexical-search.js";
import { hash, isRecord, normalizePath } from "./path-utils.js";
import {
  GuidanceMetadataSchema,
  type GuidanceKind,
  type GuidanceMetadata,
  type KnowledgeClassification,
  type KnowledgeDocument,
} from "./types.js";

export const TEXT_EXTENSIONS = new Set([
  ".md", ".mdx", ".mdc", ".txt", ".json", ".yaml", ".yml",
  ".ts", ".tsx", ".js", ".jsx", ".java", ".kt", ".kts",
]);

${slice(825, 835).replace(/^function resolveClassification/m, "export function resolveClassification")}

${slice(1056, 1086).replace(/^function guidanceMetadata/m, "export function guidanceMetadata")}

${slice(1112, 1138)}

${slice(1190, 1231)
  .replace(/^function frequencies/m, "export function frequencies")
  .replace(/^function chunkText/m, "export function chunkText")
  .replace(/^async function collectFiles/m, "export async function collectFiles")}

export function buildChunksFromDocuments(
  documents: KnowledgeDocument[],
  chunkCharacters: number,
) {
  return documents.flatMap((document) =>
    chunkText(document.content, chunkCharacters).map((text, index) => ({
      id: \`\${document.id}:\${String(index).padStart(5, "0")}\`,
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
}

export { hash, normalizePath, assertInside } from "./path-utils.js";
`,
);

// document-index needs assertInside import for re-export - path-utils has it
{
  let text = readFileSync(path.join(outDir, "document-index.ts"), "utf8");
  text = text.replace(
    'import { hash, isRecord, normalizePath } from "./path-utils.js";',
    'import { assertInside, hash, isRecord, normalizePath } from "./path-utils.js";',
  );
  // guidanceMetadata uses path, GuidanceKind - ok
  writeFileSync(path.join(outDir, "document-index.ts"), text, "utf8");
}

write(
  "graphify-lookup.ts",
  `import { buildGraphifyQuery } from "../../graphify.js";
import type { SearchResult } from "./types.js";

/**
 * Project a Graphify repository hit into the current project's SearchResult shape.
 */
export function toCurrentProjectResult(
  result: Omit<SearchResult, "scope" | "projectId" | "visibility" | "kind">,
  projectId: string,
): SearchResult {
  return { ...result, scope: "project", projectId, visibility: "private", kind: "document" };
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
`,
);

// guidance-selector: globs + pure selection
write(
  "guidance-selector.ts",
  `import path from "node:path";
import { chunkText, normalizePath } from "./document-index.js";
import { scoreText, tokenize } from "./lexical-search.js";
import type {
  GuidanceOmission,
  GuidanceSelection,
  GuidanceSelectionAudit,
  GuidanceSelectionOptions,
  KnowledgeDocument,
} from "./types.js";

/** Prefer project guidance over otherwise-comparable global guidance (stronger than search +0.001). */
export const PROJECT_SCOPE_GUIDANCE_BONUS = 10;

export function cloneGuidanceAudit(value: GuidanceSelectionAudit): GuidanceSelectionAudit {
  return {
    selected: value.selected.map((item) => ({ ...item })),
    omittedAlwaysApply: value.omittedAlwaysApply.map((item) => ({ ...item })),
    omittedOverrides: (value.omittedOverrides ?? []).map((item) => ({ ...item })),
  };
}

export function guidanceResultCacheKey(
  query: string,
  options: unknown,
  generation: string,
): string {
  return \`\${query}\\0\${JSON.stringify(options)}\\0\${generation}\`;
}

${slice(964, 974).replace(/^function guidanceOverrideName/m, "export function guidanceOverrideName")}

${slice(1048, 1054).replace(/^function bestGuidanceExcerpt/m, "export function bestGuidanceExcerpt")}

${slice(1088, 1110).replace(/^function omissionReason/m, "export function omissionReason")}

${slice(1140, 1184)
  .replace(/^export function matchesGlob/m, "export function matchesGlob")
  .replace(/^function uniquePaths/m, "export function uniquePaths")}

function isVisibleToProject(
  chunk: Pick<KnowledgeDocument, "scope" | "projectId" | "visibility">,
  activeProjectId: string,
  includedProjects: string[],
): boolean {
  if (chunk.scope === "global") return true;
  if (chunk.projectId === activeProjectId) return true;
  return chunk.visibility === "shared" && includedProjects.includes(chunk.projectId ?? "");
}

export function selectGuidanceFromDocuments(
  documents: KnowledgeDocument[],
  query: string,
  options: GuidanceSelectionOptions & { chunkCharacters: number },
  defaults: { maxResults: number; maxCharacters: number; projectId: string },
): GuidanceSelectionAudit {
  const terms = [...new Set(tokenize(\`\${options.role} \${query}\`))];
  const maxResults = options.maxResults ?? defaults.maxResults;
  const maxCharacters = options.maxCharacters ?? defaults.maxCharacters;
  if (terms.length === 0 || maxResults <= 0 || maxCharacters <= 0) {
    return { selected: [], omittedAlwaysApply: [], omittedOverrides: [] };
  }
  const activeProjectId = options.projectId ?? defaults.projectId;
  const knownPaths = uniquePaths(options.knownPaths ?? []);
  const filtered = documents.filter(
    (document) =>
      document.guidance.kind !== "document" &&
      isVisibleToProject(document, activeProjectId, options.includeProjects ?? []),
  );

  const scored = filtered
    .flatMap((document) => {
      const guidance = document.guidance;
      if (guidance.roles.length > 0 && !guidance.roles.includes(options.role)) return [];
      const matchingGlobs = guidance.globs.filter((glob) =>
        knownPaths.some((filePath) => matchesGlob(glob, filePath)),
      );
      if (guidance.kind === "rule" && knownPaths.length > 0 && guidance.globs.length > 0 && matchingGlobs.length === 0) {
        return [];
      }
      const lexicalScore = scoreText(
        \`\${document.title}\\n\${guidance.description}\\n\${document.content}\`,
        terms,
      );
      const roleMatch = guidance.roles.includes(options.role);
      const globMatch = matchingGlobs.length > 0;
      if (!roleMatch && !globMatch && lexicalScore === 0) return [];
      const projectScope =
        document.scope === "project" &&
        (document.projectId === undefined || document.projectId === activeProjectId);
      const score =
        lexicalScore +
        (roleMatch ? 100 : 0) +
        (globMatch ? 80 : 0) +
        (guidance.alwaysApply ? 20 : 0) +
        (projectScope ? PROJECT_SCOPE_GUIDANCE_BONUS : 0);
      const reason = [
        ...(roleMatch ? ["role match"] : []),
        ...(globMatch ? [\`path matches \${matchingGlobs.join(", ")}\`] : []),
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
    const excerpt = bestGuidanceExcerpt(
      candidate.document.content,
      terms,
      options.chunkCharacters,
    ).slice(0, remaining);
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
  const omittedAlwaysApply = filtered
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
`,
);

console.log("knowledge helper modules written");
