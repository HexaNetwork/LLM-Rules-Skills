import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  CodeGraphAdapter,
  RepositoryIntelligenceBroker,
  type ExecutableRunner,
} from "../../src/infrastructure/repository-intelligence/index.js";
import { LocalKnowledgeBase } from "../../src/knowledge.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

describe("retrieval result cache", () => {
  it("caches by provider generation and invalidates after relevant path changes", async () => {
    const root = await fixtureRoot();
    await writeFile(
      path.join(root, "docs", "settlement.md"),
      "# SettlementWindow\n\nSettlementWindow refund ledger.\n",
      "utf8",
    );
    const indexPath = path.join(root, ".codegraph", "codegraph.db");
    await mkdir(path.dirname(indexPath), { recursive: true });
    await writeFile(indexPath, "index\n", "utf8");

    const runner = vi.fn<ExecutableRunner>().mockImplementation(async (_executable, args) => {
      if (args[0] === "sync") {
        return { exitCode: 0, stdout: "updated\n", stderr: "", timedOut: false };
      }
      return {
        exitCode: 0,
        stdout: "SettlementWindow search\nsrc/settlement.ts\n",
        stderr: "",
        timedOut: false};
    });
    const config = fixtureConfig(root, {
      knowledge: {
        ...fixtureConfig(root).knowledge,
        repositoryIntelligence: {
          ...fixtureConfig(root).knowledge.repositoryIntelligence,
          enabled: true,
        },
      },
    });
    const provider = config.knowledge.repositoryIntelligence.providers.codegraph;
    const adapter = new CodeGraphAdapter({ workspaceRoot: root }, {
      ...provider,
      maxFiles: provider.maxResults,
      sourceExtensions: config.knowledge.repositoryIntelligence.sourceExtensions,
      maxCharacters: config.workflow.repositoryContextCharacters,
    }, runner);
    const broker = new RepositoryIntelligenceBroker({
      adapters: [adapter],
      routes: { search: ["codegraph"] },
    });
    const knowledge = new LocalKnowledgeBase(config, broker);
    await knowledge.refresh();
    const queryCallsBefore = runner.mock.calls.filter((call) => call[1][0] === "explore").length;
    expect(queryCallsBefore).toBe(0);

    const first = await knowledge.searchWithAudit("SettlementWindow refunds", 4);
    const second = await knowledge.searchWithAudit("SettlementWindow refunds", 4);
    expect(runner.mock.calls.filter((call) => call[1][0] === "explore")).toHaveLength(1);
    expect(second).toEqual(first);
    expect(second.results[0]).not.toBe(first.results[0]);
    second.results[0]!.excerpt = "mutated";
    expect(first.results[0]?.excerpt).not.toBe("mutated");

    await knowledge.refresh();
    await knowledge.searchWithAudit("SettlementWindow refunds", 4);
    expect(runner.mock.calls.filter((call) => call[1][0] === "explore")).toHaveLength(1);

    await knowledge.repositoryPathsChanged(["src/settlement.ts"]);
    await knowledge.searchWithAudit("SettlementWindow refunds", 4);
    expect(runner.mock.calls.filter((call) => call[1][0] === "explore").length).toBeGreaterThanOrEqual(2);

    await knowledge.searchWithAudit("DifferentQuery SettlementWindow", 4);
    expect(runner.mock.calls.filter((call) => call[1][0] === "explore").length).toBeGreaterThanOrEqual(3);
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
