import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { GraphifyRepositoryLookup, type GraphifyRunner } from "../../src/graphify.js";
import { LocalKnowledgeBase } from "../../src/knowledge.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

describe("retrieval result cache", () => {
  it("reuses Graphify subprocess results for identical queries and invalidates on refresh", async () => {
    const root = await fixtureRoot();
    await writeFile(
      path.join(root, "docs", "settlement.md"),
      "# SettlementWindow\n\nSettlementWindow refund ledger.\n",
      "utf8",
    );
    const graphPath = path.join(root, "graphify-out", "graph.json");
    await mkdir(path.dirname(graphPath), { recursive: true });
    await writeFile(graphPath, "{}\n", "utf8");

    const runner = vi.fn<GraphifyRunner>().mockImplementation(async (_executable, args) => {
      if (args[0] === "update") {
        return { exitCode: 0, stdout: "updated\n", stderr: "", timedOut: false };
      }
      return {
        exitCode: 0,
        stdout: "NODE SettlementWindow [src=src/settlement.ts]\n",
        stderr: "",
        timedOut: false,
      };
    });
    const config = fixtureConfig(root, {
      knowledge: {
        ...fixtureConfig(root).knowledge,
        graphify: {
          ...fixtureConfig(root).knowledge.graphify,
          enabled: true,
          updateOnRefresh: true,
        },
      },
    });
    const knowledge = new LocalKnowledgeBase(config, new GraphifyRepositoryLookup(config, runner));
    await knowledge.refresh();
    const queryCallsBefore = runner.mock.calls.filter((call) => call[1][0] === "query").length;
    expect(queryCallsBefore).toBe(0);

    const first = await knowledge.searchWithAudit("SettlementWindow refunds", 4);
    const second = await knowledge.searchWithAudit("SettlementWindow refunds", 4);
    expect(runner.mock.calls.filter((call) => call[1][0] === "query")).toHaveLength(1);
    expect(second).toEqual(first);
    expect(second.results[0]).not.toBe(first.results[0]);
    second.results[0]!.excerpt = "mutated";
    expect(first.results[0]?.excerpt).not.toBe("mutated");

    await knowledge.refresh();
    await knowledge.searchWithAudit("SettlementWindow refunds", 4);
    expect(runner.mock.calls.filter((call) => call[1][0] === "query").length).toBeGreaterThanOrEqual(2);

    await knowledge.searchWithAudit("DifferentQuery SettlementWindow", 4);
    expect(runner.mock.calls.filter((call) => call[1][0] === "query").length).toBeGreaterThanOrEqual(3);
  });
});
