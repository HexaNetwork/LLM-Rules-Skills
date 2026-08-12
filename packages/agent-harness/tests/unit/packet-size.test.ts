import { describe, expect, it } from "vitest";
import { recentEvidenceOutput } from "../../src/commands.js";
import type { BuildTask, CommandEvidence, WorkPacket } from "../../src/domain.js";
import { taskForPacket } from "../../src/engine.js";
import { buildWorkPacket } from "../../src/packet.js";
import { renderPrompt } from "../../src/prompts.js";

function evidenceEntry(index: number): CommandEvidence {
  return {
    purpose: `gate:${index}`,
    command: `npm test ${index}`,
    exitCode: index === 9 ? 0 : 1,
    passed: index === 9,
    stdout: `${"noise\n".repeat(50)}${"failure-tail".repeat(1_500)}`,
    stderr: "stderr-tail".repeat(200),
    durationMs: 12,
    at: new Date().toISOString()};
}

function worstCaseTask(): BuildTask {
  return {
    id: "task-1",
    title: "SettlementWindow refunds",
    description: "D".repeat(3_000),
    acceptanceCriteria: Array.from({ length: 6 }, (_, index) => `Criterion ${index} ${"a".repeat(800)}`),
    affectedPaths: ["src/settlement.ts", "tests/settlement.test.ts"],
    blockedBy: [],
    status: "active",
    step: "implementing",
    attempts: { implementation: 2, review: 1 },
    evidence: Array.from({ length: 10 }, (_, index) => evidenceEntry(index)),
    testPaths: ["tests/settlement.test.ts"],
    changedFiles: ["src/settlement.ts", "tests/settlement.test.ts"],
    reviewSummary: "blocking: fix edge case"};
}

function packetForRole(role: WorkPacket["role"], task: BuildTask): WorkPacket {
  const guidance = Array.from({ length: 4 }, (_, index) => ({
    source: `rules/rule-${index}.mdc`,
    title: `Rule ${index}`,
    kind: "rule" as const}));
  const guidancePack = "G".repeat(5_600);
  const context = [
    {
      source: "graphify:graphify-out/graph.json",
      title: "Repository relationships (Graphify)",
      excerpt: "GRAPH".repeat(1_200)},
    ...Array.from({ length: 5 }, (_, index) => ({
      source: `docs/doc-${index}.md`,
      title: `Doc ${index}`,
      excerpt: "C".repeat(1_800)}))];
  const input =
    role === "reviewer"
      ? {
          task: taskForPacket(task),
          changedFiles: task.changedFiles,
          commandEvidence: recentEvidenceOutput(task.evidence),
          diff: "diff --git a/src/settlement.ts b/src/settlement.ts\n+export {}",
          diffOmittedFiles: []}
      : {
          task: taskForPacket(task),
          verifiedCommandOutput: recentEvidenceOutput(task.evidence),
          reviewFeedback: task.reviewSummary};

  return buildWorkPacket({
    invocationId: `inv-${role}`,
    runId: "size-run",
    role,
    objective: `${role} for ${task.title}`,
    constraints: ["Do not commit"],
    input,
    guidance,
    guidancePack,
    retrievalResults: context,
    priorArtifacts: [],
    expectedOutput: "{summary,changedFiles}",
    createdAt: "2026-08-07T00:00:00.000Z",
    budgets: {
      contextCharacters: 12_000,
      inputCharacters: 24_000,
      graphifyCharacters: 3_000}}).packet;
}

describe("packet size baseline", () => {
  it("snapshots worst-case rendered prompt lengths for worker roles", () => {
    const task = worstCaseTask();
    const lengths = {
      implementer: renderPrompt(packetForRole("implementer", task)).length,
      reviewer: renderPrompt(packetForRole("reviewer", task)).length};

    // Ceiling guards: Phase 1 projection + budgets must keep repair prompts bounded.
    expect(lengths.implementer).toBeLessThan(60_000);
    expect(lengths.reviewer).toBeLessThan(60_000);

    // Stable order for regression visibility in failures.
    expect(lengths).toEqual({
      implementer: lengths.implementer,
      reviewer: lengths.reviewer});
  });
});
