import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  ENGLISH_STOPWORDS,
  GraphifyRepositoryLookup,
  HARNESS_META_STOPWORDS,
  buildGraphifyQuery,
  rankGraphifyExcerpt,
  shapeGraphifyQuery,
  prepareGraphifyForRun,
  type GraphifyCommandResult,
  type GraphifyRunner} from "../../src/graphify.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

const HUB_ORDERED_DUMP = [
  "Traversal: BFS | Start: ['Point2D', 'TownChunkValidation', 'CultureZone'] | 150 nodes found",
  "NODE .format() [src=src/util/Format.kt loc=L12 community=0]",
  "NODE Resident [src=src/resident/Resident.kt loc=L40 community=0]",
  "NODE Town [src=src/town/Town.kt loc=L10 community=0]",
  "NODE CivGlobal [src=src/CivGlobal.kt loc=L1 community=0]",
  ...Array.from({ length: 40 }, (_, i) =>
    `NODE HubNode${i} [src=src/hub/Hub${i}.kt loc=L${i + 1} community=1]`,
  ),
  "NODE CultureZone [src=src/culture/CultureZone.kt loc=L8 community=2]",
  "NODE Point2D [src=src/geom/Point2D.kt loc=L3 community=2]",
  "NODE TownChunkValidation [src=src/town/TownChunkValidation.kt loc=L20 community=2]",
  "... truncated"].join("\n");

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

describe("rankGraphifyExcerpt", () => {
  it("promotes Start seeds ahead of hub noise within the character budget", () => {
    const shapedQuery = "Point2D TownChunkValidation CultureZone";
    const ranked = rankGraphifyExcerpt(HUB_ORDERED_DUMP, shapedQuery, 3_000);

    expect(ranked).toContain("TownChunkValidation");
    expect(ranked).toContain("CultureZone");
    expect(ranked).toContain("Point2D");
    expect(ranked.startsWith("Traversal:")).toBe(true);

    const firstNode = ranked.split("\n").find((line) => line.startsWith("NODE "));
    expect(firstNode).toBeTruthy();
    expect(firstNode).not.toMatch(/^NODE \.format\(\)/);
    expect(firstNode).not.toMatch(/^NODE Resident\b/);
    expect(ranked).toContain("... truncated");
  });

  it("passes through unparseable or NODE-less stdout unchanged", () => {
    const plain = "Graphify could not parse this reply.";
    expect(rankGraphifyExcerpt(plain, "Point2D", 3_000)).toBe(plain);

    const headerOnly =
      "Traversal: BFS | Start: ['Point2D'] | 0 nodes found\n(no body)";
    expect(rankGraphifyExcerpt(headerOnly, "Point2D", 3_000)).toBe(headerOnly);
  });

  it("demotes method-noise labels relative to type nodes", () => {
    const dump = [
      "Traversal: BFS | Start: ['CultureZone'] | 3 nodes found",
      "NODE .format() [src=src/util/Format.kt loc=L12]",
      "NODE CultureZone [src=src/culture/CultureZone.kt loc=L8]",
      "NODE .toString() [src=src/util/Format.kt loc=L40]"].join("\n");

    const ranked = rankGraphifyExcerpt(dump, "CultureZone", 3_000);
    const nodeLabels = ranked
      .split("\n")
      .filter((line) => line.startsWith("NODE "))
      .map((line) => line.slice("NODE ".length).split(" [")[0]);

    expect(nodeLabels[0]).toBe("CultureZone");
    expect(nodeLabels.slice(1)).toEqual([".format()", ".toString()"]);
  });

  it("drops unrelated tail nodes from oversized hub traversals", () => {
    const dump = [
      "Traversal: BFS depth=2 | Start: ['BuildableAreaValidation'] | 7424 nodes found",
      "NODE Resident [src=src/resident/Resident.java loc=L40]",
      "NODE BuildableAreaValidation [src=src/construction/BuildableAreaValidation.java loc=L8]",
      "NODE Window [src=src/ui/Window.java loc=L1]",
    ].join("\n");

    const ranked = rankGraphifyExcerpt(dump, "BuildableAreaValidation", 3_000);

    expect(ranked).toContain("NODE BuildableAreaValidation");
    expect(ranked).not.toContain("NODE Resident");
    expect(ranked).not.toContain("NODE Window");
  });
});

