import path from "node:path";
import { resolveHarnessPaths } from "../../src/application/paths.js";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { AgentCoordinator } from "../../src/infrastructure/agents/agent-coordinator.js";
import { createFakeBackend } from "../../src/infrastructure/agents/fake-backend.js";
import type { RepositoryLookup } from "../../src/codegraph.js";
import { compactDomainSeed, LocalKnowledgeBase } from "../../src/knowledge.js";
import { WorkerOutputSchema, createRunState } from "../../src/domain.js";
import { RunStore } from "../../src/store.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

describe("compactDomainSeed", () => {
  it("keeps distinctive domain tokens and drops harness meta-language", () => {
    const seed = compactDomainSeed(
      "objective acceptance criteria",
      "Ship QuietGreetingBanner with SettlementWindow refunds",
    );
    expect(seed).toContain("QuietGreetingBanner");
    expect(seed).toContain("SettlementWindow");
    expect(seed.toLowerCase()).not.toContain("objective");
    expect(seed.toLowerCase()).not.toContain("acceptance");
  });
});

describe("decision knowledge query composition", () => {
  it("includes destination and a bounded idea seed", () => {
    const destination = "Ship QuietGreetingBanner";
    const idea = "Add a QuietGreetingBanner next to SettlementWindow";
    const title = "Choose a player-facing name";
    const question = "What should users see?";
    const knowledgeQuery = [
      destination,
      title,
      question,
      compactDomainSeed(idea, destination)]
      .filter(Boolean)
      .join(" ");

    expect(knowledgeQuery).toContain(destination);
    expect(knowledgeQuery).toContain(title);
    expect(knowledgeQuery).toContain("QuietGreetingBanner");
    expect(knowledgeQuery).toContain("SettlementWindow");
  });
});

