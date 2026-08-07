import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  ENGLISH_STOPWORDS,
  GraphifyRepositoryLookup,
  HARNESS_META_STOPWORDS,
  buildGraphifyQuery,
  shapeGraphifyQuery,
  prepareGraphifyForRun,
  type GraphifyCommandResult,
  type GraphifyRunner,
} from "../../src/graphify.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

describe("graphify stopword lists", () => {
  it("keeps built-in lists disjoint and free of duplicates", () => {
    expect(new Set(ENGLISH_STOPWORDS).size).toBe(ENGLISH_STOPWORDS.length);
    expect(new Set(HARNESS_META_STOPWORDS).size).toBe(HARNESS_META_STOPWORDS.length);
    const overlap = ENGLISH_STOPWORDS.filter((word) =>
      (HARNESS_META_STOPWORDS as readonly string[]).includes(word),
    );
    expect(overlap).toEqual([]);
  });
});

describe("buildGraphifyQuery", () => {
  it("retains code-domain and game-domain tokens that matter for structural search", () => {
    const query = buildGraphifyQuery("player inventory SettlementWindow");
    expect(query).toContain("SettlementWindow");
    expect(query.toLowerCase()).toContain("player");
    expect(query.toLowerCase()).toContain("inventory");
  });

  it("drops English stopwords and harness meta tokens", () => {
    const query = buildGraphifyQuery(
      "the objective acceptance criteria resolution recommendation ticket grill packet BuildableCapitol",
    );
    expect(query).toContain("BuildableCapitol");
    expect(query.toLowerCase()).not.toContain("objective");
    expect(query.toLowerCase()).not.toContain("acceptance");
    expect(query.toLowerCase()).not.toContain("the");
  });

  it("shapes pure English stopwords to an empty query", () => {
    expect(buildGraphifyQuery("the and or for to of in on at by with")).toBe("");
  });

  it("honours project-configured stopwords", () => {
    const query = buildGraphifyQuery("SettlementWindow ledger padding", 12, ["ledger"]);
    expect(query).toContain("SettlementWindow");
    expect(query.toLowerCase()).not.toContain("ledger");
  });

  it("prefers PascalCase identifiers ahead of ordinary nouns", () => {
    const query = buildGraphifyQuery("naming SettlementWindow for refunds SettlementWindow ledger");
    const tokens = query.split(/\s+/);
    expect(tokens[0]).toBe("SettlementWindow");
  });
});

describe("shapeGraphifyQuery", () => {
  it("falls back to a domain seed when the primary query is only harness meta-language", () => {
    const shaped = shapeGraphifyQuery(
      "objective acceptance criteria resolution recommendation",
      "QuietGreetingBanner SettlementWindow",
    );
    expect(shaped.usedFallback).toBe(true);
    expect(shaped.query).toContain("QuietGreetingBanner");
    expect(shaped.skippedReason).toBeUndefined();
  });

  it("skips Graphify when primary and fallback stay generic", () => {
    const shaped = shapeGraphifyQuery(
      "the objective acceptance criteria",
      "recommendation ticket grill packet",
    );
    expect(shaped.query).toBe("");
    expect(shaped.skippedReason).toBe("generic-query");
  });
});

