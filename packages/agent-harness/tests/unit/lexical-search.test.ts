import { describe, expect, it } from "vitest";
import { rankHybridResults } from "../../src/infrastructure/knowledge/lexical-search.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

function hit(
  id: string,
  source: string,
  score: number,
) {
  return {
    id,
    source,
    title: id,
    excerpt: id,
    score,
    scope: "project" as const,
    visibility: "private" as const,
    kind: "document" as const,
  };
}

describe("rankHybridResults", () => {
  it("normalizes hybrid RRF so dual rank-1 is ~1 and single-channel rank-1 is ~0.5", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root);

    const dualAndTaper = rankHybridResults(
      [hit("both", "docs/both.md", 3), hit("lex", "docs/lex.md", 2)],
      [hit("both", "docs/both.md", 0.9), hit("sem", "docs/sem.md", 0.8)],
      config,
    );
    expect(dualAndTaper[0]?.source).toBe("docs/both.md");
    expect(dualAndTaper[0]?.score).toBeCloseTo(1, 5);
    // Rank-2 single-channel terms taper just under 0.5 after normalization.
    expect(dualAndTaper.find((result) => result.source === "docs/lex.md")?.score).toBeCloseTo(
      61 / 124,
      5,
    );

    const singleChannel = rankHybridResults(
      [hit("lex", "docs/lex.md", 3)],
      [hit("sem", "docs/sem.md", 0.9)],
      config,
    );
    expect(singleChannel.find((result) => result.source === "docs/lex.md")?.score).toBeCloseTo(
      0.5,
      5,
    );
    expect(singleChannel.find((result) => result.source === "docs/sem.md")?.score).toBeCloseTo(
      0.5,
      5,
    );
  });

  it("preserves lexical TF-IDF scores when there are no semantic candidates", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root);
    const ranked = rankHybridResults([hit("a", "docs/a.md", 4.25)], [], config);

    expect(ranked).toEqual([
      {
        source: "docs/a.md",
        title: "a",
        excerpt: "a",
        score: 4.25,
        scope: "project",
        visibility: "private",
        kind: "document",
      },
    ]);
  });
});
