import path from "node:path";
import { resolveHarnessPaths } from "../../src/application/paths.js";
import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { AgentCoordinator } from "../../src/infrastructure/agents/agent-coordinator.js";
import { createFakeBackend } from "../../src/infrastructure/agents/fake-backend.js";
import { recentEvidenceOutput } from "../../src/commands.js";
import { createRunState, type BuildTask, type CommandEvidence } from "../../src/domain.js";
import { taskForPacket } from "../../src/application/helpers.js";
import { LocalKnowledgeBase } from "../../src/knowledge.js";
import { buildWorkPacket } from "../../src/packet.js";
import { renderPrompt } from "../../src/prompts.js";
import { RunStore } from "../../src/store.js";
import { WorkerOutputSchema } from "../../src/domain.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

function evidenceEntry(index: number, passed = false): CommandEvidence {
  return {
    purpose: `gate:${index}`,
    command: `echo ${index}`,
    exitCode: passed ? 0 : 1,
    passed,
    stdout: `${"banner noise\n".repeat(20)}ASSERT FAIL stack ${index} ${"x".repeat(19_000)}`,
    stderr: "",
    durationMs: 10,
    at: new Date().toISOString()};
}

describe("recentEvidenceOutput", () => {
  it("returns empty string for no evidence", () => {
    expect(recentEvidenceOutput([])).toBe("");
  });

  it("selects newest-first and keeps failing evidence plus the latest entry", () => {
    const evidence = [
      evidenceEntry(0, true),
      evidenceEntry(1, false),
      evidenceEntry(2, true),
      evidenceEntry(3, true)];
    const rendered = recentEvidenceOutput(evidence, { entries: 2, charactersPerEntry: 500 });
    expect(rendered).toContain("gate:3");
    expect(rendered).toContain("gate:1");
    expect(rendered).not.toContain("gate:0");
  });

  it("tail-slices each entry to the character budget", () => {
    const evidence = [evidenceEntry(0, false)];
    const rendered = recentEvidenceOutput(evidence, { entries: 1, charactersPerEntry: 40 });
    const output = rendered.split("\n").slice(3).join("\n");
    expect(output.length).toBeLessThanOrEqual(40);
    expect(output).toContain("x");
  });
});

describe("buildWorkPacket budgets", () => {
  it("keeps a full-size review diff without input-budget truncation", () => {
    const config = fixtureConfig(".", {});
    const diffBudget = config.workflow.reviewDiffCharacters;
    const diff = `diff --git a/src/a.ts b/src/a.ts\n${"x".repeat(Math.max(0, diffBudget - 40))}`;
    expect(diff.length).toBeLessThanOrEqual(diffBudget);

    const { packet, budgetAudit } = buildWorkPacket({
      invocationId: "inv",
      runId: "run",
      role: "reviewer",
      objective: "review",
      constraints: [],
      input: {
        task: {
          id: "t1",
          title: "Ship feature",
          description: "A short task body",
          acceptanceCriteria: ["works"]},
        changedFiles: ["src/a.ts"],
        commandEvidence: "ok",
        diff,
        diffOmittedFiles: []},
      guidance: [],
      retrievalResults: [],
      priorArtifacts: [],
      expectedOutput: "{approved,summary,findings}",
      createdAt: "2026-08-07T00:00:00.000Z",
      budgets: {
        contextCharacters: config.workflow.contextCharacters,
        inputCharacters: config.workflow.inputCharacters,
        graphifyCharacters: config.workflow.graphifyCharacters}});

    expect((packet.input as { diff: string }).diff).toBe(diff);
    expect(
      budgetAudit.truncations.filter(
        (item) => item.reason === "input-budget" && item.path.includes("diff"),
      ),
    ).toEqual([]);
  });

  it("passes under-budget input through byte-identical", () => {
    const input = { task: { title: "Ship greeting", description: "short" } };
    const { packet, budgetAudit } = buildWorkPacket({
      invocationId: "inv",
      runId: "run",
      role: "implementer",
      objective: "implement",
      constraints: [],
      input,
      guidance: [],
      retrievalResults: [],
      priorArtifacts: [],
      expectedOutput: "{}",
      createdAt: "2026-08-07T00:00:00.000Z",
      budgets: {
        contextCharacters: 12_000,
        inputCharacters: 24_000,
        graphifyCharacters: 3_000}});
    expect(packet.input).toEqual(input);
    expect(budgetAudit.truncations).toEqual([]);
  });

  it("truncates the longest string leaf first and records every path", () => {
    const { packet, budgetAudit } = buildWorkPacket({
      invocationId: "inv",
      runId: "run",
      role: "implementer",
      objective: "implement",
      constraints: [],
      input: {
        short: "abc",
        long: "L".repeat(5_000),
        nested: { mid: "M".repeat(2_000) }},
      guidance: [],
      retrievalResults: [],
      priorArtifacts: [],
      expectedOutput: "{}",
      createdAt: "2026-08-07T00:00:00.000Z",
      budgets: {
        contextCharacters: 12_000,
        inputCharacters: 1_200,
        graphifyCharacters: 3_000}});
    expect(JSON.stringify(packet.input).length).toBeLessThanOrEqual(1_200);
    expect(budgetAudit.truncations.length).toBeGreaterThan(0);
    expect(budgetAudit.truncations[0]?.path).toContain("long");
    expect(budgetAudit.truncations.every((item) => item.reason === "input-budget")).toBe(true);
  });

  it("caps Graphify excerpts before document context fills the budget", () => {
    const { packet, budgetAudit } = buildWorkPacket({
      invocationId: "inv",
      runId: "run",
      role: "implementer",
      objective: "implement",
      constraints: [],
      input: {},
      guidance: [],
      retrievalResults: [
        {
          source: "graphify:graphify-out/graph.json",
          title: "Repository relationships (Graphify)",
          excerpt: "G".repeat(5_000)},
        {
          source: "docs/settlement.md",
          title: "Settlement",
          excerpt: "SettlementWindow refund ledger guidance"}],
      priorArtifacts: [],
      expectedOutput: "{}",
      createdAt: "2026-08-07T00:00:00.000Z",
      budgets: {
        contextCharacters: 12_000,
        inputCharacters: 24_000,
        graphifyCharacters: 3_000}});
    expect(packet.context[0]?.excerpt.length).toBe(3_000);
    expect(packet.context.some((item) => item.source === "docs/settlement.md")).toBe(true);
    expect(budgetAudit.truncations.some((item) => item.reason === "graphify-budget")).toBe(true);
  });

  it("keeps guidance + context + input under the configured sum", () => {
    const guidancePack = "R".repeat(2_000);
    const { packet, budgetAudit } = buildWorkPacket({
      invocationId: "inv",
      runId: "run",
      role: "implementer",
      objective: "implement",
      constraints: [],
      input: { blob: "I".repeat(10_000) },
      guidance: [
        {
          source: "rules/a.mdc",
          title: "A",
          kind: "rule"}],
      guidancePack,
      retrievalResults: [
        { source: "docs/a.md", title: "A", excerpt: "C".repeat(20_000) }],
      priorArtifacts: [],
      expectedOutput: "{}",
      createdAt: "2026-08-07T00:00:00.000Z",
      budgets: {
        contextCharacters: 5_000,
        inputCharacters: 2_000,
        graphifyCharacters: 1_000}});
    expect(budgetAudit.guidanceCharacters + budgetAudit.contextCharacters).toBeLessThanOrEqual(5_000);
    expect(budgetAudit.inputCharacters).toBeLessThanOrEqual(2_000);
    expect(JSON.stringify(packet.input).length).toBeLessThanOrEqual(2_000);
    expect(packet.guidancePack.length).toBe(2_000);
  });
});

