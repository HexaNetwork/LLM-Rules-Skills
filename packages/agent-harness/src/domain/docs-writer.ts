import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FogResolution } from "./types.js";

export type GlossaryEntry = {
  term: string;
  definition: string;
  avoid?: string[];
};

export type DocsWriterOutput = {
  glossary: GlossaryEntry[];
  title: string;
  body: string;
};

export type DocsWriterPacketInput = {
  brief: unknown;
  resolutions?: unknown;
  fogResolutions?: FogResolution[];
  plan?: unknown;
  existingGlossary?: GlossaryEntry[];
  planningFeedback?: unknown;
  operatorNotes?: unknown;
};

const EXISTING_GLOSSARY_CAP = 24;

/** Slim packet for docs-writer: confirmed brief, flat resolutions, no open fog register. */
export function buildDocsWriterInput(input: DocsWriterPacketInput): Record<string, unknown> {
  const packet: Record<string, unknown> = {
    brief: slimBrief(input.brief),
    resolutions: flattenResolutions(input.resolutions),
    fogResolutions: input.fogResolutions ?? [],
    instruction:
      "Return delta glossary entries only for new or changed terms; omit unchanged existing terms.",
  };
  if (input.existingGlossary?.length) {
    packet.existingGlossary = input.existingGlossary;
  }
  if (input.plan !== undefined) packet.plan = input.plan;
  if (input.planningFeedback !== undefined) packet.planningFeedback = input.planningFeedback;
  if (input.operatorNotes !== undefined) packet.operatorNotes = input.operatorNotes;
  return packet;
}

export function slimBrief(reflectBrief: unknown): string | Record<string, unknown> {
  if (typeof reflectBrief === "string") return reflectBrief;
  if (!reflectBrief || typeof reflectBrief !== "object") {
    return String(reflectBrief ?? "");
  }
  const record = reflectBrief as Record<string, unknown>;
  if (typeof record.confirmed === "string" && record.confirmed.trim()) {
    return record.confirmed.trim();
  }
  const structured = asRecord(record.structured) ?? asRecord(record.confirmedStructured);
  if (structured) {
    return {
      restatement: structured.restatement,
      goal: structured.goal,
      inScope: structured.inScope,
      outOfScope: structured.outOfScope,
      assumptions: structured.assumptions,
    };
  }
  return record;
}

function flattenResolutions(resolutions: unknown): Record<string, string> {
  if (!resolutions || typeof resolutions !== "object" || Array.isArray(resolutions)) {
    return {};
  }
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(resolutions as Record<string, unknown>)) {
    if (typeof value === "string") flat[key] = value;
  }
  return flat;
}

export async function loadGlossaryContext(
  worktreePath: string,
  reflectBrief: unknown,
): Promise<GlossaryEntry[]> {
  const existing = await readGlossaryEntries(worktreePath);
  if (existing.length === 0) return [];
  const haystack = briefText(reflectBrief).toLowerCase();
  const referenced = existing.filter((entry) => haystack.includes(entry.term.toLowerCase()));
  if (referenced.length > 0) return referenced;
  return existing.slice(0, EXISTING_GLOSSARY_CAP);
}

export async function readGlossaryEntries(worktreePath: string): Promise<GlossaryEntry[]> {
  const file = path.join(worktreePath, "GLOSSARY.md");
  try {
    const content = await readFile(file, "utf8");
    return parseGlossaryMarkdown(content);
  } catch {
    return [];
  }
}

export function parseGlossaryMarkdown(content: string): GlossaryEntry[] {
  const entries: GlossaryEntry[] = [];
  let current: GlossaryEntry | undefined;
  let definitionLines: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const termMatch = /^\*\*([^*]+)\*\*:\s*$/.exec(line.trim());
    if (termMatch) {
      if (current) {
        current.definition = definitionLines.join("\n").trim();
        entries.push(current);
      }
      current = { term: termMatch[1]!.trim(), definition: "" };
      definitionLines = [];
      continue;
    }
    const avoidMatch = /^_Avoid_:\s*(.+)$/i.exec(line.trim());
    if (avoidMatch && current) {
      current.avoid = avoidMatch[1]!
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      continue;
    }
    if (current && line.trim()) definitionLines.push(line.trim());
  }
  if (current) {
    current.definition = definitionLines.join("\n").trim();
    entries.push(current);
  }
  return entries.filter((entry) => entry.term && entry.definition);
}