describe("GraphifyRepositoryLookup", () => {
  it("builds the graph with graphify update when the command exists but the graph is missing", async () => {
    const root = await fixtureRoot();
    const graphPath = path.join(root, "graphify-out", "graph.json");
    const runner = vi.fn<GraphifyRunner>(async (_executable, args) => {
      if (args[0] === "--version") return result("graphify 0.9.1\n");
      if (args[0] === "update") {
        await mkdir(path.dirname(graphPath), { recursive: true });
        await writeFile(graphPath, "{}\n", "utf8");
        return result("Updated graph\n");
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected", timedOut: false };
    });
    const config = fixtureConfig(root, {
      knowledge: {
        ...fixtureConfig(root).knowledge,
        graphify: { ...fixtureConfig(root).knowledge.graphify, enabled: true }}});

    await expect(prepareGraphifyForRun(config, runner)).resolves.toMatchObject({
      enabled: true,
      graphReady: true,
      setupRan: true});
    expect(runner).toHaveBeenCalledWith(
      "graphify",
      ["update", root],
      expect.objectContaining({ cwd: root }),
    );

    await expect(prepareGraphifyForRun(config, runner)).resolves.toMatchObject({
      setupRan: false});
  });

  it("fails clearly when graphify is enabled but not installed", async () => {
    const root = await fixtureRoot();
    const runner = vi.fn<GraphifyRunner>().mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "not found",
      timedOut: false});
    const config = fixtureConfig(root, {
      knowledge: {
        ...fixtureConfig(root).knowledge,
        graphify: { ...fixtureConfig(root).knowledge.graphify, enabled: true }}});

    await expect(prepareGraphifyForRun(config, runner)).rejects.toThrow(/uv tool install graphifyy/i);
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
          stopwords: []}}});
    const lookup = new GraphifyRepositoryLookup(config, runner);

    await lookup.refresh();
    const found = await lookup.search("Where is knowledge loaded?");

    expect(calls[0]).toEqual({
      executable: "graphify-custom",
      args: ["update", root],
      timeoutMs: 90_000});
    expect(calls[1]).toEqual({
      executable: "graphify-custom",
      args: [
        "query",
        "knowledge loaded",
        "--budget",
        "900",
        "--graph",
        graphPath],
      timeoutMs: 7_000});
    expect(found.result).toMatchObject({
      source: "graphify:graphify-out/graph.json",
      title: "Repository relationships (Graphify)",
      score: 0});
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
          enabled: true}}});

    const outcome = await new GraphifyRepositoryLookup(config, runner).search("unknown topic");
    expect(outcome.result).toBeUndefined();
    expect(outcome.skippedReason).toBe("no-matches");
    expect(outcome.shapedQuery).toBe("unknown topic");
  });

  it("explains concrete source symbols instead of running broad prose BFS", async () => {
    const root = await fixtureRoot();
    const graphPath = path.join(root, "graphify-out", "graph.json");
    await mkdir(path.dirname(graphPath), { recursive: true });
    await writeFile(graphPath, "{}\n", "utf8");
    const runner = vi.fn<GraphifyRunner>().mockResolvedValue(
      result([
        "Node: BuildableAreaValidation",
        "  Source: src/construction/BuildableAreaValidation.java L14",
        "  Degree: 2",
        "",
        "Connections (2):",
        "  --> Buildable [references]",
        "  --> ConstructionStep [implements]",
      ].join("\n")),
    );
    const config = fixtureConfig(root, {
      knowledge: {
        ...fixtureConfig(root).knowledge,
        graphify: { ...fixtureConfig(root).knowledge.graphify, enabled: true },
      },
    });

    const outcome = await new GraphifyRepositoryLookup(config, runner).search(
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
      ["explain", "BuildableAreaValidation", "--graph", graphPath],
      expect.any(Object),
    );
    expect(runner).toHaveBeenCalledTimes(1);
    expect(outcome.result?.title).toBe("Exact repository relationships (Graphify)");
    expect(outcome.result?.excerpt).toContain("ConstructionStep");
  });

  it("keeps focused explains and compacts high-degree path hubs", async () => {
    const root = await fixtureRoot();
    const graphPath = path.join(root, "graphify-out", "graph.json");
    await mkdir(path.dirname(graphPath), { recursive: true });
    await writeFile(graphPath, "{}\n", "utf8");
    const runner = vi.fn<GraphifyRunner>(async (_executable, args) => {
      const symbol = args[1];
      if (symbol === "FocusedValidation") {
        return result([
          "Node: FocusedValidation",
          "  Source: src/FocusedValidation.java L10",
          "  Degree: 2",
          "",
          "Connections (2):",
          "  --> Area [references]",
          "  --> Step [implements]",
        ].join("\n"));
      }
      return result([
        "Node: GiantHub",
        "  Source: src/GiantHub.java L10",
        "  Degree: 643",
        "",
        "Connections (643):",
        ...Array.from({ length: 12 }, (_, index) => `  --> Edge${index} [references]`),
      ].join("\n"));
    });
    const config = fixtureConfig(root, {
      knowledge: {
        ...fixtureConfig(root).knowledge,
        graphify: { ...fixtureConfig(root).knowledge.graphify, enabled: true },
      },
    });

    const outcome = await new GraphifyRepositoryLookup(config, runner).search("broad prose", {
      pathHints: ["src/FocusedValidation.java", "src/GiantHub.java"],
    });
    const excerpt = outcome.result?.excerpt ?? "";

    expect(excerpt).toContain("Node: FocusedValidation");
    expect(excerpt).toContain("--> Step");
    expect(excerpt).toContain("Node: GiantHub");
    expect(excerpt).toContain("high-degree hub (643)");
    expect(excerpt).toContain("--> Edge4");
    expect(excerpt).not.toContain("--> Edge5");
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
        graphify: { ...fixtureConfig(root).knowledge.graphify, enabled: true }}});

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
        graphify: { ...fixtureConfig(root).knowledge.graphify, enabled: true }}});
    const lookup = new GraphifyRepositoryLookup(config, runner);

    const first = await lookup.search("SettlementWindow refunds");
    const second = await lookup.search("SettlementWindow refunds");
    expect(runner).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second.result).not.toBe(first.result);
  });

  it("stores a seed-first excerpt when the CLI returns a hub-ordered dump", async () => {
    const root = await fixtureRoot();
    const graphPath = path.join(root, "graphify-out", "graph.json");
    await mkdir(path.dirname(graphPath), { recursive: true });
    await writeFile(graphPath, "{}\n", "utf8");
    const runner = vi.fn<GraphifyRunner>().mockResolvedValue(result(`${HUB_ORDERED_DUMP}\n`));
    const config = fixtureConfig(root, {
      knowledge: {
        ...fixtureConfig(root).knowledge,
        graphify: { ...fixtureConfig(root).knowledge.graphify, enabled: true }},
      workflow: {
        ...fixtureConfig(root).workflow,
        graphifyCharacters: 3_000}});

    const outcome = await new GraphifyRepositoryLookup(config, runner).search(
      "Point2D TownChunkValidation CultureZone placement",
    );

    const excerpt = outcome.result?.excerpt ?? "";
    expect(excerpt).toContain("TownChunkValidation");
    expect(excerpt).toContain("CultureZone");
    expect(excerpt).toContain("Point2D");
    const firstNode = excerpt.split("\n").find((line) => line.startsWith("NODE "));
    expect(firstNode).toMatch(/TownChunkValidation|CultureZone|Point2D/);
    expect(firstNode).not.toMatch(/^NODE \.format\(\)/);
    expect(firstNode).not.toMatch(/^NODE Resident\b/);
  });
});

function result(stdout: string): GraphifyCommandResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}