describe("implementer packet evidence projection", () => {
  it("keeps rendered prompts under a ceiling while state retains full evidence", async () => {
    const root = await fixtureRoot();
    await writeFile(path.join(root, "docs", "settlement.md"), "# SettlementWindow\n", "utf8");
    const config = fixtureConfig(root, {
      agent: { promptBuilder: false } as never,
      workflow: {
        ...fixtureConfig(root).workflow,
        contextCharacters: 12_000,
        inputCharacters: 24_000,
        graphifyCharacters: 3_000},
      knowledge: {
        ...fixtureConfig(root).knowledge,
        guidance: { enabled: false, maxResults: 0, maxCharacters: 1 },
        graphify: { ...fixtureConfig(root).knowledge.graphify, enabled: false }}});
    const store = new RunStore(config, resolveHarnessPaths(config).stateRoot);
    await store.initialize();
    const knowledge = new LocalKnowledgeBase(config);
    await knowledge.refresh();
    const runId = "packet-budget-run";
    await store.create(createRunState(runId, "Ship SettlementWindow", new Date().toISOString()));

    const evidence = Array.from({ length: 10 }, (_, index) => evidenceEntry(index, index === 9));
    const task: BuildTask = {
      id: "t1",
      title: "SettlementWindow refunds",
      description: "Close the ledger",
      acceptanceCriteria: ["Refunds reuse the original ledger entry"],
      affectedPaths: [],
      blockedBy: [],
      status: "active",
      step: "implementing",
      attempts: { implementation: 2, review: 0 },
      evidence,
      testPaths: ["tests/settlement.test.ts"],
      changedFiles: ["src/settlement.ts"]};

    const agents = new AgentCoordinator(
      config,
      createFakeBackend({
        implementer: (request) => {
          expect(request.prompt.length).toBeLessThan(60_000);
          expect(request.prompt).not.toContain(evidence[0]!.stdout.slice(0, 200));
          return { summary: "ok", changedFiles: ["src/settlement.ts"] };
        }}),
      store,
      knowledge,
    );

    await agents.invoke({
      runId,
      role: "implementer",
      objective: "Implement SettlementWindow refunds",
      input: {
        task: taskForPacket(task),
        verifiedCommandOutput: recentEvidenceOutput(task.evidence)},
      expectedOutput: "{summary,changedFiles}",
      schema: WorkerOutputSchema,
      knowledgeQuery: "SettlementWindow refunds"});

    await store.writeJson(runId, "state.json", {
      ...(await store.load(runId)),
      tasks: [task]});
    const persisted = JSON.parse(
      await readFile(path.join(root, ".agent-harness", "runs", runId, "state.json"), "utf8"),
    ) as { tasks: BuildTask[] };
    expect(persisted.tasks[0]?.evidence).toHaveLength(10);
    expect(persisted.tasks[0]?.evidence[0]?.stdout.length).toBeGreaterThan(15_000);

    const packet = buildWorkPacket({
      invocationId: "x",
      runId,
      role: "implementer",
      objective: "Implement",
      constraints: [],
      input: {
        task: taskForPacket(task),
        verifiedCommandOutput: recentEvidenceOutput(task.evidence)},
      guidance: [],
      retrievalResults: [],
      priorArtifacts: [],
      expectedOutput: "{}",
      createdAt: new Date().toISOString(),
      budgets: {
        contextCharacters: config.workflow.contextCharacters,
        inputCharacters: config.workflow.inputCharacters,
        graphifyCharacters: config.workflow.graphifyCharacters}}).packet;
    expect(renderPrompt(packet).length).toBeLessThan(60_000);
  });
});
