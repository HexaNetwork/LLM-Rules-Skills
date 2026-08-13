import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  ENGLISH_STOPWORDS,
  CodegraphRepositoryLookup,
  HARNESS_META_STOPWORDS,
  INDEX_DB,
  INDEX_SOURCE,
  buildCodegraphQuery,
  packCodegraphExcerpt,
  shapeCodegraphQuery,
  prepareCodegraphForRun,
  type CodegraphCommandResult,
  type CodegraphRunner,
} from "../../src/codegraph.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

describe("codegraph stopword lists", () => {
  it("keeps built-in lists disjoint and free of duplicates", () => {
    expect(new Set(ENGLISH_STOPWORDS).size).toBe(ENGLISH_STOPWORDS.length);
    expect(new Set(HARNESS_META_STOPWORDS).size).toBe(HARNESS_META_STOPWORDS.length);
    const overlap = ENGLISH_STOPWORDS.filter((word) =>
      (HARNESS_META_STOPWORDS as readonly string[]).includes(word),
    );
    expect(overlap).toEqual([]);
  });
});

describe("buildCodegraphQuery", () => {
  it("retains code-domain and game-domain tokens that matter for structural search", () => {
    const query = buildCodegraphQuery("player inventory SettlementWindow");
    expect(query).toContain("SettlementWindow");
    expect(query.toLowerCase()).toContain("player");
    expect(query.toLowerCase()).toContain("inventory");
  });

  it("drops English stopwords and harness meta tokens", () => {
    const query = buildCodegraphQuery(
      "the objective acceptance criteria resolution recommendation ticket grill packet BuildableCapitol",
    );
    expect(query).toContain("BuildableCapitol");
    expect(query.toLowerCase()).not.toContain("objective");
    expect(query.toLowerCase()).not.toContain("acceptance");
    expect(query.toLowerCase()).not.toContain("the");
  });

  it("shapes pure English stopwords to an empty query", () => {
    expect(buildCodegraphQuery("the and or for to of in on at by with")).toBe("");
  });

  it("honours project-configured stopwords", () => {
    const query = buildCodegraphQuery("SettlementWindow ledger padding", 12, ["ledger"]);
    expect(query).toContain("SettlementWindow");
    expect(query.toLowerCase()).not.toContain("ledger");
  });

  it("prefers PascalCase identifiers ahead of ordinary nouns", () => {
    const query = buildCodegraphQuery("naming SettlementWindow for refunds SettlementWindow ledger");
    const tokens = query.split(/\s+/);
    expect(tokens[0]).toBe("SettlementWindow");
  });
});

describe("shapeCodegraphQuery", () => {
  it("falls back to a domain seed when the primary query is only harness meta-language", () => {
    const shaped = shapeCodegraphQuery(
      "objective acceptance criteria resolution recommendation",
      "QuietGreetingBanner SettlementWindow",
    );
    expect(shaped.usedFallback).toBe(true);
    expect(shaped.query).toContain("QuietGreetingBanner");
    expect(shaped.skippedReason).toBeUndefined();
  });

  it("skips CodeGraph when primary and fallback stay generic", () => {
    const shaped = shapeCodegraphQuery(
      "the objective acceptance criteria",
      "recommendation ticket grill packet",
    );
    expect(shaped.query).toBe("");
    expect(shaped.skippedReason).toBe("generic-query");
  });
});

describe("packCodegraphExcerpt", () => {
  it("passes through stdout that already fits the character budget", () => {
    const text = "LocalKnowledgeBase search\nknowledge.ts";
    expect(packCodegraphExcerpt(text, 3_000)).toBe(text);
  });

  it("truncates oversized stdout at a line boundary when possible", () => {
    const text = `${"a".repeat(80)}\n${"b".repeat(80)}\n${"c".repeat(80)}`;
    const packed = packCodegraphExcerpt(text, 100);
    expect(packed.length).toBeLessThanOrEqual(100);
    expect(packed).toContain("a".repeat(80));
    expect(packed).not.toContain("c".repeat(80));
  });
});

