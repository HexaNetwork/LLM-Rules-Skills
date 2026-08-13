import { execFile } from "node:child_process";
import path from "node:path";
import { access, stat } from "node:fs/promises";
import { resolveHarnessPaths, type HarnessPaths } from "./application/paths.js";
import type { HarnessConfig } from "./config/schema.js";
import type { SearchResult } from "./knowledge.js";

export type RepositorySearchResult = Omit<
  SearchResult,
  "scope" | "projectId" | "visibility"
>;

export const GRAPH_PATH = "graphify-out/graph.json";
const OUTPUT_LIMIT = 1_000_000;
const GRAPHIFY_QUERY_TOKEN_CAP = 12;
const HUB_TRAVERSAL_NODE_LIMIT = 1_000;
const MAX_EXPLAIN_SYMBOLS = 4;
const HUB_DEGREE_LIMIT = 100;
const HUB_CONNECTION_LIMIT = 5;

/** Articles, pronouns, auxiliaries, prepositions, and conjunctions only. */
export const ENGLISH_STOPWORDS = [
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "nor",
  "for",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "with",
  "from",
  "into",
  "over",
  "under",
  "after",
  "before",
  "when",
  "where",
  "what",
  "which",
  "how",
  "why",
  "who",
  "this",
  "that",
  "these",
  "those",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "should",
  "could",
  "can",
  "may",
  "might",
  "must",
  "i",
  "we",
  "you",
  "they",
  "it",
  "its",
  "my",
  "our",
  "your",
  "their",
  "not",
  "no",
  "yes",
  "all",
  "any",
  "some",
  "more",
  "most",
  "other",
  "than",
  "then",
  "there",
  "here",
  "out",
  "up",
  "down",
  "only",
  "own",
  "same",
  "so",
  "too",
  "very",
  "also",
  "just",
  "about",
  "between",
  "among",
  "against",
  "without",
  "within",
  "across",
  "through",
  "during",
  "while",
  "until",
  "once",
  "again",
  "further",
  "each",
  "every",
  "both",
  "either",
  "neither",
  "via",
  "per",
] as const;

/** Harness process words that are noise in any project Graphify query. */
export const HARNESS_META_STOPWORDS = [
  "objective",
  "acceptance",
  "criteria",
  "resolution",
  "recommendation",
  "ticket",
  "grill",
  "packet",
] as const;

const MIN_GRAPHIFY_TOKENS = 2;

const SEED_SCORE = 1_000_000;
const QUERY_SCORE = 1_000;
const METHOD_NOISE_PENALTY = 100;

const HEADER_START_RE =
  /^Traversal:.*?\|\s*Start:\s*\[([^\]]*)\]\s*\|\s*(\d+)\s+nodes?\s+found\b/im;
const NODE_LINE_RE = /^NODE\s+(.+?)\s+\[([^\]]*)\]\s*$/;
const START_TOKEN_RE = /['"]([^'"]+)['"]/g;

/**
 * Re-rank Graphify CLI stdout so seed / query hits appear before hub noise,
 * then pack under maxChars. Unparseable dumps pass through unchanged.
 */
export function rankGraphifyExcerpt(
  raw: string,
  shapedQuery: string,
  maxChars: number,
): string {
  const trimmed = raw.trim();
  if (!trimmed || maxChars <= 0) return trimmed;

  const lines = trimmed.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => HEADER_START_RE.test(line));
  const nodes: Array<{ line: string; label: string; src: string; index: number }> = [];
  let truncationNotice: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = NODE_LINE_RE.exec(line);
    if (match) {
      const attrs = match[2] ?? "";
      const srcMatch = /\bsrc=(\S+)/.exec(attrs);
      nodes.push({
        line,
        label: (match[1] ?? "").trim(),
        src: srcMatch?.[1] ?? "",
        index: nodes.length,
      });
      continue;
    }
    if (nodes.length > 0 && line.trim() && i !== headerIndex) {
      // Trailing non-NODE text after the body (e.g. truncation notices).
      truncationNotice = truncationNotice
        ? `${truncationNotice}\n${line}`
        : line;
    }
  }

  if (nodes.length === 0) return trimmed;
  if (headerIndex < 0) return trimmed;

  const headerLine = lines[headerIndex]!;
  const startMatch = HEADER_START_RE.exec(headerLine);
  if (!startMatch) return trimmed;

  const seeds = parseStartTokens(startMatch[1] ?? "");
  const traversalNodeCount = Number(startMatch[2] ?? 0);
  const queryTokens = shapedQuery
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

  const ranked = [...nodes].sort((a, b) => {
    const scoreDiff =
      scoreGraphifyNode(b, seeds, queryTokens) - scoreGraphifyNode(a, seeds, queryTokens);
    if (scoreDiff !== 0) return scoreDiff;
    return a.index - b.index;
  });
  const candidates = traversalNodeCount > HUB_TRAVERSAL_NODE_LIMIT
    ? ranked.filter((node) => scoreGraphifyNode(node, seeds, queryTokens) > 0)
    : ranked;

  const parts: string[] = [];
  let used = 0;
  const pushIfFits = (chunk: string): boolean => {
    const next = used === 0 ? chunk.length : used + 1 + chunk.length;
    if (next > maxChars) return false;
    parts.push(chunk);
    used = next;
    return true;
  };

  if (!pushIfFits(headerLine)) return trimmed.slice(0, maxChars);

  for (const node of candidates) {
    pushIfFits(node.line);
  }

  if (truncationNotice) {
    pushIfFits(truncationNotice);
  }

  return parts.join("\n");
}

