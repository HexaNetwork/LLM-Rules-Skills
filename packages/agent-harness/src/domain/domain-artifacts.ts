import path from "node:path";
import { readdir } from "node:fs/promises";

export type DomainArtifacts = {
  glossaryMap?: string;
  glossaries: string[];
  adrDirs: string[];
};

const SKIP_DIRS = new Set([".git", "node_modules", "dist"]);

/** Walk the workspace for glossary/ADR paths (paths only; no file bodies). */
export async function discoverDomainArtifacts(workspaceRoot: string): Promise<DomainArtifacts> {
  const root = path.resolve(workspaceRoot);
  const glossaryMaps: string[] = [];
  const glossaries: string[] = [];
  const adrDirs: string[] = [];

  await walk(root, root, glossaryMaps, glossaries, adrDirs);

  glossaryMaps.sort(comparePaths);
  glossaries.sort(comparePaths);
  adrDirs.sort(comparePaths);

  const rootMap = glossaryMaps.find((entry) => entry === "GLOSSARY-MAP.md");
  const glossaryMap = rootMap ?? glossaryMaps[0];

  return {
    ...(glossaryMap ? { glossaryMap } : {}),
    glossaries,
    adrDirs,
  };
}

async function walk(
  root: string,
  current: string,
  glossaryMaps: string[],
  glossaries: string[],
  adrDirs: string[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "adr" && (await directoryHasMarkdown(absolute))) {
        adrDirs.push(toRepoRelative(root, absolute));
      }
      await walk(root, absolute, glossaryMaps, glossaries, adrDirs);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name === "GLOSSARY-MAP.md") {
      glossaryMaps.push(toRepoRelative(root, absolute));
    } else if (entry.name === "GLOSSARY.md") {
      glossaries.push(toRepoRelative(root, absolute));
    }
  }
}

async function directoryHasMarkdown(dir: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) return true;
  }
  return false;
}

function toRepoRelative(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/");
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
