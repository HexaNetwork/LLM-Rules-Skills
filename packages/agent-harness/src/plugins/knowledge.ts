import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import type { GuidanceAssignment } from "../domain/agent-roles.js";

export type KnowledgeHit = {
  path: string;
  excerpt: string;
  score: number;
};

export type CompiledGuidancePack = {
  text: string;
  sources: string[];
  selected: Array<{ kind: "rule" | "skill"; name: string; source: string }>;
  missingAssignments: Array<{ kind: "rule" | "skill"; name: string; reason: string }>;
  truncated?: { before: number; after: number };
};

export type CompileRoleGuidanceOptions = {
  assignment: GuidanceAssignment;
  maxCharacters: number;
  extraPaths?: string[];
};

export type KnowledgeService = {
  search(query: string, extraPaths?: string[]): Promise<KnowledgeHit[]>;
  compileRoleGuidancePack(options: CompileRoleGuidanceOptions): Promise<CompiledGuidancePack>;
};

type GuidanceDocument = {
  kind: "rule" | "skill";
  name: string;
  source: string;
  content: string;
};

export function createKnowledgeService(): KnowledgeService {
  return {
    async search(query, extraPaths = []) {
      const roots = [packagedGuidanceRoot(), ...extraPaths];
      const terms = tokenize(query);
      const hits: KnowledgeHit[] = [];
      for (const root of roots) {
        const files = await listFiles(root, { guidanceOnly: false });
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

    async compileRoleGuidancePack(options) {
      const catalog = await loadGuidanceCatalog([
        packagedGuidanceRoot(),
        ...(options.extraPaths ?? []),
      ]);
      const ordered: Array<{ kind: "rule" | "skill"; name: string }> = [
        ...options.assignment.rules.map((name) => ({
          kind: "rule" as const,
          name: name.trim().toLowerCase(),
        })),
        ...options.assignment.skills.map((name) => ({
          kind: "skill" as const,
          name: name.trim().toLowerCase(),
        })),
      ].filter((item) => item.name.length > 0);

      if (ordered.length === 0 || options.maxCharacters <= 0) {
        return {
          text: "",
          sources: [],
          selected: [],
          missingAssignments: [],
        };
      }

      const selected: CompiledGuidancePack["selected"] = [];
      const missingAssignments: CompiledGuidancePack["missingAssignments"] = [];
      const parts: string[] = [];

      for (const item of ordered) {
        const key = `${item.kind}:${item.name}`;
        const document = catalog.get(key);
        if (!document) {
          missingAssignments.push({
            kind: item.kind,
            name: item.name,
            reason: `${item.kind} '${item.name}' was assigned but not found in guidance roots`,
          });
          continue;
        }
        selected.push({ kind: item.kind, name: item.name, source: document.source });
        parts.push(document.content);
      }

      const joined = parts.filter(Boolean).join("\n\n").trim();
      if (joined.length <= options.maxCharacters) {
        return {
          text: joined,
          sources: selected.map((item) => item.source),
          selected,
          missingAssignments,
        };
      }
      return {
        text: joined.slice(0, options.maxCharacters),
        sources: selected.map((item) => item.source),
        selected,
        missingAssignments,
        truncated: { before: joined.length, after: options.maxCharacters },
      };
    },
  };
}

function packagedGuidanceRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../templates/guidance");
}

async function loadGuidanceCatalog(roots: string[]): Promise<Map<string, GuidanceDocument>> {
  const catalog = new Map<string, GuidanceDocument>();
  for (const root of roots) {
    const files = await listFiles(root, { guidanceOnly: true });
    for (const file of files) {
      const text = await readFile(file, "utf8").catch(() => "");
      const relative = normalizePath(path.relative(root, file));
      const document = classifyGuidance(relative, text);
      if (!document) continue;
      const key = `${document.kind}:${document.name}`;
      if (!catalog.has(key)) catalog.set(key, document);
    }
  }
  return catalog;
}

function classifyGuidance(relative: string, text: string): GuidanceDocument | undefined {
  const base = path.basename(relative).toLowerCase();
  const frontmatterName = readFrontmatterName(text);
  const body = stripYamlFrontmatter(text);
  if (!body) return undefined;

  if (base === "skill.md") {
    const parts = relative.split("/");
    const skillIndex = parts.findIndex((part) => part.toLowerCase() === "skill.md");
    const folder = skillIndex > 0 ? parts[skillIndex - 1]! : path.basename(path.dirname(relative));
    const name = (frontmatterName || folder).trim().toLowerCase();
    if (!name) return undefined;
    return { kind: "skill", name, source: relative, content: body };
  }

  if (base.endsWith(".mdc")) {
    const name = (frontmatterName || path.basename(relative, path.extname(relative))).trim().toLowerCase();
    if (!name) return undefined;
    return { kind: "rule", name, source: relative, content: body };
  }
  return undefined;
}

function readFrontmatterName(content: string): string | undefined {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return undefined;
  const nameMatch = match[1]!.match(/^\s*name:\s*["']?([^"'\r\n]+?)["']?\s*$/m);
  return nameMatch?.[1]?.trim() || undefined;
}

export function stripYamlFrontmatter(content: string): string {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return content.trim();
  return content.slice(match[0].length).trim();
}

async function listFiles(
  root: string,
  options: { guidanceOnly: boolean },
): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (options.guidanceOnly) {
        if (lower === "skill.md" || lower.endsWith(".mdc")) out.push(full);
        continue;
      }
      if (/\.(md|mdc|txt)$/i.test(entry.name)) out.push(full);
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

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

export const knowledgePlugin = Object.assign(
  (ctx: Context) => {
    ctx.provide("knowledge", createKnowledgeService());
  },
  {},
);