function parseStartTokens(rawList: string): string[] {
  const tokens: string[] = [];
  for (const match of rawList.matchAll(START_TOKEN_RE)) {
    const token = match[1]?.trim();
    if (token) tokens.push(token);
  }
  return tokens;
}

function scoreGraphifyNode(
  node: { label: string; src: string },
  seeds: readonly string[],
  queryTokens: readonly string[],
): number {
  let score = 0;
  const labelLower = node.label.toLocaleLowerCase();
  const srcLower = node.src.toLocaleLowerCase();
  const basenameLower = pathBasenameWithoutExt(node.src).toLocaleLowerCase();

  for (const seed of seeds) {
    const seedLower = seed.toLocaleLowerCase();
    if (
      labelLower === seedLower ||
      basenameLower === seedLower ||
      labelLower.includes(seedLower)
    ) {
      score += SEED_SCORE;
      break;
    }
  }

  for (const token of queryTokens) {
    const tokenLower = token.toLocaleLowerCase();
    if (
      labelLower.includes(tokenLower) ||
      srcLower.includes(tokenLower) ||
      basenameLower.includes(tokenLower)
    ) {
      score += QUERY_SCORE;
      break;
    }
  }

  if (node.label.startsWith(".")) {
    score -= METHOD_NOISE_PENALTY;
  }

  return score;
}

function pathBasenameWithoutExt(src: string): string {
  if (!src) return "";
  const base = src.replace(/\\/g, "/").split("/").pop() ?? src;
  return base.replace(/\.[^.]+$/, "");
}

export function graphifyStopwordSet(extra: readonly string[] = []): Set<string> {
  return new Set(
    [...ENGLISH_STOPWORDS, ...HARNESS_META_STOPWORDS, ...extra].map((word) =>
      word.toLocaleLowerCase(),
    ),
  );
}

/**
 * Shape a free-text knowledge query into distinctive Graphify seeds:
 * prefer PascalCase / camelCase identifiers and dotted paths, then nouns.
 */
