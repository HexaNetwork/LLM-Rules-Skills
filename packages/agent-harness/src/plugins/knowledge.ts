import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@deepseek-ai/cordis";

export type KnowledgeHit = {
  path: string;
  excerpt: string;
  score: number;
};

export type KnowledgeService = {
  search(query: string, extraPaths?: string[]): Promise<KnowledgeHit[]>;
};

export function createKnowledgeService(): KnowledgeService {
  return {
    async search(query, extraPaths = []) {
      const roots = [packagedGuidanceRoot(), ...extraPaths];
      const terms = tokenize(query);
      const hits: KnowledgeHit[] = [];
      for (const root of roots) {
        const files = await listFiles(root);
        for (const file of files) {
          const text = await readFile(file, "utf8").catch(() => "");
          const score = terms.reduce((sum, term) => sum + (text.toLowerCase().includes(term) ? 1 : 0), 0);
          if (score === 0) continue;
          hits.push({
            path: file,
            excerpt: text.slice(0, 800),
            score,
          });
        }
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, 8);
    },
  };
}

function packagedGuidanceRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../templates/guidance");
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(md|mdc|txt)$/i.test(entry.name)) out.push(full);
    }
  };
  await walk(root);
  return out;
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 2);
}

export const knowledgePlugin = Object.assign(
  (ctx: Context) => {
    ctx.provide("knowledge", createKnowledgeService());
  },
  {},
);
