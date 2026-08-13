import { describe, expect, it } from "vitest";
import {
  ENGLISH_STOPWORDS,
  HARNESS_META_STOPWORDS,
  buildCodegraphQuery,
  packCodegraphExcerpt,
  shapeCodegraphQuery,
} from "../../src/codegraph.js";

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