export function buildGraphifyQuery(
  raw: string,
  maxTokens = GRAPHIFY_QUERY_TOKEN_CAP,
  extraStopwords: readonly string[] = [],
): string {
  const stopwords = graphifyStopwordSet(extraStopwords);
  const distinctive: string[] = [];
  const ordinary: string[] = [];
  const seen = new Set<string>();
  const pattern =
    /[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+|[a-z]+(?:[A-Z][a-z0-9]+)+|[A-Za-z][A-Za-z0-9_-]{2,}/g;
  for (const match of raw.matchAll(pattern)) {
    const token = match[0]!;
    const key = token.toLocaleLowerCase();
    if (stopwords.has(key) || seen.has(key)) continue;
    seen.add(key);
    if (isDistinctiveGraphifyToken(token)) distinctive.push(token);
    else ordinary.push(token);
  }
  return [...distinctive, ...ordinary].slice(0, maxTokens).join(" ");
}

export function shapeGraphifyQuery(
  raw: string,
  fallbackQuery?: string,
  maxTokens = GRAPHIFY_QUERY_TOKEN_CAP,
  extraStopwords: readonly string[] = [],
): { query: string; usedFallback: boolean; skippedReason?: string } {
  const primary = buildGraphifyQuery(raw, maxTokens, extraStopwords);
  if (isUsableGraphifyQuery(primary)) {
    return { query: primary, usedFallback: false };
  }
  const fallback = fallbackQuery?.trim()
    ? buildGraphifyQuery(fallbackQuery, maxTokens, extraStopwords)
    : "";
  if (isUsableGraphifyQuery(fallback)) {
    return { query: fallback, usedFallback: true };
  }
  return {
    query: "",
    usedFallback: Boolean(fallbackQuery?.trim()),
    skippedReason: "generic-query",
  };
}

function isDistinctiveGraphifyToken(token: string): boolean {
  return (
    /[A-Za-z][A-Za-z0-9]*\.[A-Za-z]/.test(token) ||
    /[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+/.test(token) ||
    /[a-z]+(?:[A-Z][a-z0-9]+)+/.test(token) ||
    /_/.test(token) ||
    /-[A-Za-z]/.test(token)
  );
}

function isUsableGraphifyQuery(query: string): boolean {
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  if (tokens.some(isDistinctiveGraphifyToken)) return true;
  return tokens.length >= MIN_GRAPHIFY_TOKENS;
}

export type GraphifyCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type GraphifyRunner = (
  executable: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<GraphifyCommandResult>;

export type GraphifyPreparation = {
  enabled: boolean;
  installed: boolean;
  graphReady: boolean;
  /** True when this call built or refreshed graphify-out/graph.json. */
  setupRan: boolean;
};

export type RepositoryLookupSearchOptions = {
  fallbackQuery?: string;
  /** Concrete packet paths whose file symbols should take precedence over prose. */
  pathHints?: string[];
};

export type RepositoryLookupSearch = {
  result?: RepositorySearchResult;
  shapedQuery: string;
  usedFallback: boolean;
  skippedReason?: string;
};

export interface RepositoryLookup {
  refresh(): Promise<void>;
  rebuild(): Promise<boolean>;
  search(
    query: string,
    options?: RepositoryLookupSearchOptions,
  ): Promise<RepositoryLookupSearch>;
}

export class GraphifyRepositoryLookup implements RepositoryLookup {
  private readonly paths: HarnessPaths;
  private readonly warned = new Set<string>();
  private readonly searchCache = new Map<string, RepositoryLookupSearch>();

  constructor(
    private readonly config: HarnessConfig,
    private readonly runner: GraphifyRunner = runGraphify,
    paths: HarnessPaths = resolveHarnessPaths(config),
  ) {
    this.paths = paths;
  }

  private get workspaceRoot(): string {
    return this.paths.workspaceRoot;
  }

  private get graphPath(): string {
    const resolved = path.resolve(this.workspaceRoot, GRAPH_PATH);
    assertInside(this.workspaceRoot, resolved);
    return resolved;
  }

  async refresh(): Promise<void> {
    const settings = this.config.knowledge.graphify;
    if (!settings.enabled || !settings.updateOnRefresh) return;
    await this.update();
  }

  /** Rebuild after a verified source commit, regardless of updateOnRefresh. */
  async rebuild(): Promise<boolean> {
    if (!this.config.knowledge.graphify.enabled) return false;
    return this.update();
  }

  private async update(): Promise<boolean> {
    const settings = this.config.knowledge.graphify;
    try {
      const result = await this.runner(
        settings.command,
        ["update", this.workspaceRoot],
        { cwd: this.workspaceRoot, timeoutMs: settings.updateTimeoutMs },
      );
      if (result.exitCode !== 0 || result.timedOut) {
        this.warn(`update failed: ${failureDetail(result)}`);
        return false;
      }
      this.searchCache.clear();
      return true;
    } catch (error) {
      this.warn(`update failed: ${messageOf(error)}`);
      return false;
    }
  }

  async search(
    query: string,
    options: RepositoryLookupSearchOptions = {},
  ): Promise<RepositoryLookupSearch> {
    const settings = this.config.knowledge.graphify;
    if (!settings.enabled) {
      return {
        shapedQuery: "",
        usedFallback: false,
        skippedReason: "disabled",
      };
    }
    const exactSymbols = graphifySymbolsFromPaths(
      options.pathHints,
      settings.sourceExtensions,
    ).slice(0, MAX_EXPLAIN_SYMBOLS);
    const shaped = exactSymbols.length > 0
      ? { query: exactSymbols.join(" "), usedFallback: false }
      : shapeGraphifyQuery(
          query,
          options.fallbackQuery,
          GRAPHIFY_QUERY_TOKEN_CAP,
          settings.stopwords,
        );
    if (!shaped.query) {
      return {
        shapedQuery: "",
        usedFallback: shaped.usedFallback,
        skippedReason: shaped.skippedReason ?? "generic-query",
      };
    }
    let graphMtime = 0;
    try {
      graphMtime = (await stat(this.graphPath)).mtimeMs;
    } catch {
      this.warn(`lookup skipped because ${GRAPH_PATH} does not exist`);
      return {
        shapedQuery: shaped.query,
        usedFallback: shaped.usedFallback,
        skippedReason: "graph-missing",
      };
    }

    const cacheKey = `${exactSymbols.length > 0 ? "explain" : "query"}:${shaped.query}\0${graphMtime}`;
    const cached = this.searchCache.get(cacheKey);
    if (cached) return cloneRepositoryLookupSearch(cached);

    if (exactSymbols.length > 0) {
      const explained = await this.explainSymbols(exactSymbols);
      this.searchCache.set(cacheKey, explained);
      return cloneRepositoryLookupSearch(explained);
    }

    try {
      const result = await this.runner(
        settings.command,
        [
          "query",
          shaped.query,
          "--budget",
          String(settings.queryBudgetTokens),
          "--graph",
          this.graphPath,
        ],
        { cwd: this.workspaceRoot, timeoutMs: settings.queryTimeoutMs },
      );
      const rawExcerpt = result.stdout.trim();
      if (
        result.exitCode !== 0 ||
        result.timedOut ||
        !rawExcerpt ||
        /^No matching nodes found\.?$/im.test(rawExcerpt)
      ) {
        if (result.exitCode !== 0 || result.timedOut) {
          this.warn(`query failed: ${failureDetail(result)}`);
        }
        const miss: RepositoryLookupSearch = {
          shapedQuery: shaped.query,
          usedFallback: shaped.usedFallback,
          skippedReason:
            result.exitCode !== 0 || result.timedOut ? "query-failed" : "no-matches",
        };
        this.searchCache.set(cacheKey, miss);
        return cloneRepositoryLookupSearch(miss);
      }
      const excerpt = rankGraphifyExcerpt(
        rawExcerpt,
        shaped.query,
        this.config.workflow.graphifyCharacters,
      );
      const hit: RepositoryLookupSearch = {
        result: {
          source: `graphify:${GRAPH_PATH}`,
          title: "Repository relationships (Graphify)",
          excerpt,
          // Structural context is prepended; score is not comparable to doc RRF/TF-IDF.
          score: 0,
        },
        shapedQuery: shaped.query,
        usedFallback: shaped.usedFallback,
      };
      this.searchCache.set(cacheKey, hit);
      return cloneRepositoryLookupSearch(hit);
    } catch (error) {
      this.warn(`query failed: ${messageOf(error)}`);
      return {
        shapedQuery: shaped.query,
        usedFallback: shaped.usedFallback,
        skippedReason: "query-failed",
      };
    }
  }

  private async explainSymbols(symbols: string[]): Promise<RepositoryLookupSearch> {
    const settings = this.config.knowledge.graphify;
    const results = await Promise.all(
      symbols.map(async (symbol) => {
        try {
          const result = await this.runner(
            settings.command,
            ["explain", symbol, "--graph", this.graphPath],
            { cwd: this.workspaceRoot, timeoutMs: settings.queryTimeoutMs },
          );
          const text = result.stdout.trim();
          return result.exitCode === 0 && !result.timedOut && /^Node:\s+/m.test(text)
            ? text
            : undefined;
        } catch (error) {
          this.warn(`explain ${symbol} failed: ${messageOf(error)}`);
          return undefined;
        }
      }),
    );
    const excerpts = results.filter((result): result is string => Boolean(result));
    const shapedQuery = symbols.join(" ");
    if (excerpts.length === 0) {
      return {
        shapedQuery,
        usedFallback: false,
        skippedReason: "no-matches",
      };
    }
    return {
      result: {
        source: `graphify:${GRAPH_PATH}`,
        title: "Exact repository relationships (Graphify)",
        excerpt: packGraphifyExplains(excerpts, this.config.workflow.graphifyCharacters),
        score: 0,
      },
      shapedQuery,
      usedFallback: false,
    };
  }

  private warn(detail: string): void {
    if (this.warned.has(detail)) return;
    this.warned.add(detail);
    console.warn(`Graphify ${detail}; continuing with lexical retrieval`);
  }
}

/** Exact code symbols from packet paths; non-source assets are not useful graph seeds. */
function graphifySymbolsFromPaths(
  pathHints: string[] | undefined,
  sourceExtensions: string[],
): string[] {
  const allowed = new Set(sourceExtensions.map((extension) => extension.toLocaleLowerCase()));
  return [...new Set((pathHints ?? []).flatMap((filePath) => {
    const extension = path.extname(filePath).toLocaleLowerCase();
    if (!allowed.has(extension)) return [];
    const basename = filePath.replaceAll("\\", "/").split("/").pop() ?? "";
    const symbol = basename.replace(/\.[^.]+$/, "");
    return symbol ? [symbol] : [];
  }))];
}

/** Keep focused explains intact and bound high-degree hubs to a few representative edges. */
function packGraphifyExplains(excerpts: string[], maxChars: number): string {
  const compacted = excerpts.map((excerpt) => compactGraphifyExplain(excerpt));
  const parts: string[] = [];
  let used = 0;
  for (const excerpt of compacted) {
    const remaining = maxChars - used - (parts.length > 0 ? 2 : 0);
    if (remaining <= 0) break;
    const next = excerpt.length <= remaining ? excerpt : excerpt.slice(0, remaining);
    parts.push(next);
    used += next.length + (parts.length > 1 ? 2 : 0);
  }
  return parts.join("\n\n");
}

function compactGraphifyExplain(excerpt: string): string {
  const degree = Number(/^\s*Degree:\s*(\d+)\s*$/im.exec(excerpt)?.[1] ?? 0);
  if (degree <= HUB_DEGREE_LIMIT) return excerpt.trim();
  const lines = excerpt.trim().split(/\r?\n/);
  const connectionsIndex = lines.findIndex((line) => /^Connections\s*\(/.test(line));
  if (connectionsIndex < 0) return excerpt.trim();
  return [
    ...lines.slice(0, connectionsIndex + 1),
    ...lines.slice(connectionsIndex + 1, connectionsIndex + 1 + HUB_CONNECTION_LIMIT),
    `  ... high-degree hub (${degree}); remaining connections omitted`,
  ].join("\n");
}

function cloneRepositoryLookupSearch(value: RepositoryLookupSearch): RepositoryLookupSearch {
  return {
    ...value,
    result: value.result ? { ...value.result } : undefined,
  };
}

export const runGraphify: GraphifyRunner = (executable, args, options) =>
  new Promise((resolve) => {
    execFile(
      executable,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: OUTPUT_LIMIT,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const commandError = error as (Error & {
          code?: string | number;
          killed?: boolean;
        }) | null;
        resolve({
          exitCode:
            commandError == null
              ? 0
              : typeof commandError.code === "number"
                ? commandError.code
                : 1,
          stdout,
          stderr: stderr || commandError?.message || "",
          timedOut: commandError?.killed === true,
        });
      },
    );
  });

/**
 * A new agent run needs a usable `graphify` command and graphify-out/graph.json.
 * Install Graphify yourself (`uv tool install graphifyy`); the harness only builds
 * the graph when the command is already available.
 */
export async function prepareGraphifyForRun(
  config: HarnessConfig,
  runner: GraphifyRunner = runGraphify,
  paths: HarnessPaths = resolveHarnessPaths(config),
): Promise<GraphifyPreparation> {
  const settings = config.knowledge.graphify;
  if (!settings.enabled) {
    return { enabled: false, installed: false, graphReady: false, setupRan: false };
  }
  const workspaceRoot = paths.workspaceRoot;
  const graphPath = path.resolve(workspaceRoot, GRAPH_PATH);
  assertInside(workspaceRoot, graphPath);
  const [version, graphReady] = await Promise.all([
    runner(settings.command, ["--version"], {
      cwd: workspaceRoot,
      timeoutMs: settings.queryTimeoutMs,
    }),
    exists(graphPath),
  ]);
  if (version.exitCode === 0 && !version.timedOut && graphReady) {
    return { enabled: true, installed: true, graphReady: true, setupRan: false };
  }
  if (version.exitCode !== 0 || version.timedOut) {
    throw new Error(
      `Graphify is enabled but \`${settings.command}\` is unavailable. Install it with \`uv tool install graphifyy\` (or pipx), then retry.`,
    );
  }

  const update = await runner(settings.command, ["update", workspaceRoot], {
    cwd: workspaceRoot,
    timeoutMs: settings.updateTimeoutMs,
  });
  if (update.exitCode !== 0 || update.timedOut) {
    throw new Error(`Graphify graph update failed: ${failureDetail(update)}`);
  }
  if (!(await exists(graphPath))) {
    throw new Error(
      `Graphify update completed but ${GRAPH_PATH} is still missing under ${workspaceRoot}.`,
    );
  }
  return { enabled: true, installed: true, graphReady: true, setupRan: true };
}

function failureDetail(result: GraphifyCommandResult): string {
  if (result.timedOut) return "timed out";
  return (result.stderr || result.stdout || `exit ${result.exitCode}`).trim().slice(0, 1_000);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Graphify graph escapes repository: ${target}`);
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