describe("GraphifyRepositoryLookup", () => {
  it("runs the project-local setup only when a new run lacks a usable graph", async () => {
    const root = await fixtureRoot();
    const graphPath = path.join(root, "graphify-out", "graph.json");
    const scriptPath = path.join(
      root,
      "agent-harness",
      "scripts",
      process.platform === "win32" ? "setup-graphify.ps1" : "setup-graphify.sh",
    );
    await mkdir(path.dirname(scriptPath), { recursive: true });
    await writeFile(scriptPath, "# setup\n", "utf8");
    const runner = vi.fn<GraphifyRunner>().mockResolvedValue(result("graphify 0.9.1\n"));
    const setup = vi.fn(async () => {
      await mkdir(path.dirname(graphPath), { recursive: true });
      await writeFile(graphPath, "{}\n", "utf8");
      return result("ready\n");
    });
    const config = fixtureConfig(root, {
      knowledge: {
        ...fixtureConfig(root).knowledge,
        graphify: { ...fixtureConfig(root).knowledge.graphify, enabled: true },
      },
    });

    await expect(prepareGraphifyForRun(config, runner, setup)).resolves.toMatchObject({
      enabled: true,
      graphReady: true,
      setupRan: true,
    });
    expect(setup).toHaveBeenCalledOnce();

    await expect(prepareGraphifyForRun(config, runner, setup)).resolves.toMatchObject({
      setupRan: false,
    });
    expect(setup).toHaveBeenCalledOnce();
  });

  it("updates and queries the repository graph with argument-safe process calls", async () => {
    const root = await fixtureRoot();
    const graphPath = path.join(root, "graphify-out", "graph.json");
    await mkdir(path.dirname(graphPath), { recursive: true });
    await writeFile(graphPath, "{}\n", "utf8");
    const calls: Array<{ executable: string; args: string[]; timeoutMs: number }> = [];
    const runner: GraphifyRunner = async (executable, args, options) => {
      calls.push({ executable, args, timeoutMs: options.timeoutMs });
      return result(
        args[0] === "query"
          ? "NODE LocalKnowledgeBase [src=packages/agent-harness/src/knowledge.ts loc=L47]\n"
          : "Updated graph\n",
      );
    };
    const config = fixtureConfig(root, {
      knowledge: {
        sources: ["README.md", "docs"],
        chunkCharacters: 400,
        graphify: {
          enabled: true,
          command: "graphify-custom",
          updateOnRefresh: true,
          updateTimeoutMs: 90_000,
          queryTimeoutMs: 7_000,
          queryBudgetTokens: 900,
          roles: ["implementer"],
          stopwords: [],
        },
      },
    });
    const lookup = new GraphifyRepositoryLookup(config, runner);

    await lookup.refresh();
    const found = await lookup.search("Where is knowledge loaded?");

    expect(calls[0]).toEqual({
      executable: "graphify-custom",
      args: ["update", root],
      timeoutMs: 90_000,
    });
    expect(calls[1]).toEqual({
      executable: "graphify-custom",
      args: [
        "query",
        "knowledge loaded",
        "--budget",
        "900",
        "--graph",
        graphPath,
      ],
      timeoutMs: 7_000,
    });
    expect(found.result).toMatchObject({
      source: "graphify:graphify-out/graph.json",
      title: "Repository relationships (Graphify)",
    });
    expect(found.result?.excerpt).toContain("LocalKnowledgeBase");
    expect(found.shapedQuery).toBe("knowledge loaded");
  });

  it("returns no context when Graphify finds no matching nodes", async () => {
    const root = await fixtureRoot();
    const graphPath = path.join(root, "graphify-out", "graph.json");
    await mkdir(path.dirname(graphPath), { recursive: true });
    await writeFile(graphPath, "{}\n", "utf8");
    const runner = vi.fn<GraphifyRunner>().mockResolvedValue(result("No matching nodes found.\n"));
    const config = fixtureConfig(root, {
      knowledge: {
        sources: ["README.md", "docs"],
        chunkCharacters: 400,
        graphify: {
          ...fixtureConfig(root).knowledge.graphify,
          enabled: true,
        },
      },
    });

    const outcome = await new GraphifyRepositoryLookup(config, runner).search("unknown topic");
    expect(outcome.result).toBeUndefined();
    expect(outcome.skippedReason).toBe("no-matches");
    expect(outcome.shapedQuery).toBe("unknown topic");
  });

  it("skips the Graphify CLI when shaped seeds stay generic", async () => {
    const root = await fixtureRoot();
    const graphPath = path.join(root, "graphify-out", "graph.json");
    await mkdir(path.dirname(graphPath), { recursive: true });
    await writeFile(graphPath, "{}\n", "utf8");
    const runner = vi.fn<GraphifyRunner>().mockResolvedValue(result("should not run\n"));
    const config = fixtureConfig(root, {
      knowledge: {
        ...fixtureConfig(root).knowledge,
        graphify: { ...fixtureConfig(root).knowledge.graphify, enabled: true },
      },
    });

    const outcome = await new GraphifyRepositoryLookup(config, runner).search(
      "the objective acceptance criteria",
      { fallbackQuery: "recommendation ticket grill packet" },
    );

    expect(outcome.result).toBeUndefined();
    expect(outcome.skippedReason).toBe("generic-query");
    expect(runner).not.toHaveBeenCalled();
  });

  it("memoises identical shaped queries against the same graph mtime", async () => {
    const root = await fixtureRoot();
    const graphPath = path.join(root, "graphify-out", "graph.json");
    await mkdir(path.dirname(graphPath), { recursive: true });
    await writeFile(graphPath, "{}\n", "utf8");
    const runner = vi.fn<GraphifyRunner>().mockResolvedValue(
      result("NODE LocalKnowledgeBase [src=knowledge.ts]\n"),
    );
    const config = fixtureConfig(root, {
      knowledge: {
        ...fixtureConfig(root).knowledge,
        graphify: { ...fixtureConfig(root).knowledge.graphify, enabled: true },
      },
    });
    const lookup = new GraphifyRepositoryLookup(config, runner);

    const first = await lookup.search("SettlementWindow refunds");
    const second = await lookup.search("SettlementWindow refunds");
    expect(runner).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second.result).not.toBe(first.result);
  });
});

function result(stdout: string): GraphifyCommandResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}
