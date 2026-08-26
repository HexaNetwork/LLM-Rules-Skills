import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/domain/settings.js";
import type { Run } from "../../src/domain/types.js";
import { createScenariosPhase } from "../../src/phases/scenarios.js";
import { renderDashboardPage } from "../../src/ui/page.js";
import { bootTestHost, createTempRepo, currentBranch } from "../helpers.js";

function gateRun(artifacts: Record<string, unknown> = {}): Run {
  return {
    identity: {
      runId: "run-operator-gate",
      projectKey: "proj",
      workflowBundleId: "default",
      controlRoot: "/tmp/control",
      worktreePath: "/tmp/work",
      baseSha: "abc",
      baseBranch: "main",
      createdAt: new Date().toISOString(),
    },
    state: {
      runId: "run-operator-gate",
      status: "awaiting_input",
      phase: "scenarios",
      idea: "Ship a clearer operator gate",
      revision: 1,
      updatedAt: new Date().toISOString(),
      gate: {
        id: "operator-gate",
        title: "Review plan, PRD, and scenarios",
        questions: [],
      },
      artifacts,
      fog: [],
      tasks: [],
    },
    settings: DEFAULT_SETTINGS,
  };
}

describe("operator gate UI", () => {
  it("embeds a dedicated review card with Approve / Request changes (no yes/no Submit)", () => {
    const html = renderDashboardPage();
    expect(html).toContain('gate.id === "operator-gate"');
    expect(html).toContain("function renderOperatorGate");
    expect(html).toContain('data-decision="approve"');
    expect(html).toContain('data-decision="request_changes"');
    expect(html).toContain("Request changes");
    expect(html).toContain(">Approve</button>");
    expect(html).toContain("gate-review-block");
    expect(html).toContain(">Plan</h4>");
    expect(html).toContain(">PRD</h4>");
    expect(html).toContain(">Scenarios</h4>");
    expect(html).toContain("formatGateArtifact(\"plan\"");
    expect(html).toContain("formatGateScenarios");
    expect(html).toContain("function renderOverview");
    expect(html).toContain("needs-input");
    expect(html).toContain('awaiting ? "input" : null');
    expect(html).not.toContain("gate-banner");
    expect(html).not.toContain("Operator input is waiting on Overview.");
    expect(html).toContain("Notes are required when requesting changes.");
    expect(html).not.toContain('"operator-gate","slice"');

    const overviewStart = html.indexOf("function renderOverview(run)");
    const overviewEnd = html.indexOf("function renderTabContent(run)", overviewStart);
    const overviewFn = html.slice(overviewStart, overviewEnd);
    expect(overviewFn).toContain("renderGate(run)");
    expect(overviewFn).toContain("renderIdentity(run)");
    expect(overviewFn).toContain("renderFog(run.state.fog)");
    expect(overviewFn).toContain('return (gateHtml || "") + usageHtml');
    expect(overviewFn).not.toMatch(/if \(gateHtml\) return gateHtml/);

    const start = html.indexOf("function renderOperatorGate");
    const end = html.indexOf("function renderGate(run)", start);
    const operatorFn = html.slice(start, end);
    expect(operatorFn).not.toContain(">Submit</button>");
    expect(operatorFn).not.toContain('data-value="yes"');
    expect(operatorFn).not.toContain('data-value="no"');
    expect(operatorFn).not.toContain("artifactBody(value)");
    expect(operatorFn).not.toContain("JSON.stringify(value, null, 2)");

    const detailStart = html.indexOf("function renderDetail()");
    const detailEnd = html.indexOf("async function loadProjects()", detailStart);
    const detailFn = html.slice(detailStart, detailEnd);
    expect(detailFn).toContain("renderTabContent(run)");
    expect(detailFn).not.toContain("renderGate(run)");

    const tabStart = html.indexOf("function renderTabContent(run)");
    const tabEnd = html.indexOf("function maybeLoadSandbox", tabStart);
    const tabFn = html.slice(tabStart, tabEnd);
    expect(tabFn).toContain("return renderOverview(run)");
    expect(tabFn).not.toContain("renderGate(run)");
  });
});

