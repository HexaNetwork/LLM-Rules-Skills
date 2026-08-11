import { describe, expect, it } from "vitest";
import type { WorkPacket } from "../../src/domain.js";
import {
  GRILL_EXPECTED_OUTPUT,
  PRD_EXPECTED_OUTPUT,
  REFLECT_EXPECTED_OUTPUT,
} from "../../src/domain.js";
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
    },
  ],
  guidancePack: "Reject blank credentials.",
  context: [],
  priorArtifacts: [],
  expectedOutput: "{summary,changedFiles}",
  createdAt: "2026-08-06T00:00:00.000Z",
};

describe("prompt rendering", () => {
  it("renders a lean compiled guidance pack without selection metadata", () => {
    const rendered = renderPrompt(packet);
    expect(rendered).toContain("GUIDANCE");
    expect(rendered).toContain("Reject blank credentials.");
    expect(rendered).not.toContain("SELECTED GUIDANCE");
    expect(rendered).not.toContain("Reason:");
    expect(rendered).not.toContain("General/rules/login.mdc");
    expect(rendered).not.toContain("skill:");
    expect(renderContinuationPrompt({ ...packet, role: "griller" })).toContain(
      "Reject blank credentials.",
    );
  });

  it("emits guidance body once and serialises the packet without pretty-print indent", () => {
    const rendered = renderPrompt(packet);
    expect(rendered.split("Reject blank credentials.").length).toBe(2);
    expect(rendered).not.toContain('\n    "');
    expect(rendered).not.toContain('"guidancePack"');
    expect(renderPromptBuilderPrompt(packet).split("Reject blank credentials.").length).toBe(2);
  });

  it("omits unchanged guidance on grill continuations", () => {
    const grillPacket = { ...packet, role: "griller" as const };
    const withGuidance = renderContinuationPrompt(grillPacket, { includeGuidance: true });
    const withoutGuidance = renderContinuationPrompt(grillPacket, { includeGuidance: false });
    expect(withGuidance).toContain("Reject blank credentials.");
    expect(withoutGuidance).not.toContain("Reject blank credentials.");
  });

  it("renders retained grill turns from only the new delta", () => {
    const grillPacket = {
      ...packet,
      role: "griller" as const,
      input: {
        confirmedBrief: "A deliberately unique durable brief",
        resolutions: [{ summary: "A deliberately unique old resolution" }],
        openUnknowns: [{ title: "A deliberately unique old unknown" }],
      },
      expectedOutput: "A deliberately unique full grill contract",
    };
    const rendered = renderContinuationPrompt(grillPacket, {
      includeGuidance: false,
      deltaInput: { responses: [{ questionId: "q-1", answer: "The new answer" }] },
    });

    expect(rendered).toContain("The new answer");
    expect(rendered).not.toContain("durable brief");
    expect(rendered).not.toContain("old resolution");
    expect(rendered).not.toContain("old unknown");
    expect(rendered).not.toContain("full grill contract");
    expect(rendered).not.toContain("You are the griller worker");
  });

  it("strips YAML frontmatter markers from model-facing packs", () => {
    const withFrontmatter: WorkPacket = {
      ...packet,
      guidancePack: "# Test-Driven Development\n\nWrite a failing test first.",
    };
    const rendered = renderPrompt(withFrontmatter);
    expect(rendered).toContain("# Test-Driven Development");
    expect(rendered).not.toContain("---\nname:");
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
    expect(rendered).toContain("commands.verification");
    expect(rendered).toContain("workflow.testPathPatterns");
    expect(rendered).toContain("Prefer the evidence packet when it is strong");
    expect(rendered).toContain("empty/greenfield");
    expect(rendered).toContain("confirmed brief");
    expect(rendered).not.toContain("brief/idea");
    expect(rendered).toContain("Never invent shell pipelines");
    expect(rendered).toContain("Do not edit files");
    expect(rendered).toContain("evidence.host.platform");
    expect(rendered).toContain("evidence.host.isWindows");
    expect(rendered).toContain("On Windows (win32), do not use ./ prefixes");
    expect(rendered).toContain("On POSIX hosts, prefer conventional POSIX invocation");
    expect(rendered).toContain("never invent a stack");
  });

  it("requires config-fixers to stay OS-aware for shell-launch repairs", () => {
    const configFixerPacket: WorkPacket = { ...packet, role: "config-fixer" };
    const rendered = renderPrompt(configFixerPacket);
    expect(rendered).toContain("shell-launch failure");
    expect(rendered).toContain("host-compatible");
    expect(rendered).toContain("do not invent a stack");
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
    expect(REFLECT_EXPECTED_OUTPUT).toContain("proposedTitle:string");
    expect(REFLECT_EXPECTED_OUTPUT).toContain("restatement:string");
    expect(GRILL_EXPECTED_OUTPUT).toContain("needs_input");
    expect(GRILL_EXPECTED_OUTPUT).toContain("ready_to_plan");
    expect(GRILL_EXPECTED_OUTPUT).toContain("resolutionSummaries");
  });

  it("asks the reflector for a concise feature title", () => {
    const reflectPacket: WorkPacket = { ...packet, role: "reflector" };
    expect(renderPrompt(reflectPacket)).toContain("concise imperative feature title");
  });

  it("asks the planner for a high-level plan without tasks or installs", () => {
    const plannerPacket: WorkPacket = { ...packet, role: "planner" };
    expect(renderPrompt(plannerPacket)).toContain("high-level plan only");
    expect(renderPrompt(plannerPacket)).toContain("Do not emit a task list");
    expect(renderPrompt(plannerPacket)).toContain(
      "Do not emit a task list, BuildTasks, acceptance criteria tickets, or proposedInstalls.",
    );
  });

  it("shows planners valid JSON shapes with explicit string-list PRD fields", () => {
    const highLevelPacket: WorkPacket = {
      ...packet,
      role: "planner",
      expectedOutput:
        "{summary,problemStatement,solution,approach,constraints?,outOfScope?,openQuestions?}",
    };
    const prdPacket: WorkPacket = {
      ...highLevelPacket,
      expectedOutput: PRD_EXPECTED_OUTPUT,
    };

    expect(renderPrompt(highLevelPacket)).toContain(
      'Valid shape example: {"summary":"...","problemStatement":"...","solution":"...","approach":"..."',
    );
    const renderedPrd = renderContinuationPrompt(prdPacket);
    expect(PRD_EXPECTED_OUTPUT).toContain("implementationDecisions:[string]");
    expect(PRD_EXPECTED_OUTPUT).toContain("testingDecisions:[string]");
    expect(renderedPrd).toContain('"implementationDecisions":["..."]');
    expect(renderedPrd).toContain('"testingDecisions":["..."]');
  });

  it("asks the issue-slicer to propose installs without installing them", () => {
    const slicerPacket: WorkPacket = { ...packet, role: "issue-slicer" };
    expect(renderPrompt(slicerPacket)).toContain("proposedInstalls");
    expect(renderPrompt(slicerPacket)).toContain("do not install them yourself");
  });

  it("instructs grillers to return per-question resolutionSummaries", () => {
    const grillPacket: WorkPacket = { ...packet, role: "griller" };
    expect(renderPrompt(grillPacket)).toContain("resolutionSummaries");
    expect(renderPrompt(grillPacket)).toContain("one answer settled");
  });

  it("requires the prompt builder to preserve guidance", () => {
    expect(renderPromptBuilderPrompt(packet)).toContain("selected guidance block");
    expect(renderPromptBuilderPrompt(packet)).toContain("GUIDANCE");
    expect(renderPromptBuilderPrompt(packet)).toContain("Reject blank credentials.");
  });

  it("tells reviewers the diff is primary evidence and structured finding kinds", () => {
    const reviewPacket: WorkPacket = { ...packet, role: "reviewer" };
    const rendered = renderPrompt(reviewPacket);
    expect(rendered).toContain(
      "The diff is the primary evidence. Read the listed omitted files from disk before commenting on them.",
    );
    expect(rendered).toContain("kind: production");
    expect(rendered).toContain("test-coverage");
  });

  it("tells the planner not to edit the working tree", () => {
    const plannerPacket: WorkPacket = { ...packet, role: "planner" };
    expect(renderPrompt(plannerPacket)).toContain(
      "Do not edit the working tree. Produce a high-level plan only — not executable tickets.",
    );
  });

  it("describes test-only, no-command red-writer batches and continue versus done", () => {
    const rendered = renderPrompt({ ...packet, role: "red-writer" });
    expect(rendered).toContain("Edit test files only");
    expect(rendered).toContain("Do not run test, compile, build, lint, verification");
    expect(rendered).toContain("minimum discriminating test evidence");
    expect(rendered).toContain("distinct plausible defect");
    expect(rendered).toContain("operator-owned inputs");
    expect(rendered).toContain("Mark criteria that only select operator-owned values as not-validated");
    expect(rendered).toContain("At a verified-GREEN checkpoint, default to done");
    expect(rendered).not.toContain("three to five tests");
    expect(rendered).not.toContain("Establish a runnable RED");
    expect(rendered).not.toContain("minimal compile scaffolds");
  });

  it("tells reviewers not to turn operator-owned values into validation work", () => {
    const rendered = renderPrompt({ ...packet, role: "reviewer" });
    expect(rendered).toContain("marked not-validated");
    expect(rendered).toContain("do not request tests, inspection, or command checks");
  });

  it("labels TDD implementer as green-implementer with status rules", () => {
    const tddPacket: WorkPacket = {
      ...packet,
      role: "implementer",
      input: {
        task: {
          title: "Feature",
          description: "Do it",
          acceptanceCriteria: ["works"],
          tdd: true,
        },
      },
    };
    const rendered = renderPrompt(tddPacket);
    expect(rendered).toContain("You are the green-implementer worker");
    expect(rendered).toContain("Return status green when you implemented the current batch");
    expect(rendered).toContain("already_green");
    expect(rendered).toContain("test_issue");
    expect(renderPrompt(packet)).toContain("You are the implementer worker");
    expect(renderPrompt(packet)).not.toContain("green-implementer");
  });

  it("omits full task JSON from same-session continuation deltas", () => {
    const redPacket: WorkPacket = {
      ...packet,
      role: "red-writer",
      input: {
        task: {
          id: "task-1",
          title: "A deliberately unique full task title",
          description: "A deliberately unique full task description",
          acceptanceCriteria: ["unique-criterion"],
          tdd: true,
        },
        priorCommandOutput: "unique prior evidence blob",
      },
      expectedOutput: "unique-red-contract",
    };
    const rendered = renderContinuationPrompt(redPacket, {
      includeGuidance: false,
      deltaInput: {
        round: 2,
        atVerifiedGreen: true,
        instruction: "The accumulated suite is verified GREEN. Default to done.",
      },
    });
    expect(rendered).toContain("Default to done");
    expect(rendered).not.toContain("unique full task title");
    expect(rendered).not.toContain("unique prior evidence blob");
    expect(rendered).not.toContain("unique-red-contract");
    expect(rendered).not.toContain("WORK PACKET");
    expect(renderPrompt(redPacket)).toContain("unique full task title");
    expect(renderPrompt(redPacket)).toContain("unique prior evidence blob");
  });

  it("requires schema-validated workers to return one raw JSON object after the work packet", () => {
    for (const role of ["red-writer", "implementer"] as const) {
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
    const planBodyIndex = afterPacket.indexOf(
      "If using CreatePlan, the plan body is that JSON object",
    );
    const noAlongsideIndex = afterPacket.indexOf('"JSON alongside this plan"');
    const expectedOutputIndex = afterPacket.indexOf(`Expected output: ${packet.expectedOutput}`);
    expect(workPacketIndex).toBeGreaterThan(-1);
    expect(noMarkdownIndex).toBeGreaterThan(-1);
    expect(createPlanIndex).toBeGreaterThan(noMarkdownIndex);
    expect(planBodyIndex).toBeGreaterThan(createPlanIndex);
    expect(noAlongsideIndex).toBeGreaterThan(planBodyIndex);
    expect(expectedOutputIndex).toBeGreaterThan(noAlongsideIndex);
    expect(rendered).toContain("Return exactly one JSON object matching the expected output contract.");
    expect(rendered).toContain("plan body must be that JSON only");
    expect(rendered).toContain("research briefings");
    expect(rendered).not.toContain("Do not wrap the object in Markdown");
  });
});