export function mergeGlossaryDelta(
  existing: GlossaryEntry[],
  delta: GlossaryEntry[],
): GlossaryEntry[] {
  const byTerm = new Map(existing.map((entry) => [entry.term.toLowerCase(), { ...entry }]));
  for (const entry of delta) {
    if (!entry.term.trim() || !entry.definition.trim()) continue;
    byTerm.set(entry.term.toLowerCase(), {
      term: entry.term.trim(),
      definition: entry.definition.trim(),
      ...(entry.avoid?.length ? { avoid: entry.avoid } : {}),
    });
  }
  return [...byTerm.values()].sort((a, b) => a.term.localeCompare(b.term));
}

const DEFAULT_GLOSSARY_PREAMBLE = `# Glossary

Project domain language.

## Language

`;

export function extractGlossaryPreamble(content: string): string {
  const match = /^\*\*[^*]+\*\*:/m.exec(content);
  if (!match || match.index === undefined) return DEFAULT_GLOSSARY_PREAMBLE;
  const preamble = content.slice(0, match.index).trimEnd();
  return preamble ? `${preamble}\n\n` : DEFAULT_GLOSSARY_PREAMBLE;
}

export function formatGlossaryMarkdown(
  entries: GlossaryEntry[],
  preamble: string = DEFAULT_GLOSSARY_PREAMBLE,
): string {
  const lines: string[] = [];
  const normalizedPreamble = preamble.trimEnd();
  if (normalizedPreamble) lines.push(normalizedPreamble, "");
  for (const entry of entries) {
    lines.push(`**${entry.term}**:`);
    lines.push(entry.definition);
    if (entry.avoid?.length) lines.push(`_Avoid_: ${entry.avoid.join(", ")}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function slugFromTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  return slug || "feature";
}

export function normalizeDocsWriterOutput(raw: unknown): DocsWriterOutput {
  const record = asRecord(raw) ?? {};
  const glossary = normalizeGlossaryEntries(record.glossary);
  return {
    glossary,
    title: typeof record.title === "string" ? record.title.trim() : "",
    body: typeof record.body === "string" ? record.body : "",
  };
}

export function normalizeGlossaryEntries(value: unknown): GlossaryEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: GlossaryEntry[] = [];
  for (const item of value) {
    const row = asRecord(item);
    if (!row) continue;
    const term = typeof row.term === "string" ? row.term.trim() : "";
    const definition = typeof row.definition === "string" ? row.definition.trim() : "";
    if (!term || !definition) continue;
    const avoid = Array.isArray(row.avoid)
      ? row.avoid.filter((part): part is string => typeof part === "string" && Boolean(part.trim()))
      : undefined;
    entries.push({ term, definition, ...(avoid?.length ? { avoid } : {}) });
  }
  return entries;
}

export async function writeDocsWriterArtifacts(
  worktreePath: string,
  output: DocsWriterOutput,
): Promise<{ glossaryPath: string; prdPath: string }> {
  const glossaryPath = path.join(worktreePath, "GLOSSARY.md");
  let preamble = DEFAULT_GLOSSARY_PREAMBLE;
  try {
    preamble = extractGlossaryPreamble(await readFile(glossaryPath, "utf8"));
  } catch {
    // New glossary file — use the default preamble.
  }
  const existing = await readGlossaryEntries(worktreePath);
  const merged = mergeGlossaryDelta(existing, output.glossary);
  if (merged.length > 0) {
    await writeFile(glossaryPath, formatGlossaryMarkdown(merged, preamble), "utf8");
  }

  const slug = slugFromTitle(output.title || "feature");
  const prdDir = path.join(worktreePath, "docs", "prd");
  await mkdir(prdDir, { recursive: true });
  const prdPath = path.join(prdDir, `${slug}.md`);
  const prdBody = output.body.trim()
    ? `# ${output.title || "Feature"}\n\n${output.body.trim()}\n`
    : `# ${output.title || "Feature"}\n\n`;
  await writeFile(prdPath, prdBody, "utf8");
  return { glossaryPath, prdPath };
}

function briefText(reflectBrief: unknown): string {
  const slim = slimBrief(reflectBrief);
  return typeof slim === "string" ? slim : JSON.stringify(slim);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
