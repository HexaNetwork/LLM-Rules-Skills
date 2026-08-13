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
        timedOut: false};
    });
    const config = fixtureConfig(root, {
      knowledge: {
        ...fixtureConfig(root).knowledge,
        graphify: {
          ...fixtureConfig(root).knowledge.graphify,
          enabled: true,
          updateOnRefresh: true}}});
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

  it("invalidates retrieval on refresh and guidance on root mtime changes independently", async () => {
    const root = await fixtureRoot();
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(
      path.join(root, "docs", "refunds.md"),
      "# SettlementWindow\n\nSettlementWindow refund ledger guidance.\n",
      "utf8",
    );
    const sharedRoot = path.join(root, "guidance-shared");
    const rulesDir = path.join(sharedRoot, "General", "rules");
    await mkdir(rulesDir, { recursive: true });
    await writeFile(
      path.join(rulesDir, "settlement.mdc"),
      [
        "---",
        "description: SettlementWindow refunds",
        "globs:",
        "alwaysApply: false",
        "roles:",
        "  - planner",
        "---",
        "",
        "Prefer SettlementWindow refund ledger patterns.",
        ""].join("\n"),
      "utf8",
    );

    const config = fixtureConfig(root, {
      knowledge: {
        ...fixtureConfig(root).knowledge,
        sources: [{ path: "docs", scope: "project" as const, visibility: "private" as const }],
        guidance: {
          enabled: true,
          maxResults: 6,
          maxCharacters: 6_000,
          sharedRoot}}});
    const knowledge = new LocalKnowledgeBase(config, undefined, undefined, { sharedRoot });
    await knowledge.refresh();

    const retrievalFirst = await knowledge.searchWithAudit("SettlementWindow refunds", 4);
    const guidanceFirst = await knowledge.selectGuidanceWithAudit("SettlementWindow refunds", {
      role: "planner",
      assignment: { rules: ["settlement"], skills: [] }});
    expect(retrievalFirst.results.length).toBeGreaterThan(0);
    expect(guidanceFirst.selected.length).toBeGreaterThan(0);

    const retrievalSecond = await knowledge.searchWithAudit("SettlementWindow refunds", 4);
    const guidanceSecond = await knowledge.selectGuidanceWithAudit("SettlementWindow refunds", {
      role: "planner",
      assignment: { rules: ["settlement"], skills: [] }});
    expect(retrievalSecond).toEqual(retrievalFirst);
    expect(guidanceSecond).toEqual(guidanceFirst);
    expect(retrievalSecond.results[0]).not.toBe(retrievalFirst.results[0]);
    expect(guidanceSecond.selected[0]).not.toBe(guidanceFirst.selected[0]);

    await writeFile(
      path.join(root, "docs", "refunds.md"),
      "# SettlementWindow\n\nSettlementWindow refund ledger guidance. UPDATED_TOKEN_XYZ.\n",
      "utf8",
    );
    await knowledge.refresh();

    const retrievalAfter = await knowledge.searchWithAudit("SettlementWindow refunds", 4);
    const guidanceAfterRefresh = await knowledge.selectGuidanceWithAudit("SettlementWindow refunds", {
      role: "planner",
      assignment: { rules: ["settlement"], skills: [] }});
    expect(JSON.stringify(retrievalAfter)).toContain("UPDATED_TOKEN_XYZ");
    expect(retrievalAfter).not.toEqual(retrievalFirst);
    // Document refresh must not clear injected guidance.
    expect(guidanceAfterRefresh).toEqual(guidanceFirst);

    await writeFile(
      path.join(rulesDir, "settlement.mdc"),
      [
        "---",
        "description: SettlementWindow refunds UPDATED_TOKEN_XYZ",
        "globs:",
        "alwaysApply: false",
        "roles:",
        "  - planner",
        "---",
        "",
        "Prefer SettlementWindow refund ledger patterns. UPDATED_TOKEN_XYZ",
        ""].join("\n"),
      "utf8",
    );

    const guidanceAfter = await knowledge.selectGuidanceWithAudit("SettlementWindow refunds", {
      role: "planner",
      assignment: { rules: ["settlement"], skills: [] }});
    expect(JSON.stringify(guidanceAfter)).toContain("UPDATED_TOKEN_XYZ");
    expect(guidanceAfter).not.toEqual(guidanceFirst);
  });
});
