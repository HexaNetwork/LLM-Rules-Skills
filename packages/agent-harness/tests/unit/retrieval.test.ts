import path from "node:path";
import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { AgentCoordinator, createFakeBackend } from "../../src/agent.js";
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
      compactDomainSeed(idea, destination),
    ]
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
        graphify: { ...fixtureConfig(root).knowledge.graphify, enabled: false },
      },
    });
    const store = new RunStore(config);
    await store.initialize();
    const knowledge = new LocalKnowledgeBase(config);
    await knowledge.refresh();
    const runId = "retrieval-disabled-run";
    await store.create(createRunState(runId, "Apply approved recovery", new Date().toISOString()));
    const agents = new AgentCoordinator(
      config,
      createFakeBackend({
        fixer: () => ({ summary: "Applied the bounded recovery.", changedFiles: [] }),
      }),
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
      buildPrompt: false,
    });

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
      retrieval: { skipped?: string; graphify: { skippedReason?: string } };
    };

    expect(packet.guidance).toEqual([]);
    expect(packet.context).toEqual([]);
    expect(retrieval.retrieval.skipped).toBe("retrieval-disabled");
    expect(retrieval.retrieval.graphify.skippedReason).toBe("retrieval-disabled");
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
        graphify: { ...fixtureConfig(root).knowledge.graphify, enabled: false },
      },
    });
    const store = new RunStore(config);
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
        implementer: () => ({ summary: "done", changedFiles: [] }),
      }),
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
        },
      },
      expectedOutput: "{summary,changedFiles}",
      schema: WorkerOutputSchema,
      knowledgeQuery: "SettlementWindow refunds ledger",
      knowledgeFallbackQuery: compactDomainSeed("Build SettlementWindow refunds"),
    });

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
        graphify: { included: boolean };
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
    expect(artifact.retrieval.graphify.included).toBe(false);
    expect(artifact.retrieval.omitted.some((item) => item.source === "docs/colors.md")).toBe(true);
    expect(artifact.budget).toBeDefined();
  });
});
