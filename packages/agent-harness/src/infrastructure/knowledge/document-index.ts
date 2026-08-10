import path from "node:path";
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

export function resolveClassification(
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

export function guidanceMetadata(source: string, content: string): GuidanceMetadata {
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

export function frequencies(terms: string[]): Record<string, number> {
  const result: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const term of terms) result[term] = (result[term] ?? 0) + 1;
  return result;
}

export function chunkText(content: string, size: number): string[] {
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

export async function collectFiles(target: string, output: string[]): Promise<void> {
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

export function buildChunksFromDocuments(
  documents: KnowledgeDocument[],
  chunkCharacters: number,
) {
  return documents.flatMap((document) =>
    chunkText(document.content, chunkCharacters).map((text, index) => ({
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
}

export { hash, normalizePath, assertInside } from "./path-utils.js";
