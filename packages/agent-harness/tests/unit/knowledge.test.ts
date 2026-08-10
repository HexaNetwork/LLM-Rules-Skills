import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { RepositoryLookup } from "../../src/graphify.js";
import { LocalKnowledgeBase } from "../../src/knowledge.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

describe("LocalKnowledgeBase", () => {
  it("persists documents locally and returns deterministic lexical matches", async () => {
    const root = await fixtureRoot();
    await writeFile(
      path.join(root, "docs", "payments.md"),
      "# Payments\n\nA settlement window closes at midnight. Refunds use the original ledger entry.\n",
      "utf8",
    );
    await writeFile(
      path.join(root, "docs", "profiles.md"),
      "# Profiles\n\nA display name belongs to a user profile.\n",
      "utf8",
    );
    const config = fixtureConfig(root);
    const knowledge = new LocalKnowledgeBase(config);

    expect(await knowledge.refresh()).toBe(3);
    const first = await knowledge.search("refund ledger", 2);
    const second = await knowledge.search("refund ledger", 2);

    expect(first).toEqual(second);
    expect(first[0]?.source).toBe("docs/payments.md");
    expect(first[0]?.excerpt).toContain("Refunds");
    const stored = JSON.parse(
      await readFile(path.join(root, ".agent-harness", "knowledge", "documents.json"), "utf8"),
    ) as Array<{ content: string }>;
    expect(stored.some((document) => document.content.includes("settlement window"))).toBe(true);
  });

  it("reports document indexing progress during refresh", async () => {
    const root = await fixtureRoot();
    await writeFile(path.join(root, "docs", "guide.md"), "# Guide\n", "utf8");
    const progress: Array<{ stage: string; completed: number; total: number }> = [];

    await new LocalKnowledgeBase(fixtureConfig(root)).refresh((update) => progress.push(update));

    expect(progress).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "discovering" }),
      expect.objectContaining({ stage: "indexing", completed: 0 }),
      expect.objectContaining({ stage: "complete" }),
    ]));
    expect(progress.find((update) => update.stage === "indexing")?.total).toBeGreaterThan(0);
  });

  it("removes stale configured documents when a private source list changes", async () => {
    const root = await fixtureRoot();
    await writeFile(path.join(root, "docs", "legacy.md"), "legacy source text", "utf8");
    const initial = fixtureConfig(root);
    await new LocalKnowledgeBase(initial).refresh();

    const retained = fixtureConfig(root, {
      knowledge: { ...initial.knowledge, sources: ["README.md"] },
    });
    const knowledge = new LocalKnowledgeBase(retained);
    await knowledge.refresh();

    expect(await knowledge.search("legacy source", 5, { repository: false })).toEqual([]);
  });

  it("puts structural repository context ahead of lexical matches within the result limit", async () => {
    const root = await fixtureRoot();
    await writeFile(
      path.join(root, "docs", "architecture.md"),
      "# Architecture\n\nThe AgentCoordinator loads bounded context before each fresh invocation.\n",
      "utf8",
    );
    const lookup: RepositoryLookup = {
      async refresh() {},
      async rebuild() { return true; },
      async search() {
        return {
          result: {
            source: "graphify:graphify-out/graph.json",
            title: "Repository relationships (Graphify)",
            excerpt: "AgentCoordinator --calls--> LocalKnowledgeBase",
            score: 0,
          },
          shapedQuery: "AgentCoordinator",
          usedFallback: false,
        };
      },
    };
    const knowledge = new LocalKnowledgeBase(fixtureConfig(root), lookup);
    await knowledge.refresh();

    const results = await knowledge.search("AgentCoordinator context", 2);

    expect(results).toHaveLength(2);
    expect(results[0]?.source).toBe("graphify:graphify-out/graph.json");
    expect(results[0]?.score).toBe(0);
    expect(results[1]?.source).toBe("docs/architecture.md");
  });

  it("retrieves global and active-project documents while isolating other projects by default", async () => {
    const root = await fixtureRoot();
    const knowledge = new LocalKnowledgeBase(
      fixtureConfig(root, {
        knowledge: {
          ...fixtureConfig(root).knowledge,
          projectId: "alpha",
        },
      }),
    );
    await knowledge.upsertText(
      "General/auth.md",
      "Universal authentication",
      "taxonomy authentication applies everywhere",
      { scope: "global" },
    );
    await knowledge.upsertText(
      "alpha/auth.md",
      "Alpha authentication",
      "taxonomy alpha convention",
    );
    await knowledge.upsertText(
      "beta/private.md",
      "Beta private authentication",
      "taxonomy beta secret",
      { projectId: "beta", visibility: "private" },
    );
    await knowledge.upsertText(
      "beta/shared.md",
      "Beta shared authentication",
      "taxonomy beta public contract",
      { projectId: "beta", visibility: "shared" },
    );

    const defaultResults = await knowledge.search("taxonomy", 10, { repository: false });

    expect(defaultResults.map((result) => result.title)).toEqual([
      "Alpha authentication",
      "Universal authentication",
    ]);
    expect(defaultResults.every((result) => result.projectId !== "beta")).toBe(true);
  });

  it("requires explicit inclusion and shared visibility for cross-project retrieval", async () => {
    const root = await fixtureRoot();
    const base = fixtureConfig(root);
    const knowledge = new LocalKnowledgeBase(
      fixtureConfig(root, {
        knowledge: { ...base.knowledge, projectId: "alpha" },
      }),
    );
    await knowledge.upsertText("beta/private.md", "Beta private", "proration formula private", {
      projectId: "beta",
      visibility: "private",
    });
    await knowledge.upsertText("beta/shared.md", "Beta shared", "proration formula shared", {
      projectId: "beta",
      visibility: "shared",
    });

    const defaultResults = await knowledge.search("proration formula", 10, { repository: false });
    const crossProjectResults = await knowledge.search("proration formula", 10, {
      repository: false,
      includeProjects: ["beta"],
    });

    expect(defaultResults).toEqual([]);
    expect(crossProjectResults.map((result) => result.title)).toEqual(["Beta shared"]);
    expect(crossProjectResults[0]).toMatchObject({
      scope: "project",
      projectId: "beta",
      visibility: "shared",
    });
  });

  it("indexes prototype-named terms without corrupting lexical frequencies", async () => {
    const root = await fixtureRoot();
    const knowledge = new LocalKnowledgeBase(fixtureConfig(root));
    await knowledge.upsertText(
      "docs/typescript.md",
      "TypeScript guidance",
      "A constructor should preserve explicit dependency boundaries.",
    );

    const results = await knowledge.search("constructor", 1, { repository: false });

    expect(results[0]?.title).toBe("TypeScript guidance");
  });

  it("indexes Java source documents", async () => {
    const root = await fixtureRoot();
    const source = path.join(root, "docs", "GearChecker.java");
    await writeFile(source, "class GearChecker { void validateArmor() {} }", "utf8");
    const knowledge = new LocalKnowledgeBase(fixtureConfig(root));

    expect(await knowledge.upsertFile(source)).toBe(true);
    expect((await knowledge.search("validateArmor", 1, { repository: false }))[0]?.title)
      .toBe("GearChecker.java");
  });

  it("adds scoped semantic document matches when optional embeddings are enabled", async () => {
    const root = await fixtureRoot();
    const base = fixtureConfig(root);
    const apiKeyEnv = "AGENT_HARNESS_TEST_EMBEDDING_KEY";
    process.env[apiKeyEnv] = "test-key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return new Response(JSON.stringify({
        data: body.input.map((text, index) => ({
          index,
          embedding: text.includes("delivery charge") || text.includes("shipping fee correction")
            ? [1, 0]
            : [0, 1],
        })),
      }), { status: 200 });
    });
    try {
      const knowledge = new LocalKnowledgeBase(fixtureConfig(root, {
        knowledge: {
          ...base.knowledge,
          projectId: "alpha",
          embeddings: {
            ...base.knowledge.embeddings,
            enabled: true,
            endpoint: "https://embeddings.test/v1/embeddings",
            apiKeyEnv,
            minSimilarity: 0.5,
          },
        },
      }));
      await knowledge.upsertText(
        "alpha/billing.md",
        "Billing adjustments",
        "A delivery charge adjustment is issued after carrier disputes.",
      );
      await knowledge.upsertText(
        "beta/private.md",
        "Private beta billing",
        "A delivery charge adjustment is only for the beta project.",
        { projectId: "beta", visibility: "private" },
      );

      const results = await knowledge.search("shipping fee correction", 5, { repository: false });

      expect(results.map((result) => result.title)).toContain("Billing adjustments");
      expect(results.map((result) => result.title)).not.toContain("Private beta billing");
      const index = JSON.parse(
        await readFile(path.join(root, ".agent-harness", "knowledge", "embeddings.json"), "utf8"),
      ) as { model: string; entries: unknown[] };
      expect(index.model).toBe("text-embedding-3-small");
      expect(index.entries.length).toBeGreaterThanOrEqual(2);
    } finally {
      fetchMock.mockRestore();
      delete process.env[apiKeyEnv];
    }
  });

  it("uses Ollama's local embedding protocol without an API key", async () => {
    const root = await fixtureRoot();
    const base = fixtureConfig(root);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      return new Response(JSON.stringify({
        embeddings: body.input.map((text) =>
          text.includes("order cancellation") || text.includes("void a purchase") ? [1, 0] : [0, 1],
        ),
      }), { status: 200 });
    });
    try {
      const knowledge = new LocalKnowledgeBase(fixtureConfig(root, {
        knowledge: {
          ...base.knowledge,
          embeddings: {
            ...base.knowledge.embeddings,
            enabled: true,
            provider: "ollama",
            endpoint: "http://localhost:11434/api/embed",
            model: "qwen3-embedding",
            minSimilarity: 0.5,
          },
        },
      }));
      await knowledge.upsertText(
        "docs/orders.md",
        "Order cancellation",
        "An order cancellation releases the payment authorization.",
      );

      const results = await knowledge.search("how do I void a purchase", 1, { repository: false });

      expect(results[0]?.title).toBe("Order cancellation");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("selects only role- and path-applicable rules and skills", async () => {
    const root = await fixtureRoot();
    const knowledge = new LocalKnowledgeBase(fixtureConfig(root));
    await knowledge.upsertText(
      "General/rules/typescript.mdc",
      "TypeScript rule",
      "---\ndescription: TypeScript implementation guidance\nglobs: src/**/*.{ts,tsx}\nalwaysApply: true\n---\n\nUse explicit TypeScript boundaries.",
      { scope: "global" },
    );
    await knowledge.upsertText(
      "General/rules/java.mdc",
      "Java rule",
      "---\ndescription: Java implementation guidance\nglobs: src/**/*.java\n---\n\nUse Java braces.",
      { scope: "global" },
    );
    await knowledge.upsertText(
      "General/skills/tdd/SKILL.md",
      "TDD",
      "---\nname: tdd\ndescription: Test-first behavior\nroles: [test-writer]\n---\n\nWrite a failing behavioral test first.",
      { scope: "global" },
    );

    const implementation = await knowledge.selectGuidance("implement TypeScript behavior", {
      role: "implementer",
      knownPaths: ["src/feature.ts"],
    });
    const testWriting = await knowledge.selectGuidance("write a behavioral test", {
      role: "test-writer",
    });

    expect(implementation.map((item) => item.source)).toEqual(["General/rules/typescript.mdc"]);
    expect(implementation[0]).toMatchObject({ kind: "rule" });
    expect(implementation[0]?.reason).toContain("path matches");
    expect(testWriting.map((item) => item.source)).toEqual(["General/skills/tdd/SKILL.md"]);
    expect(testWriting[0]).toMatchObject({ kind: "skill" });
  });

  it("prioritizes relevant always-apply guidance, respects budgets, and excludes guidance from generic context", async () => {
    const root = await fixtureRoot();
    const knowledge = new LocalKnowledgeBase(fixtureConfig(root));
    await knowledge.upsertText(
      "General/rules/priority.mdc",
      "Priority rule",
      "---\ndescription: login validation\nalwaysApply: true\n---\n\nlogin validation must reject blank credentials.",
      { scope: "global" },
    );
    await knowledge.upsertText(
      "General/rules/normal.mdc",
      "Normal rule",
      "---\ndescription: login validation\n---\n\nlogin validation should be clear.",
      { scope: "global" },
    );
    await knowledge.upsertText(
      "docs/login.md",
      "Login docs",
      "The login endpoint validates credentials.",
    );

    const selected = await knowledge.selectGuidance("login validation", {
      role: "implementer",
      maxResults: 2,
      maxCharacters: 35,
    });
    const generic = await knowledge.search("login validation", 10, {
      repository: false,
      excludeGuidance: true,
    });

    expect(selected[0]?.source).toBe("General/rules/priority.mdc");
    expect(selected.reduce((total, item) => total + item.excerpt.length, 0)).toBeLessThanOrEqual(35);
    expect(generic.map((item) => item.source)).toEqual(["docs/login.md"]);
  });

  it("excludes disable-model-invocation skills and reviewer-only code-review from fixer selection", async () => {
    const root = await fixtureRoot();
    const knowledge = new LocalKnowledgeBase(fixtureConfig(root));
    await knowledge.upsertText(
      "General/skills/implement-auto/SKILL.md",
      "implement-auto",
      [
        "---",
        "name: implement-auto",
        "description: Review failed recovery orchestration for chat entrypoints",
        "disable-model-invocation: true",
        "---",
        "",
        "Review failed. Emit ## Standards and ## Spec markdown for the recovery plan.",
      ].join("\n"),
      { scope: "global" },
    );
    await knowledge.upsertText(
      "General/skills/code-review/SKILL.md",
      "code-review",
      [
        "---",
        "name: code-review",
        "description: Review failed Standards and Spec checks after test writer failures",
        "roles: [reviewer]",
        "---",
        "",
        "Review failed. Report ## Standards and ## Spec findings side by side.",
      ].join("\n"),
      { scope: "global" },
    );

    const failureQuery = "Review failed. Test writer misclassified test paths.";
    const fixerSelected = await knowledge.selectGuidance(failureQuery, { role: "fixer" });
    expect(fixerSelected.map((item) => item.source)).toEqual([]);

    const reviewerSelected = await knowledge.selectGuidance(failureQuery, { role: "reviewer" });
    expect(reviewerSelected.map((item) => item.source)).toEqual([
      "General/skills/code-review/SKILL.md",
    ]);
    expect(reviewerSelected.map((item) => item.source)).not.toContain(
      "General/skills/implement-auto/SKILL.md",
    );
  });

  it("does not select shared guidance from another project without explicit inclusion", async () => {
    const root = await fixtureRoot();
    const base = fixtureConfig(root);
    const knowledge = new LocalKnowledgeBase(
      fixtureConfig(root, { knowledge: { ...base.knowledge, projectId: "alpha" } }),
    );
    await knowledge.upsertText(
      "beta/rules/security.mdc",
      "Beta security",
      "---\ndescription: payment authorization\n---\n\npayment authorization requires an audit trail.",
      { projectId: "beta", visibility: "shared" },
    );

    expect(await knowledge.selectGuidance("payment authorization", { role: "reviewer" })).toEqual([]);
    expect(
      (await knowledge.selectGuidance("payment authorization", {
        role: "reviewer",
        includeProjects: ["beta"],
      })).map((item) => item.source),
    ).toEqual(["beta/rules/security.mdc"]);
  });

  it("audits relevantly omitted always-apply rules without injecting them", async () => {
    const root = await fixtureRoot();
    const knowledge = new LocalKnowledgeBase(fixtureConfig(root));
    await knowledge.upsertText(
      "General/rules/a.mdc",
      "First rule",
      "---\ndescription: authorization\nalwaysApply: true\n---\n\nauthorization is required.",
      { scope: "global" },
    );
    await knowledge.upsertText(
      "General/rules/b.mdc",
      "Second rule",
      "---\ndescription: authorization\nalwaysApply: true\n---\n\nauthorization must be logged.",
      { scope: "global" },
    );

    const audit = await knowledge.selectGuidanceWithAudit("authorization", {
      role: "implementer",
      maxResults: 1,
    });

    expect(audit.selected).toHaveLength(1);
    expect(audit.omittedAlwaysApply).toEqual([
      expect.objectContaining({
        source: audit.selected[0]?.source === "General/rules/a.mdc"
          ? "General/rules/b.mdc"
          : "General/rules/a.mdc",
        reason: "lower-ranked or omitted by the guidance budget",
      }),
    ]);
    expect(audit.omittedOverrides).toEqual([]);
  });

  it("prefers project-scope guidance and overrides same-name global entries", async () => {
    const root = await fixtureRoot();
    const knowledge = new LocalKnowledgeBase(fixtureConfig(root));
    await knowledge.upsertText(
      "agent-harness/guidance/General/rules/no-legacy-fallback-code.mdc",
      "Global no-legacy",
      "---\ndescription: authorization fallback guidance\nalwaysApply: true\n---\n\nglobal authorization fallback text.",
      { scope: "global" },
    );
    await knowledge.upsertText(
      "project/rules/no-legacy-fallback-code.mdc",
      "Project no-legacy",
      "---\ndescription: authorization fallback guidance\nalwaysApply: true\n---\n\nproject authorization fallback text.",
      { scope: "project" },
    );
    await knowledge.upsertText(
      "agent-harness/guidance/General/skills/tdd/SKILL.md",
      "Global TDD",
      "---\nname: tdd\ndescription: authorization tests\nroles: [test-writer]\n---\n\nglobal authorization test skill.",
      { scope: "global" },
    );
    await knowledge.upsertText(
      "project/skills/tdd/SKILL.md",
      "Project TDD",
      "---\nname: tdd\ndescription: authorization tests\nroles: [test-writer]\n---\n\nproject authorization test skill.",
      { scope: "project" },
    );

    const implementer = await knowledge.selectGuidanceWithAudit("authorization fallback", {
      role: "implementer",
    });
    expect(implementer.selected.map((item) => item.source)).toEqual([
      "project/rules/no-legacy-fallback-code.mdc",
    ]);
    expect(implementer.selected[0]?.reason).toContain("project scope");
    expect(implementer.omittedOverrides).toEqual([
      expect.objectContaining({
        source: "agent-harness/guidance/General/rules/no-legacy-fallback-code.mdc",
        reason: "overridden by project guidance",
      }),
    ]);

    const testWriter = await knowledge.selectGuidanceWithAudit("authorization tests", {
      role: "test-writer",
    });
    expect(testWriter.selected.map((item) => item.source)).toContain("project/skills/tdd/SKILL.md");
    expect(testWriter.selected.map((item) => item.source)).not.toContain(
      "agent-harness/guidance/General/skills/tdd/SKILL.md",
    );
    expect(testWriter.omittedOverrides).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "agent-harness/guidance/General/skills/tdd/SKILL.md",
          reason: "overridden by project guidance",
        }),
      ]),
    );
  });

  it("uses authoritative agent assignments with project override and General fallback", async () => {
    const root = await fixtureRoot();
    const knowledge = new LocalKnowledgeBase(fixtureConfig(root));
    await knowledge.upsertText(
      "General/skills/tdd/SKILL.md",
      "Global TDD",
      "---\nname: tdd\ndescription: test workflow\ndisable-model-invocation: true\n---\n\nglobal tdd guidance",
      { scope: "global" },
    );
    await knowledge.upsertText(
      "project/skills/tdd/SKILL.md",
      "Project TDD",
      "---\nname: tdd\ndescription: project test workflow\n---\n\nproject tdd guidance",
      { scope: "project" },
    );
    await knowledge.upsertText(
      "General/rules/no-legacy-fallback-code.mdc",
      "No legacy",
      "---\ndescription: compatibility rule\n---\n\nremove compatibility paths",
      { scope: "global" },
    );
    await knowledge.upsertText(
      "General/skills/diagnose/SKILL.md",
      "Diagnose",
      "---\nname: diagnose\ndescription: debugging\n---\n\ndiagnose failures",
      { scope: "global" },
    );

    const audit = await knowledge.selectGuidanceWithAudit("unrelated words", {
      role: "test-writer",
      assignment: {
        rules: ["no-legacy-fallback-code"],
        skills: ["tdd"],
      },
    });

    expect(audit.selected.map((item) => item.source)).toEqual([
      "project/skills/tdd/SKILL.md",
      "General/rules/no-legacy-fallback-code.mdc",
    ]);
    expect(audit.selected.every((item) => item.reason.includes("agent assignment"))).toBe(true);
    expect(audit.selected.map((item) => item.source)).not.toContain("General/skills/diagnose/SKILL.md");
    expect(audit.omittedOverrides).toEqual([
      expect.objectContaining({ source: "General/skills/tdd/SKILL.md" }),
    ]);
    expect(audit.missingAssignments).toEqual([]);

    await expect(knowledge.selectGuidance("debug failure", {
      role: "fixer",
      assignment: { rules: [], skills: [] },
    })).resolves.toEqual([]);

    const missing = await knowledge.selectGuidanceWithAudit("anything", {
      role: "fixer",
      assignment: { rules: ["does-not-exist"], skills: [] },
    });
    expect(missing.missingAssignments).toEqual([
      expect.objectContaining({ kind: "rule", name: "does-not-exist" }),
    ]);
  });

  it("filters leftover run artifact chunks so only the active runId can retrieve them", async () => {
    const root = await fixtureRoot();
    const knowledge = new LocalKnowledgeBase(fixtureConfig(root));
    await knowledge.upsertText(
      ".agent-harness/runs/run-a/map.md",
      "map.md",
      "# Map A\n\nDestination: Quiet interface for run A.\n",
    );
    await knowledge.upsertText(
      ".agent-harness/runs/run-b/map.md",
      "map.md",
      "# Map B\n\nDestination: Quiet interface for run B.\n",
    );
    await knowledge.upsertText(
      "docs/guide.md",
      "guide.md",
      "# Guide\n\nQuiet interface design notes live here.\n",
    );

    const withoutRun = await knowledge.search("Quiet interface", 10, { repository: false });
    expect(withoutRun.every((result) => !result.source.includes(".agent-harness/runs/"))).toBe(true);
    expect(withoutRun.some((result) => result.source === "docs/guide.md")).toBe(true);

    const forA = await knowledge.search("Quiet interface", 10, {
      repository: false,
      runId: "run-a",
    });
    expect(forA.some((result) => result.source === ".agent-harness/runs/run-a/map.md")).toBe(true);
    expect(forA.some((result) => result.source === ".agent-harness/runs/run-b/map.md")).toBe(false);

    const forB = await knowledge.search("Quiet interface", 10, {
      repository: false,
      runId: "run-b",
    });
    expect(forB.some((result) => result.source === ".agent-harness/runs/run-b/map.md")).toBe(true);
    expect(forB.some((result) => result.source === ".agent-harness/runs/run-a/map.md")).toBe(false);
  });

  it("ranks multi-term chunks above repeated single-term chunks after IDF dedupe", async () => {
    const root = await fixtureRoot();
    await writeFile(
      path.join(root, "docs", "repeated.md"),
      "# Repeated\n\nSettlementWindow SettlementWindow SettlementWindow only.\n",
      "utf8",
    );
    await writeFile(
      path.join(root, "docs", "diverse.md"),
      "# Diverse\n\nSettlementWindow refund ledger closes midnight.\n",
      "utf8",
    );
    const knowledge = new LocalKnowledgeBase(fixtureConfig(root, {
      knowledge: {
        ...fixtureConfig(root).knowledge,
        relevanceFloor: 0,
        minLexicalScore: 0,
        maxChunksPerSource: 2,
        maxForTopSource: 2,
      },
    }));
    await knowledge.refresh();

    const results = await knowledge.search(
      "SettlementWindow SettlementWindow SettlementWindow refund ledger",
      2,
      { repository: false },
    );
    expect(results[0]?.source).toBe("docs/diverse.md");
  });

  it("refuses weak lexical crumbs instead of padding to the requested limit", async () => {
    const root = await fixtureRoot();
    await writeFile(
      path.join(root, "docs", "settlement.md"),
      "# SettlementWindow\n\nSettlementWindow closes the ledger at midnight and records refunds against the original ledger entry.\n",
      "utf8",
    );
    await writeFile(
      path.join(root, "docs", "profiles.md"),
      "# Profiles\n\nA display name belongs to a user profile. The ledger label is cosmetic only.\n",
      "utf8",
    );
    await writeFile(
      path.join(root, "docs", "colors.md"),
      "# Colors\n\nTheme tokens mention ledger accents only in passing.\n",
      "utf8",
    );
    const knowledge = new LocalKnowledgeBase(fixtureConfig(root));
    await knowledge.refresh();

    const results = await knowledge.search("SettlementWindow refunds ledger", 6, {
      repository: false,
    });

    expect(results.map((result) => result.source)).toEqual(["docs/settlement.md"]);
    expect(results).toHaveLength(1);
  });

  it("diversifies results so one noisy source cannot fill every slot", async () => {
    const root = await fixtureRoot();
    const longDoc = Array.from({ length: 8 }, (_, index) =>
      `## Part ${index}\n\nSettlementWindow refund ledger chunk ${index} with unique padding words abc${index}.\n`,
    ).join("\n");
    await writeFile(path.join(root, "docs", "settlement.md"), `# Settlement\n\n${longDoc}`, "utf8");
    await writeFile(
      path.join(root, "docs", "billing.md"),
      "# Billing\n\nSettlementWindow refund ledger also appears in billing notes.\n",
      "utf8",
    );
    const base = fixtureConfig(root);
    const knowledge = new LocalKnowledgeBase(fixtureConfig(root, {
      knowledge: {
        ...base.knowledge,
        chunkCharacters: 120,
        maxChunksPerSource: 1,
      },
    }));
    await knowledge.refresh();

    const results = await knowledge.search("SettlementWindow refund ledger", 4, {
      repository: false,
    });

    const sources = results.map((result) => result.source);
    // Top source may contribute two chunks; other sources remain capped at one.
    expect(sources.filter((source) => source === "docs/settlement.md").length).toBeLessThanOrEqual(2);
    expect(sources.filter((source) => source === "docs/settlement.md").length).toBeGreaterThanOrEqual(1);
    expect(sources).toContain("docs/billing.md");
    expect(sources.filter((source) => source === "docs/billing.md")).toHaveLength(1);
  });

  it("does not let hybrid RRF revive lexical hits rejected by the floor", async () => {
    const root = await fixtureRoot();
    const base = fixtureConfig(root);
    const apiKeyEnv = "AGENT_HARNESS_TEST_FLOOR_KEY";
    process.env[apiKeyEnv] = "test-key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return new Response(JSON.stringify({
        data: body.input.map((text, index) => ({
          index,
          embedding: text.includes("Theme tokens") || text.includes("SettlementWindow refunds")
            ? [1, 0]
            : [0, 1],
        })),
      }), { status: 200 });
    });
    try {
      await writeFile(
        path.join(root, "docs", "settlement.md"),
        "# SettlementWindow\n\nSettlementWindow closes the ledger and records refunds against the original ledger entry.\n",
        "utf8",
      );
      await writeFile(
        path.join(root, "docs", "colors.md"),
        "# Colors\n\nTheme tokens mention ledger accents only in passing.\n",
        "utf8",
      );
      const knowledge = new LocalKnowledgeBase(fixtureConfig(root, {
        knowledge: {
          ...base.knowledge,
          embeddings: {
            ...base.knowledge.embeddings,
            enabled: true,
            endpoint: "https://embeddings.test/v1/embeddings",
            apiKeyEnv,
            minSimilarity: 0.1,
          },
        },
      }));
      await knowledge.refresh();

      const { results, audit } = await knowledge.searchWithAudit(
        "SettlementWindow refunds ledger",
        6,
        { repository: false },
      );

      expect(results.map((result) => result.source)).toEqual(["docs/settlement.md"]);
      expect(audit.omitted.some((item) =>
        item.source === "docs/colors.md" &&
        (item.reason === "below-floor" || item.reason === "below-min-lexical")
      )).toBe(true);
    } finally {
      fetchMock.mockRestore();
      delete process.env[apiKeyEnv];
    }
  });

  it("omits weak semantic-only candidates below minSemanticOnlySimilarity", async () => {
    const root = await fixtureRoot();
    const base = fixtureConfig(root);
    const apiKeyEnv = "AGENT_HARNESS_TEST_SEM_ONLY_KEY";
    process.env[apiKeyEnv] = "test-key";
    const weak = [0.4, Math.sqrt(1 - 0.4 ** 2)];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return new Response(JSON.stringify({
        data: body.input.map((text, index) => ({
          index,
          embedding:
            text.includes("SettlementWindow") || text.includes("SettlementWindow refunds")
              ? [1, 0]
              : weak,
        })),
      }), { status: 200 });
    });
    try {
      await writeFile(
        path.join(root, "docs", "settlement.md"),
        "# SettlementWindow\n\nSettlementWindow closes the ledger and records refunds.\n",
        "utf8",
      );
      await writeFile(
        path.join(root, "docs", "palette.md"),
        "# Palette\n\nTheme tokens define accent colors for the dashboard chrome.\n",
        "utf8",
      );
      const knowledge = new LocalKnowledgeBase(fixtureConfig(root, {
        knowledge: {
          ...base.knowledge,
          embeddings: {
            ...base.knowledge.embeddings,
            enabled: true,
            endpoint: "https://embeddings.test/v1/embeddings",
            apiKeyEnv,
            minSimilarity: 0.3,
            minSemanticOnlySimilarity: 0.45,
          },
        },
      }));
      await knowledge.refresh();

      const results = await knowledge.search("SettlementWindow refunds", 6, {
        repository: false,
      });

      expect(results.map((result) => result.source)).toEqual(["docs/settlement.md"]);
      expect(results[0]?.score).toBeGreaterThan(0.4);
    } finally {
      fetchMock.mockRestore();
      delete process.env[apiKeyEnv];
    }
  });

  it("still fuses lexical hits with semantic evidence under the semantic-only gate", async () => {
    const root = await fixtureRoot();
    const base = fixtureConfig(root);
    const apiKeyEnv = "AGENT_HARNESS_TEST_FUSE_KEY";
    process.env[apiKeyEnv] = "test-key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return new Response(JSON.stringify({
        data: body.input.map((text, index) => ({
          index,
          embedding:
            text.includes("delivery charge") || text.includes("carrier dispute refund")
              ? [1, 0]
              : [0, 1],
        })),
      }), { status: 200 });
    });
    try {
      const knowledge = new LocalKnowledgeBase(fixtureConfig(root, {
        knowledge: {
          ...base.knowledge,
          embeddings: {
            ...base.knowledge.embeddings,
            enabled: true,
            endpoint: "https://embeddings.test/v1/embeddings",
            apiKeyEnv,
            minSimilarity: 0.3,
            minSemanticOnlySimilarity: 0.45,
          },
        },
      }));
      await knowledge.upsertText(
        "docs/billing.md",
        "Billing adjustments",
        "A delivery charge adjustment is issued after carrier disputes.",
      );
      await knowledge.upsertText(
        "docs/unrelated.md",
        "Unrelated theme",
        "Dashboard chrome palette tokens define accent colors only.",
      );

      const results = await knowledge.search("carrier dispute refund delivery charge", 5, {
        repository: false,
      });

      expect(results.map((result) => result.title)).toEqual(["Billing adjustments"]);
      // Lexical + semantic dual-channel normalized RRF, not raw ~0.016.
      expect(results[0]?.score).toBeCloseTo(1, 1);
    } finally {
      fetchMock.mockRestore();
      delete process.env[apiKeyEnv];
    }
  });

  it("records Graphify skips in the retrieval audit", async () => {
    const root = await fixtureRoot();
    const lookup: RepositoryLookup = {
      async refresh() {},
      async rebuild() { return true; },
      async search() {
        return {
          shapedQuery: "",
          usedFallback: true,
          skippedReason: "generic-query",
        };
      },
    };
    await writeFile(
      path.join(root, "docs", "settlement.md"),
      "# SettlementWindow\n\nSettlementWindow closes the ledger.\n",
      "utf8",
    );
    const knowledge = new LocalKnowledgeBase(fixtureConfig(root), lookup);
    await knowledge.refresh();

    const { results, audit } = await knowledge.searchWithAudit("SettlementWindow ledger", 3);

    expect(results.every((result) => !result.source.startsWith("graphify:"))).toBe(true);
    expect(audit.graphify).toMatchObject({
      included: false,
      skippedReason: "generic-query",
      usedFallback: true,
    });
    expect(audit.omitted.some((item) => item.reason === "graphify-skipped")).toBe(true);
  });
});
