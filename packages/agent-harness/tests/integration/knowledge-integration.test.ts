import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRepositoryIntelligenceBroker,
  type ExecutableRunner,
} from "../../src/infrastructure/repository-intelligence/index.js";
import { LocalKnowledgeBase } from "../../src/knowledge.js";
import { resolveHarnessPaths } from "../../src/application/paths.js";
import { withDiagnosticArtifacts } from "../testkit/diagnostics.js";
import { createProjectFixture, type ProjectFixture } from "../testkit/project-fixture.js";

describe("Phase 5 knowledge integration", () => {
  let fixture: ProjectFixture | undefined;

  afterEach(async () => {
    await fixture?.cleanup();
    fixture = undefined;
  });

  it("refreshes invalidate caches, honors scope gates, selects guidance, and soft-fails repository intelligence", async () => {
    fixture = await createProjectFixture({
      initialFiles: {
        "README.md": "# Fixture\n",
        "docs/alpha.md": "# AlphaModule\n\nAlphaModule refund ledger for project A.\n",
      },
    });

    await withDiagnosticArtifacts(
      { testName: "knowledge-integration-cache-scope-codegraph", fixture },
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

        const indexPath = path.join(fixture!.root, ".codegraph", "codegraph.db");
        await mkdir(path.dirname(indexPath), { recursive: true });
        await writeFile(indexPath, "index\n", "utf8");

        let queryCalls = 0;
        const runner = vi.fn<ExecutableRunner>().mockImplementation(async (_executable, args) => {
          if (args[0] === "--version") {
            return { exitCode: 0, stdout: "1.5.0\n", stderr: "", timedOut: false };
          }
          if (args[0] === "sync" || args[0] === "analyze") {
            return { exitCode: 0, stdout: "updated\n", stderr: "", timedOut: false };
          }
          queryCalls += 1;
          if (queryCalls === 1) {
            return {
              exitCode: 1,
              stdout: "",
              stderr: "codegraph explore exploded",
              timedOut: false,
            };
          }
          return {
            exitCode: 0,
            stdout: "AlphaModule search\nsrc/alpha.ts\n",
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
              {
                path: "docs",
                scope: "project" as const,
                visibility: "private" as const,
                projectId: "project-a",
              },
            ],
            guidance: {
              enabled: true,
              maxResults: 6,
              maxCharacters: 6_000,
              sharedRoot,
            },
            repositoryIntelligence: {
              ...fixture!.config.knowledge.repositoryIntelligence,
              enabled: true,
              providers: {
                ...fixture!.config.knowledge.repositoryIntelligence.providers,
                gitnexus: {
                  ...fixture!.config.knowledge.repositoryIntelligence.providers.gitnexus,
                  enabled: false,
                },
                codegraph: {
                  ...fixture!.config.knowledge.repositoryIntelligence.providers.codegraph,
                  enabled: true,
                  updateTimeoutMs: 60_000,
                  queryTimeoutMs: 5_000,
                },
              },
              routes: {
                search: ["codegraph"],
                "symbol-context": ["codegraph"],
                impact: [],
                trace: [],
                "change-impact": [],
              },
            },
          },
        };

        const paths = resolveHarnessPaths(config);
        const broker = createRepositoryIntelligenceBroker({ config, paths, runner });
        const knowledge = new LocalKnowledgeBase(config, broker, paths, { sharedRoot });
        await knowledge.refresh();

        const firstSearch = await knowledge.searchWithAudit("AlphaModule refunds", 4, {
          repository: true,
        });
        expect(firstSearch.results.some((result) => result.source.includes("docs/alpha.md"))).toBe(
          true,
        );
        expect(
          firstSearch.audit.omitted.some((item) => item.reason === "repository-skipped") ||
            firstSearch.audit.repository.skippedReason,
        ).toBeTruthy();

        const guidance = await knowledge.selectGuidanceWithAudit("AlphaModule refunds", {
          role: "planner",
          assignment: { rules: ["alpha"], skills: [] },
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
        expect(
          foreign.results.every(
            (result) =>
              result.scope === "global" ||
              result.projectId !== "project-a" ||
              result.visibility === "shared",
          ),
        ).toBe(true);
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

  it("falls back from GitNexus to CodeGraph and continues documents when both fail", async () => {
    fixture = await createProjectFixture({
      initialFiles: {
        "README.md": "# Fixture\n",
        "docs/settlement.md": "# SettlementWindow\n\nSettlementWindow closes the ledger nightly.\n",
      },
    });

    await withDiagnosticArtifacts(
      { testName: "knowledge-integration-gitnexus-codegraph-fallback", fixture },
      async () => {
        await mkdir(path.join(fixture!.root, ".gitnexus"), { recursive: true });
        await writeFile(path.join(fixture!.root, ".gitnexus", "gitnexus.json"), "{}\n", "utf8");
        await mkdir(path.join(fixture!.root, ".codegraph"), { recursive: true });
        await writeFile(path.join(fixture!.root, ".codegraph", "codegraph.db"), "index\n", "utf8");

        const runner = vi.fn<ExecutableRunner>(async (_executable, args) => {
          if (args[0] === "--version") {
            return { exitCode: 0, stdout: "1.0.0\n", stderr: "", timedOut: false };
          }
          if (args[0] === "query" || args[0] === "context") {
            return { exitCode: 0, stdout: "\n", stderr: "", timedOut: false };
          }
          if (args[0] === "explore" || args[0] === "node") {
            return { exitCode: 1, stdout: "", stderr: "codegraph failed", timedOut: false };
          }
          return { exitCode: 0, stdout: "ok\n", stderr: "", timedOut: false };
        });

        const base = fixture!.config;
        const config = {
          ...base,
          knowledge: {
            ...base.knowledge,
            sources: [{ path: "docs", scope: "project" as const, visibility: "private" as const }],
            repositoryIntelligence: {
              ...base.knowledge.repositoryIntelligence,
              enabled: true,
              providers: {
                ...base.knowledge.repositoryIntelligence.providers,
                gitnexus: {
                  ...base.knowledge.repositoryIntelligence.providers.gitnexus,
                  enabled: true,
                },
                codegraph: {
                  ...base.knowledge.repositoryIntelligence.providers.codegraph,
                  enabled: true,
                },
              },
              routes: {
                search: ["gitnexus", "codegraph"],
                "symbol-context": ["gitnexus", "codegraph"],
                impact: [],
                trace: [],
                "change-impact": [],
              },
            },
          },
        };
        const paths = resolveHarnessPaths(config);
        const broker = createRepositoryIntelligenceBroker({ config, paths, runner });
        const knowledge = new LocalKnowledgeBase(config, broker, paths);
        await knowledge.refresh();

        const { results, audit } = await knowledge.searchWithAudit("SettlementWindow ledger", 4);

        expect(results.some((result) => result.source.includes("docs/settlement.md"))).toBe(true);
        expect(results.every((result) => !result.source.startsWith("repository:"))).toBe(true);
        expect(audit.repository.included).toBe(false);
        expect(audit.repository.attempts.map((attempt) => [attempt.providerId, attempt.outcome])).toEqual([
          ["gitnexus", "miss"],
          ["codegraph", "miss"],
        ]);
        expect(audit.omitted.some((item) => item.reason === "repository-skipped")).toBe(true);

        // Positive control: GitNexus miss → CodeGraph success.
        const successRunner = vi.fn<ExecutableRunner>(async (_executable, args) => {
          if (args[0] === "--version") {
            return { exitCode: 0, stdout: "1.0.0\n", stderr: "", timedOut: false };
          }
          if (args[0] === "query" || args[0] === "context") {
            return { exitCode: 0, stdout: "\n", stderr: "", timedOut: false };
          }
          if (args[0] === "explore" || args[0] === "node") {
            return {
              exitCode: 0,
              stdout: "SettlementWindow -> Ledger\n",
              stderr: "",
              timedOut: false,
            };
          }
          return { exitCode: 0, stdout: "ok\n", stderr: "", timedOut: false };
        });
        const successBroker = createRepositoryIntelligenceBroker({
          config,
          paths,
          runner: successRunner,
        });
        const successKnowledge = new LocalKnowledgeBase(config, successBroker, paths);
        await successKnowledge.refresh();
        const success = await successKnowledge.searchWithAudit("SettlementWindow ledger", 4);
        expect(success.results[0]?.source).toBe("repository:codegraph");
        expect(success.audit.repository.attempts.map((a) => [a.providerId, a.outcome])).toEqual([
          ["gitnexus", "miss"],
          ["codegraph", "success"],
        ]);
        expect(success.audit.repository.providerId).toBe("codegraph");
        expect(success.audit.repository.included).toBe(true);
      },
    );
  });
});
