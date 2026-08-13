import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { resolveHarnessPaths } from "../../src/application/paths.js";
import { AgentCoordinator } from "../../src/infrastructure/agents/agent-coordinator.js";
import { createFakeBackend } from "../../src/infrastructure/agents/fake-backend.js";
import {
  HighLevelPlanSchema,
  WorkerOutputSchema,
  createRunState,
  type DomainArtifacts} from "../../src/domain.js";
import { discoverDomainArtifacts } from "../../src/domain/domain-artifacts.js";
import { LocalKnowledgeBase } from "../../src/knowledge.js";
import { RunStore } from "../../src/store.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, "utf8");
  }
}

async function readPacket(store: RunStore, runId: string): Promise<Record<string, unknown>> {
  const files = await store.listFiles(runId, "packets");
  const packetPath = files.find(
    (file) =>
      file.endsWith(".json") &&
      !file.endsWith(".retrieval.json") &&
      !file.endsWith(".guidance.json"),
  );
  expect(packetPath).toBeDefined();
  return (await store.readJson(runId, packetPath!)) as Record<string, unknown>;
}

describe("discoverDomainArtifacts", () => {
  it("collects sorted glossary/ADR paths and prefers a root glossary map", async () => {
    const root = await fixtureRoot();
    await writeTree(root, {
      "GLOSSARY.md": "# Root\n",
      "GLOSSARY-MAP.md": "# Map\n",
      "docs/adr/0001-example.md": "# ADR\n",
      "src/billing/GLOSSARY.md": "# Billing\n",
      "src/ordering/GLOSSARY.md": "# Ordering\n",
      "src/ordering/docs/adr/0001-orders.md": "# Orders ADR\n",
      "nested/elsewhere/GLOSSARY-MAP.md": "# Nested map ignored for preference\n",
      "node_modules/pkg/GLOSSARY.md": "# skip\n",
      "node_modules/pkg/docs/adr/0001.md": "# skip\n",
      "dist/GLOSSARY.md": "# skip\n"});

    const artifacts = await discoverDomainArtifacts(root);

    expect(artifacts).toEqual({
      glossaryMap: "GLOSSARY-MAP.md",
      glossaries: ["GLOSSARY.md", "src/billing/GLOSSARY.md", "src/ordering/GLOSSARY.md"],
      adrDirs: ["docs/adr", "src/ordering/docs/adr"]} satisfies DomainArtifacts);
  });

  it("returns empty lists when nothing is present", async () => {
    const root = await fixtureRoot();
    const artifacts = await discoverDomainArtifacts(root);
    expect(artifacts).toEqual({ glossaries: [], adrDirs: [] });
    expect(artifacts.glossaryMap).toBeUndefined();
  });

  it("skips adr directories that contain no markdown", async () => {
    const root = await fixtureRoot();
    await writeTree(root, {
      "docs/adr/.keep": "",
      "docs/other/readme.md": "# Other\n"});
    const artifacts = await discoverDomainArtifacts(root);
    expect(artifacts.adrDirs).toEqual([]);
  });
});

describe("AgentCoordinator domainArtifacts injection", () => {
  it("includes domainArtifacts for planner (domain-modeling assignment)", async () => {
    const root = await fixtureRoot();
    await writeTree(root, {
      "GLOSSARY.md": "# Root\n",
      "docs/adr/0001-example.md": "# ADR\n"});
    const config = fixtureConfig(root, {
      agent: { promptBuilder: false } as never,
      knowledge: {
        ...fixtureConfig(root).knowledge,
        codegraph: { ...fixtureConfig(root).knowledge.codegraph, enabled: false }}});
    const store = new RunStore(config, resolveHarnessPaths(config).stateRoot);
    await store.initialize();
    const knowledge = new LocalKnowledgeBase(config);
    await knowledge.refresh();
    const runId = "domain-artifacts-planner";
    await store.create(createRunState(runId, "Plan domain feature", new Date().toISOString()));
    const agents = new AgentCoordinator(
      config,
      createFakeBackend({
        planner: () => ({
          summary: "Planned",
          problemStatement: "Need a feature",
          solution: "Ship it",
          approach: "Vertical slice",
          constraints: [],
          outOfScope: [],
          openQuestions: []})}),
      store,
      knowledge,
    );

    await agents.invoke({
      runId,
      role: "planner",
      objective: "Plan domain feature",
      input: { destination: "Ship feature" },
      expectedOutput: "{summary,problemStatement,solution,approach}",
      schema: HighLevelPlanSchema,
      knowledgeQuery: "domain feature glossary",
      retrieval: false,
      buildPrompt: false});

    const packet = await readPacket(store, runId);
    expect(packet.domainArtifacts).toEqual({
      glossaries: ["GLOSSARY.md"],
      adrDirs: ["docs/adr"]});
  });

  it("omits domainArtifacts for implementer (no domain-modeling skill)", async () => {
    const root = await fixtureRoot();
    await writeTree(root, {
      "GLOSSARY.md": "# Root\n",
      "docs/adr/0001-example.md": "# ADR\n"});
    const config = fixtureConfig(root, {
      agent: { promptBuilder: false } as never,
      knowledge: {
        ...fixtureConfig(root).knowledge,
        codegraph: { ...fixtureConfig(root).knowledge.codegraph, enabled: false }}});
    const store = new RunStore(config, resolveHarnessPaths(config).stateRoot);
    await store.initialize();
    const knowledge = new LocalKnowledgeBase(config);
    await knowledge.refresh();
    const runId = "domain-artifacts-implementer";
    await store.create(createRunState(runId, "Implement feature", new Date().toISOString()));
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
      objective: "Implement feature",
      input: {
        task: {
          title: "Feature",
          description: "Do it",
          acceptanceCriteria: ["done"]}},
      expectedOutput: "{summary,changedFiles}",
      schema: WorkerOutputSchema,
      knowledgeQuery: "feature",
      retrieval: false,
      buildPrompt: false});

    const packet = await readPacket(store, runId);
    expect(packet).not.toHaveProperty("domainArtifacts");
  });
});