describe("operator gate onAnswer", () => {
  const phase = createScenariosPhase({} as never);

  it("approves with empty notes and continues", async () => {
    const run = gateRun();
    const result = await phase.onAnswer!(run, { answers: { decision: "approve" } });
    expect(result).toEqual({ kind: "continue" });
    expect(run.state.artifacts.operatorApproved).toBe(true);
    expect(run.state.artifacts.operatorNotes).toBeUndefined();
  });

  it("appends approve notes to operatorNotes", async () => {
    const run = gateRun({ operatorNotes: "Prior note" });
    const result = await phase.onAnswer!(run, {
      answers: { decision: "approve" },
      notes: "Looks good overall",
    });
    expect(result).toEqual({ kind: "continue" });
    expect(run.state.artifacts.operatorNotes).toBe("Prior note\n\nLooks good overall");
    expect(run.state.artifacts.planningFeedback).toBeUndefined();
  });

  it("blocks request_changes when notes are blank", async () => {
    const run = gateRun();
    const result = await phase.onAnswer!(run, {
      answers: { decision: "request_changes" },
      notes: "  ",
    });
    expect(result).toEqual({
      kind: "block",
      reason: "Notes are required when requesting changes",
      retriable: true,
    });
    expect(run.state.artifacts.operatorApproved).toBeUndefined();
  });

  it("stores feedback and continues at plan when requesting changes with notes", async () => {
    const run = gateRun();
    const result = await phase.onAnswer!(run, {
      answers: { decision: "request_changes" },
      notes: "Narrow the PRD scope",
    });
    expect(result).toEqual({ kind: "continue", next: "plan" });
    expect(run.state.artifacts.planningFeedback).toBe("Narrow the PRD scope");
    expect(run.state.artifacts.operatorNotes).toBe("Narrow the PRD scope");
    expect(run.state.artifacts.operatorApproved).toBe(false);
  });
});

describe("operator gate request-changes loop", () => {
  it("rewinds to plan with planning feedback, then can approve", async () => {
    const repo = await createTempRepo();
    const { host } = await bootTestHost({
      bundles: [
        {
          id: "operator-loop",
          phases: ["plan", "prd", "scenarios", "publish"],
        },
      ],
    });
    try {
      const project = await host.ctx.projects.add(repo);
      let run = await host.ctx.runLifecycle.start({
        idea: "Clarify operator review",
        projectKey: project.projectKey,
        workflowBundleId: "operator-loop",
        baseBranch: await currentBranch(repo),
      });
      expect(run.state.phase).toBe("scenarios");
      expect(run.state.gate?.id).toBe("operator-gate");
      expect(run.state.artifacts.plan).toBeTruthy();
      expect(run.state.artifacts.prd).toBeTruthy();
      expect(run.state.artifacts.scenarios).toBeTruthy();

      run = await host.ctx.runLifecycle.answer(run.identity.runId, {
        answers: { decision: "request_changes" },
        notes: "Make scenarios more concrete",
      });
      expect(run.state.phase).toBe("scenarios");
      expect(run.state.gate?.id).toBe("operator-gate");
      expect(run.state.artifacts.planningFeedback).toBe("Make scenarios more concrete");
      expect(String(run.state.artifacts.operatorNotes)).toContain("Make scenarios more concrete");

      run = await host.ctx.runLifecycle.answer(run.identity.runId, {
        answers: { decision: "approve" },
        notes: "Ship it",
      });
      expect(run.state.status).toBe("completed");
      expect(run.state.phase).toBe("publish");
      expect(run.state.artifacts.operatorApproved).toBe(true);
      expect(run.state.artifacts.planningFeedback).toBeUndefined();
      expect(String(run.state.artifacts.operatorNotes)).toContain("Ship it");
    } finally {
      await host.dispose();
    }
  });
});
