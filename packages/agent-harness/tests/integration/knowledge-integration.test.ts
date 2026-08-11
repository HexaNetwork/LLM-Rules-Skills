import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphifyRepositoryLookup, type GraphifyRunner } from "../../src/graphify.js";
import { LocalKnowledgeBase } from "../../src/knowledge.js";
import { withDiagnosticArtifacts } from "../testkit/diagnostics.js";
import { createProjectFixture, type ProjectFixture } from "../testkit/project-fixture.js";

describe("Phase 5 knowledge integration", () => {
  let fixture: ProjectFixture | undefined;

  afterEach(async () => {
    await fixture?.cleanup();
    fixture = undefined;
  });

  it("refreshes invalidate caches, honors scope gates, selects guidance, and soft-fails Graphify", async () => {
    fixture = await createProjectFixture({
      initialFiles: {
        "README.md": "# Fixture\n",
        "docs/alpha.md": "# AlphaModule\n\nAlphaModule refund ledger for project A.\n",
      },
    });

    await withDiagnosticArtifacts(
      { testName: "knowledge-integration-cache-scope-graphify", fixture },
      async () => {
        const sharedRoot = path.join(fixture!.root, "guidance-shared");
        const rulesDir = path.join(sharedRoot, "General", "rules");
        await mkdir(rulesDir, { recursive: true });
        await writeFile(
          path.join(rulesDir, "alpha.mdc"),
          [
            "---",
            "description: AlphaModule refunds",
            "globs:",
            "alwaysApply: false",
            "roles:",
            "  - planner",
            "---",
            "",
            "Prefer AlphaModule refund ledger patterns.",
            "",
          ].join("\n"),
          "utf8",
        );

        const graphPath = path.join(fixture!.root, "graphify-out", "graph.json");
        await mkdir(path.dirname(graphPath), { recursive: true });
        await writeFile(graphPath, "{}\n", "utf8");

        let queryCalls = 0;
        const runner = vi.fn<GraphifyRunner>().mockImplementation(async (_executable, args) => {
          if (args[0] === "update") {
            return { exitCode: 0, stdout: "updated\n", stderr: "", timedOut: false };
          }
          queryCalls += 1;
          if (queryCalls === 1) {
            return {
              exitCode: 1,
              stdout: "",
              stderr: "graphify query exploded",
              timedOut: false,
            };
          }
          return {
            exitCode: 0,
            stdout: "NODE AlphaModule [src=src/alpha.ts]\n",
            stderr: "",
            timedOut: false,
          };
        });

        const config = {
          ...fixture!.config,
          knowledge: {
            ...fixture!.config.knowledge,
            projectId: "project-a",
            sources: [
              { path: "docs", scope: "project" as const, visibility: "private" as const, projectId: "project-a" },
            ],
            guidance: {
              enabled: true,
              maxResults: 6,
              maxCharacters: 6_000,
              sharedRoot,
            },
            graphify: {
              ...fixture!.config.knowledge.graphify,
              enabled: true,
              updateOnRefresh: false,
            },
          },
        };

        const knowledge = new LocalKnowledgeBase(
          config,
          new GraphifyRepositoryLookup(config, runner),
          undefined,
          { sharedRoot },
        );
        await knowledge.refresh();

        const firstSearch = await knowledge.searchWithAudit("AlphaModule refunds", 4, {
          repository: true,
        });
        // Soft-fail: Graphify error does not throw; lexical docs still surface.
        expect(firstSearch.results.some((result) => result.source.includes("docs/alpha.md"))).toBe(
          true,
        );
        expect(
          firstSearch.audit.omitted.some((item) => item.reason === "graphify-skipped") ||
            firstSearch.audit.graphify.skippedReason,
        ).toBeTruthy();

        const guidance = await knowledge.selectGuidanceWithAudit("AlphaModule refunds", {
          role: "planner",
        });
        expect(guidance.selected.some((item) => item.source.includes("alpha.mdc"))).toBe(true);

        const cachedSearch = await knowledge.searchWithAudit("AlphaModule refunds", 4, {
          repository: true,
        });
        expect(cachedSearch).toEqual(firstSearch);

        const foreign = await knowledge.searchWithAudit("AlphaModule refunds", 4, {
          projectId: "other-project",
          repository: false,
        });
        expect(foreign.results.every((result) => result.scope === "global" || result.projectId !== "project-a" || result.visibility === "shared")).toBe(
          true,
        );
        // Private project-a docs are not visible to another project id.
        expect(foreign.results.some((result) => result.source.includes("docs/alpha.md"))).toBe(
          false,
        );

        await fixture!.write(
          "docs/alpha.md",
          "# AlphaModule\n\nAlphaModule refund ledger for project A. UPDATED_TOKEN_ZZZ.\n",
        );
        await knowledge.refresh();
        const afterRefresh = await knowledge.searchWithAudit("AlphaModule refunds", 4, {
          repository: false,
        });
        expect(JSON.stringify(afterRefresh)).toContain("UPDATED_TOKEN_ZZZ");
        expect(afterRefresh).not.toEqual(firstSearch);
      },
    );
  });
});
