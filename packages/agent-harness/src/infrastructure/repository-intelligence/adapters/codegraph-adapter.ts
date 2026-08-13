import path from "node:path";
import { access, stat } from "node:fs/promises";
import {
  packCodegraphExcerpt,
  shapeCodegraphQuery,
} from "../../../codegraph.js";
import type {
  ExecutableRunner,
  RepositoryIntelligenceAdapter,
  RepositoryIntelligenceRequest,
} from "../types.js";

export const CODEGRAPH_INDEX_DB = ".codegraph/codegraph.db";

export type CodeGraphAdapterSettings = {
  enabled: boolean;
  command: string;
  updateTimeoutMs: number;
  queryTimeoutMs: number;
  maxFiles: number;
  stopwords: string[];
  sourceExtensions: string[];
  maxCharacters: number;
};

export class CodeGraphAdapter implements RepositoryIntelligenceAdapter {
  readonly descriptor = {
    id: "codegraph",
    capabilities: ["search", "symbol-context"] as const,
    generatedArtifacts: [".codegraph/"] as const,
  };

  constructor(
    private readonly paths: { workspaceRoot: string },
    private readonly settings: CodeGraphAdapterSettings,
    private readonly runner: ExecutableRunner,
  ) {}

  private get workspaceRoot(): string {
    return this.paths.workspaceRoot;
  }

  async readiness() {
    if (!this.settings.enabled) {
      return { available: false, indexReady: false, generation: "disabled", detail: "disabled" };
    }
    const [version, index] = await Promise.all([
      this.runner(this.settings.command, ["--version"], {
        cwd: this.workspaceRoot,
        timeoutMs: this.settings.queryTimeoutMs,
      }),
      stat(this.indexPath()).catch(() => undefined),
    ]);
    return {
      available: version.exitCode === 0 && !version.timedOut,
      indexReady: Boolean(index),
      generation: index ? `${index.mtimeMs}:${index.size}` : "missing",
      ...(version.exitCode !== 0 || version.timedOut
        ? { detail: version.timedOut ? "version-timeout" : "command-unavailable" }
        : !index
          ? { detail: "index-missing" }
          : {}),
    };
  }

  async prepare() {
    const ready = await this.readiness();
    if (!ready.available || ready.indexReady) return { ...ready, refreshed: false };
    const result = await this.runner(this.settings.command, ["init", this.workspaceRoot], {
      cwd: this.workspaceRoot,
      timeoutMs: this.settings.updateTimeoutMs,
    });
    if (result.exitCode !== 0 || result.timedOut) {
      return { ...(await this.readiness()), refreshed: false, detail: failureDetail(result) };
    }
    return { ...(await this.readiness()), refreshed: true };
  }

  async refresh() {
    if (!(await this.commandAvailable())) {
      return {
        available: false,
        indexReady: false,
        generation: "unavailable",
        refreshed: false,
        detail: "command-unavailable",
      };
    }
    const exists = await access(this.indexPath()).then(() => true, () => false);
    const args = exists ? ["sync", this.workspaceRoot] : ["init", this.workspaceRoot];
    const result = await this.runner(this.settings.command, args, {
      cwd: this.workspaceRoot,
      timeoutMs: this.settings.updateTimeoutMs,
    });
    return {
      ...(await this.readiness()),
      refreshed: result.exitCode === 0 && !result.timedOut,
      ...(result.exitCode !== 0 || result.timedOut ? { detail: failureDetail(result) } : {}),
    };
  }

  async retrieve(request: RepositoryIntelligenceRequest) {
    const symbols = symbolsFromPaths(
      request.pathHints,
      this.settings.sourceExtensions,
    ).slice(0, 4);
    const shaped = symbols.length > 0
      ? { query: symbols.join(" "), usedFallback: false }
      : shapeCodegraphQuery(request.query, request.fallbackQuery, 12, this.settings.stopwords);
    if (!shaped.query) {
      return {
        shapedQuery: "",
        usedFallback: shaped.usedFallback,
        skippedReason: shaped.skippedReason ?? "generic-query",
      };
    }

    const results = symbols.length > 0
      ? await Promise.all(symbols.map((symbol) =>
          this.runner(
            this.settings.command,
            ["node", symbol, "-p", this.workspaceRoot],
            { cwd: this.workspaceRoot, timeoutMs: this.settings.queryTimeoutMs },
          )
        ))
      : [
          await this.runner(
            this.settings.command,
            [
              "explore",
              shaped.query,
              "-p",
              this.workspaceRoot,
              "--max-files",
              String(this.settings.maxFiles),
            ],
            { cwd: this.workspaceRoot, timeoutMs: this.settings.queryTimeoutMs },
          ),
        ];
    const excerpts = results
      .filter((result) => result.exitCode === 0 && !result.timedOut)
      .map((result) => result.stdout.trim())
      .filter(Boolean);
    const failed = results.some((result) => result.exitCode !== 0);
    const timedOut = results.some((result) => result.timedOut);
    if (excerpts.length === 0) {
      return {
        shapedQuery: shaped.query,
        usedFallback: shaped.usedFallback,
        skippedReason: timedOut
          ? "query-timeout"
          : failed
            ? "query-failed"
            : "no-matches",
      };
    }
    const raw = excerpts.join("\n\n");
    const generation = (await this.readiness()).generation;
    return {
      artifact: {
        providerId: this.descriptor.id,
        source: "repository:codegraph",
        title:
          symbols.length > 0
            ? "Exact repository relationships (CodeGraph)"
            : "Repository relationships (CodeGraph)",
        excerpt: packCodegraphExcerpt(
          raw,
          request.maxCharacters ?? this.settings.maxCharacters,
        ),
        score: 0,
        generation,
      },
      shapedQuery: shaped.query,
      usedFallback: shaped.usedFallback,
    };
  }

  isRelevantPath(filePath: string): boolean {
    const extension = path.extname(filePath).toLocaleLowerCase();
    return this.settings.sourceExtensions.some(
      (candidate) => candidate.toLocaleLowerCase() === extension,
    );
  }

  private indexPath(): string {
    const target = path.resolve(this.workspaceRoot, CODEGRAPH_INDEX_DB);
    assertInside(this.workspaceRoot, target);
    return target;
  }

  private async commandAvailable(): Promise<boolean> {
    const result = await this.runner(this.settings.command, ["--version"], {
      cwd: this.workspaceRoot,
      timeoutMs: this.settings.queryTimeoutMs,
    });
    return result.exitCode === 0 && !result.timedOut;
  }
}

function symbolsFromPaths(pathHints: string[] | undefined, sourceExtensions: string[]): string[] {
  const allowed = new Set(sourceExtensions.map((extension) => extension.toLocaleLowerCase()));
  return [...new Set((pathHints ?? []).flatMap((filePath) => {
    if (!allowed.has(path.extname(filePath).toLocaleLowerCase())) return [];
    const basename = filePath.replaceAll("\\", "/").split("/").pop() ?? "";
    const symbol = basename.replace(/\.[^.]+$/, "");
    return symbol ? [symbol] : [];
  }))];
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`CodeGraph index escapes repository: ${target}`);
  }
}

function failureDetail(result: { timedOut: boolean; exitCode: number; stdout: string; stderr: string }) {
  if (result.timedOut) return "timed out";
  return (result.stderr || result.stdout || `exit ${result.exitCode}`).trim().slice(0, 1_000);
}
