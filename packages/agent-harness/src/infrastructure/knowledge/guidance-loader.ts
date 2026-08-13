import path from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import type { KnowledgeScope, KnowledgeVisibility } from "../../config/schema.js";
import { guidanceMetadata, hash, normalizePath } from "./document-index.js";
import type { KnowledgeDocument } from "./types.js";

export type GuidanceLoadRoot = {
  /** Absolute filesystem path to a guidance tree (no assertInside). */
  absolutePath: string;
  scope: KnowledgeScope;
  projectId?: string;
  visibility?: KnowledgeVisibility;
};

/**
 * Load rule/skill guidance directly from trusted harness roots.
 * Precedence is first-root-wins for the same relative path.
 */
export async function loadGuidanceDocuments(
  roots: GuidanceLoadRoot[],
  options: { projectId?: string } = {},
): Promise<KnowledgeDocument[]> {
  const bySource = new Map<string, KnowledgeDocument>();
  for (const root of roots) {
    const info = await stat(root.absolutePath).catch(() => undefined);
    if (!info?.isDirectory()) continue;
    const files = await listGuidanceFiles(root.absolutePath);
    for (const filePath of files) {
      const relative = normalizePath(path.relative(root.absolutePath, filePath));
      if (!relative || relative.startsWith("..")) continue;
      if (bySource.has(relative)) continue;
      const content = await readFile(filePath, "utf8");
      const guidance = guidanceMetadata(relative, content);
      if (guidance.kind === "document") continue;
      const scope = root.scope;
      const projectId =
        scope === "project" ? (root.projectId ?? options.projectId) : undefined;
      const visibility = root.visibility ?? "private";
      bySource.set(relative, {
        id: hash(`${scope}:${projectId ?? ""}:${relative}`),
        source: relative,
        title: path.basename(filePath),
        content,
        hash: hash(content),
        updatedAt: new Date().toISOString(),
        scope,
        projectId,
        visibility,
        managedByConfig: false,
        guidance,
      });
    }
  }
  return [...bySource.values()].sort((a, b) =>
    `${a.scope}:${a.projectId ?? ""}:${a.source}`.localeCompare(
      `${b.scope}:${b.projectId ?? ""}:${b.source}`,
    ),
  );
}

/** Stable cache key for a guidance root list (file mtimes/sizes, or an explicit frozen hash). */
export async function guidanceRootsGeneration(
  roots: GuidanceLoadRoot[],
  frozenHash?: string,
): Promise<string> {
  if (frozenHash) return `frozen:${frozenHash}`;
  const parts = await Promise.all(
    roots.map(async (root) => {
      const info = await stat(root.absolutePath).catch(() => undefined);
      if (!info?.isDirectory()) return `${root.scope}:${root.absolutePath}:missing`;
      const files = await listGuidanceFiles(root.absolutePath);
      const fingerprints = await Promise.all(
        files.map(async (filePath) => {
          const fileInfo = await stat(filePath);
          const relative = normalizePath(path.relative(root.absolutePath, filePath));
          return `${relative}:${fileInfo.mtimeMs}:${fileInfo.size}`;
        }),
      );
      fingerprints.sort();
      return `${root.scope}:${root.absolutePath}:${fingerprints.join(",")}`;
    }),
  );
  return parts.join("|");
}

async function listGuidanceFiles(directory: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listGuidanceFiles(full)));
      continue;
    }
    if (!entry.isFile()) continue;
    const lower = entry.name.toLowerCase();
    if (lower.endsWith(".mdc") || lower === "skill.md") out.push(full);
  }
  return out;
}