describe("retrieval audit artifact", () => {
  it("omits retrieval and selected guidance for bounded invocations", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      agent: { promptBuilder: false } as never,
      knowledge: {
        ...fixtureConfig(root).knowledge,
        codegraph: { ...fixtureConfig(root).knowledge.codegraph, enabled: false }}});
    const store = new RunStore(config, resolveHarnessPaths(config).stateRoot);
    await store.initialize();
    const knowledge = new LocalKnowledgeBase(config);
    await knowledge.refresh();
    const runId = "retrieval-disabled-run";
    await store.create(createRunState(runId, "Apply approved recovery", new Date().toISOString()));
    const agents = new AgentCoordinator(
      config,
      createFakeBackend({
        fixer: () => ({ summary: "Applied the bounded recovery.", changedFiles: [] })}),
      store,
      knowledge,
    );

    await agents.invoke({
      runId,
      role: "fixer",
      objective: "Apply the approved recovery plan",
      input: { approvedPlan: { summary: "Update agent-harness.config.yaml" } },
      constraints: ["Do not search the repository broadly."],
      expectedOutput: "{summary,changedFiles}",
      schema: WorkerOutputSchema,
      retrieval: false,
      buildPrompt: false});

    const files = await store.listFiles(runId, "packets");
    const packetPath = files.find(
      (file) => file.endsWith(".json") && !file.endsWith(".retrieval.json") && !file.endsWith(".guidance.json"),
    );
    const retrievalPath = files.find((file) => file.endsWith(".retrieval.json"));
    const packet = (await store.readJson(runId, packetPath!)) as {
      guidance: unknown[];
      context: unknown[];
    };
    const retrieval = (await store.readJson(runId, retrievalPath!)) as {
      retrieval: { skipped?: string; codegraph: { skippedReason?: string } };
    };

    expect(packet.guidance).toEqual([]);
    expect(packet.context).toEqual([]);
    expect(retrieval.retrieval.skipped).toBe("retrieval-disabled");
    expect(retrieval.retrieval.codegraph.skippedReason).toBe("retrieval-disabled");
  });

  it("persists packets/*.retrieval.json and avoids padding with below-floor junk", async () => {
    const root = await fixtureRoot();
    await writeFile(
      path.join(root, "docs", "settlement.md"),
      "# SettlementWindow\n\nSettlementWindow closes the ledger and records refunds.\n",
      "utf8",
    );
    await writeFile(
      path.join(root, "docs", "colors.md"),
      "# Colors\n\nTheme tokens mention ledger accents only in passing.\n",
      "utf8",
    );
    const config = fixtureConfig(root, {
      agent: { promptBuilder: false } as never,
      knowledge: {
        ...fixtureConfig(root).knowledge,
        codegraph: { ...fixtureConfig(root).knowledge.codegraph, enabled: false }}});
    const store = new RunStore(config, resolveHarnessPaths(config).stateRoot);
    await store.initialize();
    const knowledge = new LocalKnowledgeBase(config);
    await knowledge.refresh();
    const runId = "retrieval-audit-run";
    await store.create(
      createRunState(runId, "Build SettlementWindow refunds", new Date().toISOString()),
    );
    const agents = new AgentCoordinator(
      config,
      createFakeBackend({
        implementer: () => ({ summary: "done", changedFiles: [] })}),
      store,
      knowledge,
    );

    await agents.invoke({
      runId,
      role: "implementer",
      objective: "Implement SettlementWindow refunds",
      input: {
        task: {
          title: "SettlementWindow refunds",
          description: "Close the ledger",
          acceptanceCriteria: ["Refunds reuse the original ledger entry"]}},
      expectedOutput: "{summary,changedFiles}",
      schema: WorkerOutputSchema,
      knowledgeQuery: "SettlementWindow refunds ledger",
      knowledgeFallbackQuery: compactDomainSeed("Build SettlementWindow refunds")});

    const packetFiles = await store.listFiles(runId, "packets");
    const retrievalPath = packetFiles.find((file) => file.endsWith(".retrieval.json"));
    const packetPath = packetFiles.find(
      (file) => file.endsWith(".json") && !file.endsWith(".retrieval.json") && !file.endsWith(".guidance.json"),
    );
    expect(retrievalPath).toBeDefined();
    expect(packetPath).toBeDefined();

    const artifact = (await store.readJson(runId, retrievalPath!)) as {
      retrieval: {
        query: string;
        kept: Array<{ source: string; score: number }>;
        omitted: Array<{ source: string; reason: string }>;
        codegraph: { included: boolean };
      };
      budget: { truncations: unknown[] };
    };
    const packet = (await store.readJson(runId, packetPath!)) as {
      context: Array<{ source: string }>;
    };

    expect(artifact.retrieval.query).toContain("SettlementWindow");
    expect(artifact.retrieval.kept.map((item) => item.source)).toEqual(["docs/settlement.md"]);
    expect(packet.context.map((item) => item.source)).toEqual(["docs/settlement.md"]);
    expect(packet.context).toHaveLength(1);
    expect(artifact.retrieval.codegraph.included).toBe(false);
    expect(artifact.retrieval.omitted.some((item) => item.source === "docs/colors.md")).toBe(true);
    expect(artifact.budget).toBeDefined();
  });

  it("honors the RAG/CodeGraph independence matrix while keeping guidance", async () => {
    const root = await fixtureRoot();
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(
      path.join(root, "docs", "settlement.md"),
      "# SettlementWindow\n\nSettlementWindow closes the ledger and records refunds.\n",
      "utf8",
    );
    const sharedRoot = path.join(root, "guidance-shared");
    await mkdir(path.join(sharedRoot, "General", "skills", "tdd"), { recursive: true });
    await writeFile(
      path.join(sharedRoot, "General", "skills", "tdd", "SKILL.md"),
      "---\nname: tdd\ndescription: write tests first\n---\n\nPrefer red-green for SettlementWindow changes.\n",
      "utf8",
    );
    const base = fixtureConfig(root);
    const codegraphHit = {
      source: "codegraph:.codegraph",
      title: "Repository relationships (CodeGraph)",
      excerpt: "SettlementWindow -> Ledger",
      score: 1};
    const lookup: RepositoryLookup = {
      async refresh() {},
      async rebuild() {
        return true;
      },
      async search() {
        return {
          shapedQuery: "SettlementWindow",
          usedFallback: false,
          result: codegraphHit};
      }};

    async function invokeWith(options: { rag: boolean; codegraph: boolean }) {
      const config = fixtureConfig(root, {
        agent: { promptBuilder: false } as never,
        workflow: { ...base.workflow, rag: options.rag } as never,
        knowledge: {
          ...base.knowledge,
          codegraph: { ...base.knowledge.codegraph, enabled: options.codegraph },
          guidance: {
            ...base.knowledge.guidance,
            enabled: true,
            sharedRoot,
            assignments: {
              ...base.knowledge.guidance.assignments,
              implementer: { rules: [], skills: ["tdd"] }}}}});
      const store = new RunStore(config, resolveHarnessPaths(config).stateRoot);
      await store.initialize();
      const knowledge = new LocalKnowledgeBase(config, lookup, undefined, { sharedRoot });
      await knowledge.refresh();
      const runId = `matrix-${options.rag ? "rag" : "norag"}-${options.codegraph ? "g" : "nog"}`;
      await store.create(createRunState(runId, "Build SettlementWindow", new Date().toISOString()));
      const agents = new AgentCoordinator(
        config,
        createFakeBackend({
          implementer: () => ({ summary: "done", changedFiles: [] })}),
        store,
        knowledge,
      );
      await agents.invoke({
        runId,
        role: "implementer",
        objective: "Implement SettlementWindow refunds",
        input: {
          task: {
            title: "SettlementWindow refunds",
            description: "Close the ledger",
            acceptanceCriteria: ["Refunds reuse the original ledger entry"],
            affectedPaths: ["src/settlement.ts"]}},
        expectedOutput: "{summary,changedFiles}",
        schema: WorkerOutputSchema,
        knowledgeQuery: "SettlementWindow refunds ledger"});
      const files = await store.listFiles(runId, "packets");
      const packetPath = files.find(
        (file) =>
          file.endsWith(".json") &&
          !file.endsWith(".retrieval.json") &&
          !file.endsWith(".guidance.json"),
      );
      const retrievalPath = files.find((file) => file.endsWith(".retrieval.json"));
      const packet = (await store.readJson(runId, packetPath!)) as {
        guidance: unknown[];
        context: Array<{ source: string }>;
      };
      const retrieval = (await store.readJson(runId, retrievalPath!)) as {
        retrieval: { skipped?: string; codegraph: { included: boolean } };
      };
      return { packet, retrieval };
    }

    const bothOn = await invokeWith({ rag: true, codegraph: true });
    expect(bothOn.packet.guidance.length).toBeGreaterThan(0);
    expect(bothOn.packet.context.some((item) => item.source === "docs/settlement.md")).toBe(true);
    expect(bothOn.packet.context.some((item) => item.source.startsWith("codegraph:"))).toBe(true);

    const docsOnly = await invokeWith({ rag: true, codegraph: false });
    expect(docsOnly.packet.guidance.length).toBeGreaterThan(0);
    expect(docsOnly.packet.context.every((item) => !item.source.startsWith("codegraph:"))).toBe(true);
    expect(docsOnly.packet.context.some((item) => item.source === "docs/settlement.md")).toBe(true);

    const codegraphOnly = await invokeWith({ rag: false, codegraph: true });
    expect(codegraphOnly.packet.guidance.length).toBeGreaterThan(0);
    expect(codegraphOnly.packet.context.map((item) => item.source)).toEqual([
      "codegraph:.codegraph"]);
    expect(codegraphOnly.retrieval.retrieval.skipped).toBe("rag-disabled");

    const bothOff = await invokeWith({ rag: false, codegraph: false });
    expect(bothOff.packet.guidance.length).toBeGreaterThan(0);
    expect(bothOff.packet.context).toEqual([]);
    expect(bothOff.retrieval.retrieval.skipped).toBe("rag-disabled");
  });
});
