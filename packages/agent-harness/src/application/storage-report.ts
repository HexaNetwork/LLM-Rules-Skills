import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ProjectPaths } from "./harness-home.js";

export type StorageCategory =
  | "worktrees"
  | "run-artifacts-sessions"
  | "knowledge-indexes"
  | "logs-caches"
  | "other";

export type StorageUsage = {
  category: StorageCategory;
  path: string;
  bytes: number;
  entries: number;
};

export type ProjectStorageReport = {
  projectKey: string;
  controlRoot: string;
  worktreeRoot: string;
  projectStateRoot: string;
  categories: StorageUsage[];
  totalBytes: number;
};

/** Report external storage consumption by category before cleanup/deletion. */
export async function reportProjectStorage(paths: ProjectPaths): Promise<ProjectStorageReport> {
  const categories: StorageUsage[] = [];

  categories.push(await measureCategory("worktrees", paths.worktreeRoot));
  categories.push(
    await measureCategory("run-artifacts-sessions", paths.runsRoot, {
      includeNames: ["artifacts", "sessions", "events.jsonl", "state.json", "config.json"],
    }),
  );
  categories.push(await measureCategory("knowledge-indexes", paths.projectKnowledgeRoot));
  categories.push(
    await measureCategory("logs-caches", path.join(paths.projectStateRoot, "cache")),
  );

  const accounted = new Set(categories.map((item) => path.resolve(item.path)));
  // Catch remaining project state not covered above.
  const otherBytes = await directoryBytes(paths.projectStateRoot, accounted);
  categories.push({
    category: "other",
    path: paths.projectStateRoot,
    bytes: otherBytes.bytes,
    entries: otherBytes.entries,
  });

  const totalBytes = categories.reduce((sum, item) => sum + item.bytes, 0);
  return {
    projectKey: paths.projectKey,
    controlRoot: paths.controlRoot,
    worktreeRoot: paths.worktreeRoot,
    projectStateRoot: paths.projectStateRoot,
    categories,
    totalBytes,
  };
}

async function measureCategory(
  category: StorageCategory,
  root: string,
  _options?: { includeNames?: string[] },
): Promise<StorageUsage> {
  const measured = await directoryBytes(root);
  return {
    category,
    path: root,
    bytes: measured.bytes,
    entries: measured.entries,
  };
}

async function directoryBytes(
  root: string,
  skipExact: Set<string> = new Set(),
): Promise<{ bytes: number; entries: number }> {
  const resolved = path.resolve(root);
  if (skipExact.has(resolved)) return { bytes: 0, entries: 0 };
  let info;
  try {
    info = await stat(resolved);
  } catch {
    return { bytes: 0, entries: 0 };
  }
  if (info.isFile()) return { bytes: info.size, entries: 1 };
  if (!info.isDirectory()) return { bytes: 0, entries: 0 };

  let bytes = 0;
  let entries = 0;
  const stack = [resolved];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const listing = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of listing) {
      const full = path.join(current, entry.name);
      if (skipExact.has(path.resolve(full))) continue;
      if (entry.isDirectory()) {
        stack.push(full);
        entries += 1;
      } else if (entry.isFile()) {
        const fileInfo = await stat(full).catch(() => undefined);
        bytes += fileInfo?.size ?? 0;
        entries += 1;
      }
    }
  }
  return { bytes, entries };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value.toFixed(unit === "B" ? 0 : 1)} ${unit}`;
}
