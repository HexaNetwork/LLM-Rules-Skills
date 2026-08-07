import { execFile } from "node:child_process";
import path from "node:path";
import { access } from "node:fs/promises";
import type { HarnessConfig } from "./config.js";
import type { SearchResult } from "./knowledge.js";

export type RepositorySearchResult = Omit<
  SearchResult,
  "scope" | "projectId" | "visibility"
>;

export const GRAPH_PATH = "graphify-out/graph.json";
const OUTPUT_LIMIT = 1_000_000;
const GRAPHIFY_QUERY_TOKEN_CAP = 12;

/** Boilerplate and filler that seed noisy Graphify matches. */
const GRAPHIFY_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
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
  "change",
  "want",
  "way",
  "ways",
  "implementation",
  "implement",
  "tests",
  "test",
  "testing",
  "architecture",
  "acceptance",
  "security",
  "standards",
  "standard",
  "public",
  "interface",
  "seam",
  "please",
  "need",
  "needs",
  "using",
  "use",
  "used",
  "make",
  "made",
  "add",
  "added",
  "new",
  "also",
  "just",
  "like",
  "about",
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
]);

/**
 * Shape a free-text knowledge query into distinctive Graphify seeds:
 * keep PascalCase / camelCase identifiers, dotted paths, and meaningful nouns.
 */
