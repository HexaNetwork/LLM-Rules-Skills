import path from "node:path";
import { stat } from "node:fs/promises";
import { packCodegraphExcerpt, shapeCodegraphQuery } from "../../../codegraph.js";
import type {
  ExecutableRunner,
  RepositoryIntelligenceAdapter,
  RepositoryIntelligenceRequest,
} from "../types.js";

export const GITNEXUS_INDEX_METADATA = ".gitnexus/gitnexus.json";

export type GitNexusAdapterSettings = {
  enabled: boolean;
  command: string;
  updateTimeoutMs: number;
  queryTimeoutMs: number;
  maxResults: number;
  stopwords: string[];
  sourceExtensions: string[];
  maxCharacters: number;
};

/**
 * Direct GitNexus CLI adapter. Queries use the absolute workspace path as `--repo`,
 * not a basename/registry alias, so concurrent workspaces and duplicate
 * repository names resolve to the index belonging to this exact workspace.
 */
export class GitNexusAdapter implements RepositoryIntelligenceAdapter {
  readonly descriptor = {
    id: "gitnexus",
    capabilities: ["search", "symbol-context"] as const,
    generatedArtifacts: [".gitnexus/"] as const,
  };

  constructor(
    private readonly paths: { workspaceRoot: string },
    private readonly settings: GitNexusAdapterSettings,
    private readonly runner: ExecutableRunner,
  ) {}

  private get workspaceRoot(): string {
    return this.paths.workspaceRoot;
  }

  async readiness() {
    if (!this.settings.enabled) {
      return { available: false, indexReady: false, generation: "disabled", detail: "disabled" };
    }
    const [version, metadata] = await Promise.all([
      this.runner(this.settings.command, ["--version"], {
        cwd: this.workspaceRoot,
        timeoutMs: this.settings.queryTimeoutMs,
      }),
      stat(this.metadataPath()).catch(() => undefined),
    ]);
    return {
      available: version.exitCode === 0 && !version.timedOut,
      indexReady: Boolean(metadata),
      generation: metadata ? `${metadata.mtimeMs}:${metadata.size}` : "missing",
      ...(version.exitCode !== 0 || version.timedOut
        ? { detail: version.timedOut ? "version-timeout" : "command-unavailable" }
        : !metadata
          ? { detail: "index-missing" }
          : {}),
    };
  }

  prepare() {
    return this.refresh();
  }

  async refresh() {
    const available = await this.runner(this.settings.command, ["--version"], {
      cwd: this.workspaceRoot,
      timeoutMs: this.settings.queryTimeoutMs,
    });
    if (available.exitCode !== 0 || available.timedOut) {
      return {
        available: false,
        indexReady: false,
        generation: "unavailable",
        refreshed: false,
        detail: available.timedOut ? "version-timeout" : "command-unavailable",
      };
    }
    // Pure indexing flags suppress AGENTS/CLAUDE/skill writes and never self-commit.
    const result = await this.runner(
      this.settings.command,
      [
        "analyze",
        this.workspaceRoot,
        "--index-only",
        "--skip-agents-md",
        "--skip-skills",
      ],
      { cwd: this.workspaceRoot, timeoutMs: this.settings.updateTimeoutMs },
    );
    return {
      ...(await this.readiness()),
      refreshed: result.exitCode === 0 && !result.timedOut,
      ...(result.exitCode !== 0 || result.timedOut
        ? { detail: failureDetail(result) }
        : {}),
    };
  }

  async retrieve(request: RepositoryIntelligenceRequest) {
    const symbol = symbolFromPaths(request.pathHints, this.settings.sourceExtensions);
    const shaped = symbol
      ? { query: symbol, usedFallback: false }
      : shapeCodegraphQuery(request.query, request.fallbackQuery, 12, this.settings.stopwords);
    if (!shaped.query) {
      return {
        shapedQuery: "",
        usedFallback: shaped.usedFallback,
        skippedReason: shaped.skippedReason ?? "generic-query",
      };
    }
    const args = symbol
      ? ["context", symbol, "--repo", this.workspaceRoot, "--content"]
      : [
          "query",
          shaped.query,
          "--repo",
          this.workspaceRoot,
          "--limit",
          String(this.settings.maxResults),
          "--content",
        ];
    const result = await this.runner(this.settings.command, args, {
      cwd: this.workspaceRoot,
      timeoutMs: this.settings.queryTimeoutMs,
    });
    const raw = result.stdout.trim();
    if (result.exitCode !== 0 || result.timedOut || !raw) {
      return {
        shapedQuery: shaped.query,
        usedFallback: shaped.usedFallback,
        skippedReason: result.timedOut
          ? "query-timeout"
          : result.exitCode !== 0
            ? "query-failed"
            : "no-matches",
      };
    }
    return {
      artifact: {
        providerId: this.descriptor.id,
        source: "repository:gitnexus",
        title: symbol
          ? "Exact repository relationships (GitNexus)"
          : "Repository relationships (GitNexus)",
        excerpt: packCodegraphExcerpt(
          raw,
          request.maxCharacters ?? this.settings.maxCharacters,
        ),
        score: 0,
        generation: (await this.readiness()).generation,
        metadata: { workspaceIdentity: this.workspaceRoot },
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

  private metadataPath(): string {
    const target = path.resolve(this.workspaceRoot, GITNEXUS_INDEX_METADATA);
    const relative = path.relative(path.resolve(this.workspaceRoot), target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`GitNexus index escapes repository: ${target}`);
    }
    return target;
  }
}

function symbolFromPaths(pathHints: string[] | undefined, sourceExtensions: string[]): string | undefined {
  const allowed = new Set(sourceExtensions.map((extension) => extension.toLocaleLowerCase()));
  for (const filePath of pathHints ?? []) {
    if (!allowed.has(path.extname(filePath).toLocaleLowerCase())) continue;
    const basename = filePath.replaceAll("\\", "/").split("/").pop() ?? "";
    const symbol = basename.replace(/\.[^.]+$/, "");
    if (symbol) return symbol;
  }
  return undefined;
}

function failureDetail(result: { timedOut: boolean; exitCode: number; stdout: string; stderr: string }) {
  if (result.timedOut) return "timed out";
  return (result.stderr || result.stdout || `exit ${result.exitCode}`).trim().slice(0, 1_000);
}