describe("CodegraphRepositoryLookup", () => {
  it("builds the index with codegraph init when the command exists but the index is missing", async () => {
    const root = await fixtureRoot();
    const indexPath = path.join(root, ...INDEX_DB.split("/"));
    const runner = vi.fn<CodegraphRunner>(async (_executable, args) => {
      if (args[0] === "--version") return result("1.5.0\n");
      if (args[0] === "init") {
        await mkdir(path.dirname(indexPath), { recursive: true });
        await writeFile(indexPath, "index\n", "utf8");
        return result("Indexed\n");
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected", timedOut: false };
    });
    const config = enabledConfig(root);

    await expect(prepareCodegraphForRun(config, runner)).resolves.toMatchObject({
      enabled: true,
      graphReady: true,
      setupRan: true,
    });
    expect(runner).toHaveBeenCalledWith(
      "codegraph",
      ["init", root],
      expect.objectContaining({ cwd: root }),
    );

    await expect(prepareCodegraphForRun(config, runner)).resolves.toMatchObject({
      setupRan: false,
    });
  });

  it("fails clearly when CodeGraph is enabled but not installed", async () => {
    const root = await fixtureRoot();
    const runner = vi.fn<CodegraphRunner>().mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "not found",
      timedOut: false,
    });
    const config = enabledConfig(root);

    await expect(prepareCodegraphForRun(config, runner)).rejects.toThrow(
      /npm install -g @colbymchenry\/codegraph/i,
    );
  });

  it("syncs and explores the repository graph with argument-safe process calls", async () => {
    const root = await fixtureRoot();
    await writeIndex(root);
    const calls: Array<{ executable: string; args: string[]; timeoutMs: number }> = [];
    const runner: CodegraphRunner = async (executable, args, options) => {
      calls.push({ executable, args, timeoutMs: options.timeoutMs });
      return result(
        args[0] === "explore"
          ? "LocalKnowledgeBase search\npackages/agent-harness/src/knowledge.ts\n"
          : "Synced\n",
      );
    };
    const config = fixtureConfig(root, {
      knowledge: {
        sources: ["README.md", "docs"],
        chunkCharacters: 400,
        codegraph: {
          enabled: true,
          command: "codegraph-custom",
          updateOnRefresh: true,
          updateTimeoutMs: 90_000,
          queryTimeoutMs: 7_000,
          maxFiles: 8,
          roles: ["implementer"],
          stopwords: [],
        },
      },
    });
    const lookup = new CodegraphRepositoryLookup(config, runner);

    await lookup.refresh();
    const found = await lookup.search("Where is knowledge loaded?");

    expect(calls[0]).toEqual({
      executable: "codegraph-custom",
      args: ["sync", root],
      timeoutMs: 90_000,
    });
    expect(calls[1]).toEqual({
      executable: "codegraph-custom",
      args: ["explore", "knowledge loaded", "-p", root, "--max-files", "8"],
      timeoutMs: 7_000,
    });
    expect(found.result).toMatchObject({
      source: INDEX_SOURCE,
      title: "Repository relationships (CodeGraph)",
      score: 0,
    });
    expect(found.result?.excerpt).toContain("LocalKnowledgeBase");
    expect(found.shapedQuery).toBe("knowledge loaded");
  });

  it("returns no context when CodeGraph explore produces empty stdout", async () => {
    const root = await fixtureRoot();
    await writeIndex(root);
    const runner = vi.fn<CodegraphRunner>().mockResolvedValue(result("\n"));
    const config = enabledConfig(root);

    const outcome = await new CodegraphRepositoryLookup(config, runner).search("unknown topic");
    expect(outcome.result).toBeUndefined();
    expect(outcome.skippedReason).toBe("no-matches");
    expect(outcome.shapedQuery).toBe("unknown topic");
  });

  it("looks up concrete source symbols instead of running a broad prose explore", async () => {
    const root = await fixtureRoot();
    await writeIndex(root);
    const runner = vi.fn<CodegraphRunner>().mockResolvedValue(
      result([
        "BuildableAreaValidation",
        "  Source: src/construction/BuildableAreaValidation.java",
        "  --> ConstructionStep",
      ].join("\n")),
    );
    const config = enabledConfig(root);

    const outcome = await new CodegraphRepositoryLookup(config, runner).search(
      "Resident builds a Structure in town culture",
      {
        pathHints: [
          "src/construction/BuildableAreaValidation.java",
          "src/resources/default_lang.yml",
        ],
      },
    );

    expect(outcome.shapedQuery).toBe("BuildableAreaValidation");
    expect(runner).toHaveBeenCalledWith(
      expect.any(String),
      ["node", "BuildableAreaValidation", "-p", root],
      expect.any(Object),
    );
    expect(runner).toHaveBeenCalledTimes(1);
    expect(outcome.result?.title).toBe("Exact repository relationships (CodeGraph)");
    expect(outcome.result?.excerpt).toContain("ConstructionStep");
  });

  it("skips the CodeGraph CLI when shaped seeds stay generic", async () => {
    const root = await fixtureRoot();
    await writeIndex(root);
    const runner = vi.fn<CodegraphRunner>().mockResolvedValue(result("should not run\n"));
    const config = enabledConfig(root);

    const outcome = await new CodegraphRepositoryLookup(config, runner).search(
      "the objective acceptance criteria",
      { fallbackQuery: "recommendation ticket grill packet" },
    );

    expect(outcome.result).toBeUndefined();
    expect(outcome.skippedReason).toBe("generic-query");
    expect(runner).not.toHaveBeenCalled();
  });

  it("memoises identical shaped queries against the same index mtime", async () => {
    const root = await fixtureRoot();
    await writeIndex(root);
    const runner = vi.fn<CodegraphRunner>().mockResolvedValue(
      result("LocalKnowledgeBase search\n"),
    );
    const config = enabledConfig(root);
    const lookup = new CodegraphRepositoryLookup(config, runner);

    const first = await lookup.search("SettlementWindow refunds");
    const second = await lookup.search("SettlementWindow refunds");
    expect(runner).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second.result).not.toBe(first.result);
  });

  it("stores a truncated excerpt when CLI stdout exceeds the character budget", async () => {
    const root = await fixtureRoot();
    await writeIndex(root);
    const dump = `${"NODE Seed\n".repeat(200)}`;
    const runner = vi.fn<CodegraphRunner>().mockResolvedValue(result(dump));
    const config = fixtureConfig(root, {
      knowledge: {
        ...fixtureConfig(root).knowledge,
        codegraph: { ...fixtureConfig(root).knowledge.codegraph, enabled: true },
      },
      workflow: {
        ...fixtureConfig(root).workflow,
        codegraphCharacters: 80,
      },
    });

    const outcome = await new CodegraphRepositoryLookup(config, runner).search(
      "Point2D TownChunkValidation CultureZone placement",
    );

    const excerpt = outcome.result?.excerpt ?? "";
    expect(excerpt.length).toBeLessThanOrEqual(80);
    expect(excerpt).toContain("NODE Seed");
  });
});

function enabledConfig(root: string) {
  return fixtureConfig(root, {
    knowledge: {
      ...fixtureConfig(root).knowledge,
      codegraph: { ...fixtureConfig(root).knowledge.codegraph, enabled: true },
    },
  });
}

async function writeIndex(root: string): Promise<string> {
  const indexPath = path.join(root, ...INDEX_DB.split("/"));
  await mkdir(path.dirname(indexPath), { recursive: true });
  await writeFile(indexPath, "index\n", "utf8");
  return indexPath;
}

function result(stdout: string): CodegraphCommandResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}