export function buildGraphifyQuery(raw: string, maxTokens = GRAPHIFY_QUERY_TOKEN_CAP): string {
  const tokens: string[] = [];
  const seen = new Set<string>();
  const pattern = /[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+|[a-z]+(?:[A-Z][a-z0-9]+)+|[A-Za-z][A-Za-z0-9_-]{2,}/g;
  for (const match of raw.matchAll(pattern)) {
    const token = match[0]!;
    const key = token.toLocaleLowerCase();
    if (GRAPHIFY_STOPWORDS.has(key) || seen.has(key)) continue;
    seen.add(key);
    tokens.push(token);
    if (tokens.length >= maxTokens) break;
  }
  return tokens.join(" ");
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

export type GraphifySetupRunner = (
  scriptPath: string,
  repositoryRoot: string,
) => Promise<GraphifyCommandResult>;

export type GraphifyPreparation = {
  enabled: boolean;
  installed: boolean;
  graphReady: boolean;
  setupRan: boolean;
};

export interface RepositoryLookup {
  refresh(): Promise<void>;
  rebuild(): Promise<boolean>;
  search(query: string): Promise<RepositorySearchResult | undefined>;
}

export class GraphifyRepositoryLookup implements RepositoryLookup {
  private readonly graphPath: string;
  private readonly warned = new Set<string>();

  constructor(
    private readonly config: HarnessConfig,
    private readonly runner: GraphifyRunner = runGraphify,
  ) {
    this.graphPath = path.resolve(config.repositoryRoot, GRAPH_PATH);
    assertInside(config.repositoryRoot, this.graphPath);
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
        ["update", this.config.repositoryRoot],
        { cwd: this.config.repositoryRoot, timeoutMs: settings.updateTimeoutMs },
      );
      if (result.exitCode !== 0 || result.timedOut) {
        this.warn(`update failed: ${failureDetail(result)}`);
        return false;
      }
      return true;
    } catch (error) {
      this.warn(`update failed: ${messageOf(error)}`);
      return false;
    }
  }

  async search(query: string): Promise<RepositorySearchResult | undefined> {
    const settings = this.config.knowledge.graphify;
    const tightened = buildGraphifyQuery(query);
    if (!settings.enabled || !tightened) return undefined;
    try {
      await access(this.graphPath);
    } catch {
      this.warn(`lookup skipped because ${GRAPH_PATH} does not exist`);
      return undefined;
    }

    try {
      const result = await this.runner(
        settings.command,
        [
          "query",
          tightened,
          "--budget",
          String(settings.queryBudgetTokens),
          "--graph",
          this.graphPath,
        ],
        { cwd: this.config.repositoryRoot, timeoutMs: settings.queryTimeoutMs },
      );
      const excerpt = result.stdout.trim();
      if (
        result.exitCode !== 0 ||
        result.timedOut ||
        !excerpt ||
        /^No matching nodes found\.?$/im.test(excerpt)
      ) {
        if (result.exitCode !== 0 || result.timedOut) {
          this.warn(`query failed: ${failureDetail(result)}`);
        }
        return undefined;
      }
      return {
        source: `graphify:${GRAPH_PATH}`,
        title: "Repository relationships (Graphify)",
        excerpt,
        score: 1,
      };
    } catch (error) {
      this.warn(`query failed: ${messageOf(error)}`);
      return undefined;
    }
  }

  private warn(detail: string): void {
    if (this.warned.has(detail)) return;
    this.warned.add(detail);
    console.warn(`Graphify ${detail}; continuing with lexical retrieval`);
  }
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
 * A new agent run needs a usable command and a graph for its target project.
 * The setup script is project-local and deliberately editable by the team.
 */
export async function prepareGraphifyForRun(
  config: HarnessConfig,
  runner: GraphifyRunner = runGraphify,
  setupRunner: GraphifySetupRunner = runGraphifySetup,
): Promise<GraphifyPreparation> {
  const settings = config.knowledge.graphify;
  if (!settings.enabled) {
    return { enabled: false, installed: false, graphReady: false, setupRan: false };
  }
  const graphPath = path.resolve(config.repositoryRoot, GRAPH_PATH);
  assertInside(config.repositoryRoot, graphPath);
  const [version, graphReady] = await Promise.all([
    runner(settings.command, ["--version"], {
      cwd: config.repositoryRoot,
      timeoutMs: settings.queryTimeoutMs,
    }),
    exists(graphPath),
  ]);
  if (version.exitCode === 0 && !version.timedOut && graphReady) {
    return { enabled: true, installed: true, graphReady: true, setupRan: false };
  }

  const scriptPath = path.join(
    config.repositoryRoot,
    "agent-harness",
    "scripts",
    process.platform === "win32" ? "setup-graphify.ps1" : "setup-graphify.sh",
  );
  if (!(await exists(scriptPath))) {
    throw new Error(
      `Graphify is required before starting a new run, but ${path.relative(config.repositoryRoot, scriptPath)} is missing. Run \`agent-harness graphify scripts --project .\` first.`,
    );
  }
  const setup = await setupRunner(scriptPath, config.repositoryRoot);
  if (setup.exitCode !== 0 || setup.timedOut) {
    throw new Error(`Graphify setup failed: ${failureDetail(setup)}`);
  }
  const [afterSetup, graphAfterSetup] = await Promise.all([
    runner(settings.command, ["--version"], {
      cwd: config.repositoryRoot,
      timeoutMs: settings.queryTimeoutMs,
    }),
    exists(graphPath),
  ]);
  if (afterSetup.exitCode !== 0 || afterSetup.timedOut || !graphAfterSetup) {
    throw new Error("Graphify setup completed but the graphify command or graphify-out/graph.json is still unavailable.");
  }
  return { enabled: true, installed: true, graphReady: true, setupRan: true };
}

const runGraphifySetup: GraphifySetupRunner = (scriptPath, repositoryRoot) =>
  new Promise((resolve) => {
    const isWindows = process.platform === "win32";
    const executable = isWindows ? "powershell.exe" : "bash";
    const args = isWindows
      ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-ProjectRoot", repositoryRoot]
      : [scriptPath, "--project-root", repositoryRoot];
    execFile(
      executable,
      args,
      {
        cwd: repositoryRoot,
        timeout: 10 * 60 * 1000,
        maxBuffer: OUTPUT_LIMIT,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const commandError = error as (Error & { code?: string | number; killed?: boolean }) | null;
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
