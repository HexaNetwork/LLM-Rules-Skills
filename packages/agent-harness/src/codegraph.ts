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

export const INDEX_DIR = ".codegraph";
export const INDEX_DB = ".codegraph/codegraph.db";
export const INDEX_SOURCE = "codegraph:.codegraph";
const OUTPUT_LIMIT = 1_000_000;
const QUERY_TOKEN_CAP = 12;
const MAX_PATH_HINT_SYMBOLS = 4;

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

/** Harness process words that are noise in any project repository query. */
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

const MIN_QUERY_TOKENS = 2;

export function codegraphStopwordSet(extra: readonly string[] = []): Set<string> {
  return new Set(
    [...ENGLISH_STOPWORDS, ...HARNESS_META_STOPWORDS, ...extra].map((word) =>
      word.toLocaleLowerCase(),
    ),
  );
}

/**
 * Shape a free-text knowledge query into distinctive CodeGraph seeds:
 * prefer PascalCase / camelCase identifiers and dotted paths, then nouns.
 */
export function buildCodegraphQuery(
  raw: string,
  maxTokens = QUERY_TOKEN_CAP,
  extraStopwords: readonly string[] = [],
): string {
  const stopwords = codegraphStopwordSet(extraStopwords);
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
    if (isDistinctiveToken(token)) distinctive.push(token);
    else ordinary.push(token);
  }
  return [...distinctive, ...ordinary].slice(0, maxTokens).join(" ");
}

export function shapeCodegraphQuery(
  raw: string,
  fallbackQuery?: string,
  maxTokens = QUERY_TOKEN_CAP,
  extraStopwords: readonly string[] = [],
): { query: string; usedFallback: boolean; skippedReason?: string } {
  const primary = buildCodegraphQuery(raw, maxTokens, extraStopwords);
  if (isUsableQuery(primary)) {
    return { query: primary, usedFallback: false };
  }
  const fallback = fallbackQuery?.trim()
    ? buildCodegraphQuery(fallbackQuery, maxTokens, extraStopwords)
    : "";
  if (isUsableQuery(fallback)) {
    return { query: fallback, usedFallback: true };
  }
  return {
    query: "",
    usedFallback: Boolean(fallbackQuery?.trim()),
    skippedReason: "generic-query",
  };
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
  return buildCodegraphQuery(text, 8);
}

