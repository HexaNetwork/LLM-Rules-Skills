import { describe, expect, it } from "vitest";
import type { WorkPacket } from "../../src/domain.js";
import { GRILL_EXPECTED_OUTPUT, REFLECT_EXPECTED_OUTPUT } from "../../src/domain.js";
import { renderContinuationPrompt, renderPrompt, renderPromptBuilderPrompt } from "../../src/prompts.js";

const packet: WorkPacket = {
  contractVersion: "2",
  invocationId: "invocation",
  runId: "run",
  role: "implementer",
  objective: "Implement login validation",
  constraints: [],
  input: { affectedPaths: ["src/login.ts"] },
  guidance: [
    {
      source: "General/rules/login.mdc",
      title: "Login validation",
      kind: "rule",
      excerpt: "Reject blank credentials.",
      reason: "path matches src/**/*.ts; lexical relevance",
      score: 81,
    },
  ],
  context: [],
  priorArtifacts: [],
  expectedOutput: "{summary,changedFiles}",
  createdAt: "2026-08-06T00:00:00.000Z",
};

describe("prompt rendering", () => {
  it("renders auditable selected guidance for fresh and resumed workers", () => {
    expect(renderPrompt(packet)).toContain("General/rules/login.mdc");
    expect(renderPrompt(packet)).toContain("Reject blank credentials.");
    expect(renderContinuationPrompt({ ...packet, role: "griller" })).toContain(
      "General/rules/login.mdc",
    );
  });

  it("emits guidance excerpts once and serialises the packet without pretty-print indent", () => {
    const rendered = renderPrompt(packet);
    expect(rendered.split("Reject blank credentials.").length).toBe(2);
    expect(rendered).not.toContain('\n    "');
    expect(renderPromptBuilderPrompt(packet).split("Reject blank credentials.").length).toBe(2);
  });

  it("omits unchanged guidance on grill continuations", () => {
    const grillPacket = { ...packet, role: "griller" as const };
    const withGuidance = renderContinuationPrompt(grillPacket, { includeGuidance: true });
    const withoutGuidance = renderContinuationPrompt(grillPacket, { includeGuidance: false });
    expect(withGuidance).toContain("Reject blank credentials.");
    expect(withoutGuidance).not.toContain("Reject blank credentials.");
  });

  it("allows grillers to deliver JSON via CreatePlan or assistant result", () => {
    const grillPacket: WorkPacket = { ...packet, role: "griller" };
    expect(renderPrompt(grillPacket)).toContain("CreatePlan");
    expect(renderContinuationPrompt(grillPacket)).toContain("CreatePlan");
    expect(renderPrompt(packet)).not.toContain("CreatePlan");
  });

  it("requires config-fixers to return one raw JSON object without tools", () => {
    const configFixerPacket: WorkPacket = { ...packet, role: "config-fixer" };
    const rendered = renderPrompt(configFixerPacket);
    expect(rendered).toContain("Return exactly one raw JSON object");
    expect(rendered).toContain("Do not wrap the object in Markdown");
    expect(rendered).toContain("Do not call tools, inspect files, or search the repository");
  });

  it("requires project-profilers to propose verification settings only", () => {
    const profilerPacket: WorkPacket = { ...packet, role: "project-profiler" };
    const rendered = renderPrompt(profilerPacket);
    expect(rendered).toContain("commands.test");
    expect(rendered).toContain("workflow.testPathPatterns");
    expect(rendered).toContain("Prefer the evidence packet when it is strong");
    expect(rendered).toContain("empty/greenfield");
    expect(rendered).toContain("Never invent shell pipelines");
    expect(rendered).toContain("Do not edit files");
  });

  it("honors tools-off constraints passed into the project-profiler packet", () => {
    const profilerPacket: WorkPacket = {
      ...packet,
      role: "project-profiler",
      constraints: [
        "The work packet contains every fact needed. Do not call tools, inspect files, or search the repository.",
      ],
    };
    expect(renderPrompt(profilerPacket)).toContain(
      "Do not call tools, inspect files, or search the repository",
    );
  });

  it("keeps reflect and grill expected-output contracts in prompts", () => {
    expect(REFLECT_EXPECTED_OUTPUT).toContain("restatement:string");
    expect(GRILL_EXPECTED_OUTPUT).toContain("needs_input");
    expect(GRILL_EXPECTED_OUTPUT).toContain("ready_to_plan");
    expect(GRILL_EXPECTED_OUTPUT).toContain("resolutionSummaries");
  });

  it("asks the planner to propose installs without installing them", () => {
    const plannerPacket: WorkPacket = { ...packet, role: "planner" };
    expect(renderPrompt(plannerPacket)).toContain("proposedInstalls");
    expect(renderPrompt(plannerPacket)).toContain("do not install them yourself");
  });

  it("instructs grillers to return per-question resolutionSummaries", () => {
    const grillPacket: WorkPacket = { ...packet, role: "griller" };
    expect(renderPrompt(grillPacket)).toContain("resolutionSummaries");
    expect(renderPrompt(grillPacket)).toContain("one answer settled");
  });

  it("requires the prompt builder to preserve guidance", () => {
    expect(renderPromptBuilderPrompt(packet)).toContain("selected guidance block");
    expect(renderPromptBuilderPrompt(packet)).toContain("General/rules/login.mdc");
  });

  it("tells reviewers the diff is primary evidence", () => {
    const reviewPacket: WorkPacket = { ...packet, role: "reviewer" };
    expect(renderPrompt(reviewPacket)).toContain(
      "The diff is the primary evidence. Read the listed omitted files from disk before commenting on them.",
    );
  });

  it("tells the planner not to edit the working tree", () => {
    const plannerPacket: WorkPacket = { ...packet, role: "planner" };
    expect(renderPrompt(plannerPacket)).toContain("Do not edit the working tree. Produce the task list only.");
  });

  it("requires schema-validated workers to return one raw JSON object after the work packet", () => {
    for (const role of ["test-writer", "implementer"] as const) {
      const rendered = renderPrompt({ ...packet, role });
      const workPacketIndex = rendered.indexOf("WORK PACKET");
      const noMarkdownIndex = rendered.indexOf(
        "Do not wrap the object in Markdown or split its fields into separate sections.",
      );
      const expectedOutputIndex = rendered.indexOf(`Expected output: ${packet.expectedOutput}`);
      expect(workPacketIndex).toBeGreaterThan(-1);
      expect(noMarkdownIndex).toBeGreaterThan(workPacketIndex);
      expect(expectedOutputIndex).toBeGreaterThan(noMarkdownIndex);
      expect(rendered).toContain("Return exactly one raw JSON object matching the expected output contract.");
      expect(rendered).toContain("Do not use Markdown headings or code fences.");
    }
  });

  it("keeps griller CreatePlan delivery while forbidding Markdown interview prose", () => {
    const grillPacket: WorkPacket = { ...packet, role: "griller" };
    const rendered = renderPrompt(grillPacket);
    const workPacketIndex = rendered.indexOf("WORK PACKET");
    const afterPacket = rendered.slice(workPacketIndex);
    const noMarkdownIndex = afterPacket.indexOf(
      "Do not write Markdown interview prose, headings, or reports as the deliverable.",
    );
    const createPlanIndex = afterPacket.indexOf("You may deliver that JSON via CreatePlan");
    const expectedOutputIndex = afterPacket.indexOf(`Expected output: ${packet.expectedOutput}`);
    expect(workPacketIndex).toBeGreaterThan(-1);
    expect(noMarkdownIndex).toBeGreaterThan(-1);
    expect(createPlanIndex).toBeGreaterThan(noMarkdownIndex);
    expect(expectedOutputIndex).toBeGreaterThan(createPlanIndex);
    expect(rendered).toContain("Return exactly one JSON object matching the expected output contract.");
    expect(rendered).not.toContain("Do not wrap the object in Markdown");
  });
});