function isDistinctiveToken(token: string): boolean {
  return (
    /[A-Za-z][A-Za-z0-9]*\.[A-Za-z]/.test(token) ||
    /[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+/.test(token) ||
    /[a-z]+(?:[A-Z][a-z0-9]+)+/.test(token) ||
    /_/.test(token) ||
    /-[A-Za-z]/.test(token)
  );
}

function isUsableQuery(query: string): boolean {
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  if (tokens.some(isDistinctiveToken)) return true;
  return tokens.length >= MIN_QUERY_TOKENS;
}

/** Pack CLI stdout under maxChars; unparseable dumps pass through until the cap. */
export function packCodegraphExcerpt(raw: string, maxChars: number): string {
  const trimmed = raw.trim();
  if (!trimmed || maxChars <= 0) return trimmed;
  if (trimmed.length <= maxChars) return trimmed;
  const sliced = trimmed.slice(0, maxChars);
  const lastBreak = Math.max(sliced.lastIndexOf("\n"), sliced.lastIndexOf("\r"));
  if (lastBreak >= Math.floor(maxChars * 0.5)) return sliced.slice(0, lastBreak);
  return sliced;
}

export type CodegraphCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type CodegraphRunner = (
  executable: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<CodegraphCommandResult>;

export type CodegraphPreparation = {
  enabled: boolean;
  installed: boolean;
  graphReady: boolean;
  /** True when this call created or refreshed `.codegraph/`. */
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

export class CodegraphRepositoryLookup implements RepositoryLookup {
  private readonly paths: HarnessPaths;
  private readonly warned = new Set<string>();
  private readonly searchCache = new Map<string, RepositoryLookupSearch>();

  constructor(
    private readonly config: HarnessConfig,
    private readonly runner: CodegraphRunner = runCodegraph,
    paths: HarnessPaths = resolveHarnessPaths(config),
  ) {
    this.paths = paths;
  }

  private get workspaceRoot(): string {
    return this.paths.workspaceRoot;
  }

  private get indexPath(): string {
    const resolved = path.resolve(this.workspaceRoot, INDEX_DB);
    assertInside(this.workspaceRoot, resolved);
    return resolved;
  }

  async refresh(): Promise<void> {
    const settings = this.config.knowledge.codegraph;
    if (!settings.enabled || !settings.updateOnRefresh) return;
    await this.update();
  }

  /** Rebuild after a verified source commit, regardless of updateOnRefresh. */
  async rebuild(): Promise<boolean> {
    if (!this.config.knowledge.codegraph.enabled) return false;
    return this.update();
  }

  private async update(): Promise<boolean> {
    const settings = this.config.knowledge.codegraph;
    try {
      const result = await this.runner(
        settings.command,
        ["sync", this.workspaceRoot],
        { cwd: this.workspaceRoot, timeoutMs: settings.updateTimeoutMs },
      );
      if (result.exitCode !== 0 || result.timedOut) {
        this.warn(`sync failed: ${failureDetail(result)}`);
        return false;
      }
      this.searchCache.clear();
      return true;
    } catch (error) {
      this.warn(`sync failed: ${messageOf(error)}`);
      return false;
    }
  }

  async search(
    query: string,
    options: RepositoryLookupSearchOptions = {},
  ): Promise<RepositoryLookupSearch> {
    const settings = this.config.knowledge.codegraph;
    if (!settings.enabled) {
      return {
        shapedQuery: "",
        usedFallback: false,
        skippedReason: "disabled",
      };
    }
    const exactSymbols = symbolsFromPaths(
      options.pathHints,
      settings.sourceExtensions,
    ).slice(0, MAX_PATH_HINT_SYMBOLS);
    const shaped = exactSymbols.length > 0
      ? { query: exactSymbols.join(" "), usedFallback: false }
      : shapeCodegraphQuery(
          query,
          options.fallbackQuery,
          QUERY_TOKEN_CAP,
          settings.stopwords,
        );
    if (!shaped.query) {
      return {
        shapedQuery: "",
        usedFallback: shaped.usedFallback,
        skippedReason: shaped.skippedReason ?? "generic-query",
      };
    }
    let indexMtime = 0;
    try {
      indexMtime = (await stat(this.indexPath)).mtimeMs;
    } catch {
      this.warn(`lookup skipped because ${INDEX_DB} does not exist`);
      return {
        shapedQuery: shaped.query,
        usedFallback: shaped.usedFallback,
        skippedReason: "index-missing",
      };
    }

    const cacheKey = `${exactSymbols.length > 0 ? "node" : "explore"}:${shaped.query}\0${indexMtime}`;
    const cached = this.searchCache.get(cacheKey);
    if (cached) return cloneRepositoryLookupSearch(cached);

    if (exactSymbols.length > 0) {
      const explained = await this.lookupSymbols(exactSymbols);
      this.searchCache.set(cacheKey, explained);
      return cloneRepositoryLookupSearch(explained);
    }

    try {
      const result = await this.runner(
        settings.command,
        [
          "explore",
          shaped.query,
          "-p",
          this.workspaceRoot,
          "--max-files",
          String(settings.maxFiles),
        ],
        { cwd: this.workspaceRoot, timeoutMs: settings.queryTimeoutMs },
      );
      const rawExcerpt = result.stdout.trim();
      if (result.exitCode !== 0 || result.timedOut || !rawExcerpt) {
        if (result.exitCode !== 0 || result.timedOut) {
          this.warn(`explore failed: ${failureDetail(result)}`);
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
      const excerpt = packCodegraphExcerpt(
        rawExcerpt,
        this.config.workflow.codegraphCharacters,
      );
      const hit: RepositoryLookupSearch = {
        result: {
          source: INDEX_SOURCE,
          title: "Repository relationships (CodeGraph)",
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
      this.warn(`explore failed: ${messageOf(error)}`);
      return {
        shapedQuery: shaped.query,
        usedFallback: shaped.usedFallback,
        skippedReason: "query-failed",
      };
    }
  }

  private async lookupSymbols(symbols: string[]): Promise<RepositoryLookupSearch> {
    const settings = this.config.knowledge.codegraph;
    const results = await Promise.all(
      symbols.map(async (symbol) => {
        try {
          const result = await this.runner(
            settings.command,
            ["node", symbol, "-p", this.workspaceRoot],
            { cwd: this.workspaceRoot, timeoutMs: settings.queryTimeoutMs },
          );
          const text = result.stdout.trim();
          return result.exitCode === 0 && !result.timedOut && text ? text : undefined;
        } catch (error) {
          this.warn(`node ${symbol} failed: ${messageOf(error)}`);
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
        source: INDEX_SOURCE,
        title: "Exact repository relationships (CodeGraph)",
        excerpt: packCodegraphExcerpt(
          excerpts.join("\n\n"),
          this.config.workflow.codegraphCharacters,
        ),
        score: 0,
      },
      shapedQuery,
      usedFallback: false,
    };
  }

  private warn(detail: string): void {
    if (this.warned.has(detail)) return;
    this.warned.add(detail);
    console.warn(`CodeGraph ${detail}; continuing with lexical retrieval`);
  }
}

/** Exact code symbols from packet paths; non-source assets are not useful graph seeds. */
function symbolsFromPaths(
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

function cloneRepositoryLookupSearch(value: RepositoryLookupSearch): RepositoryLookupSearch {
  return {
    ...value,
    result: value.result ? { ...value.result } : undefined,
  };
}

export const runCodegraph: CodegraphRunner = (executable, args, options) =>
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
 * A new agent run needs a usable `codegraph` command and `.codegraph/` index.
 * Install CodeGraph yourself (`npm install -g @colbymchenry/codegraph`); the harness
 * only builds the index when the command is already available.
 */
export async function prepareCodegraphForRun(
  config: HarnessConfig,
  runner: CodegraphRunner = runCodegraph,
  paths: HarnessPaths = resolveHarnessPaths(config),
): Promise<CodegraphPreparation> {
  const settings = config.knowledge.codegraph;
  if (!settings.enabled) {
    return { enabled: false, installed: false, graphReady: false, setupRan: false };
  }
  const workspaceRoot = paths.workspaceRoot;
  const indexPath = path.resolve(workspaceRoot, INDEX_DB);
  assertInside(workspaceRoot, indexPath);
  const [version, indexReady] = await Promise.all([
    runner(settings.command, ["--version"], {
      cwd: workspaceRoot,
      timeoutMs: settings.queryTimeoutMs,
    }),
    exists(indexPath),
  ]);
  if (version.exitCode === 0 && !version.timedOut && indexReady) {
    return { enabled: true, installed: true, graphReady: true, setupRan: false };
  }
  if (version.exitCode !== 0 || version.timedOut) {
    throw new Error(
      `CodeGraph is enabled but \`${settings.command}\` is unavailable. Install it with \`npm install -g @colbymchenry/codegraph\`, then retry.`,
    );
  }

  const init = await runner(settings.command, ["init", workspaceRoot], {
    cwd: workspaceRoot,
    timeoutMs: settings.updateTimeoutMs,
  });
  if (init.exitCode !== 0 || init.timedOut) {
    throw new Error(`CodeGraph index init failed: ${failureDetail(init)}`);
  }
  if (!(await exists(indexPath))) {
    throw new Error(
      `CodeGraph init completed but ${INDEX_DB} is still missing under ${workspaceRoot}.`,
    );
  }
  return { enabled: true, installed: true, graphReady: true, setupRan: true };
}

function failureDetail(result: CodegraphCommandResult): string {
  if (result.timedOut) return "timed out";
  return (result.stderr || result.stdout || `exit ${result.exitCode}`).trim().slice(0, 1_000);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`CodeGraph index escapes repository: ${target}`);
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
