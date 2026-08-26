import { describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { DEFAULT_SETTINGS } from "../../src/domain/settings.js";
import type { Run, VerificationEvidence } from "../../src/domain/types.js";
import {
  createVerificationSettingsPhase,
  inferFixCommandFromOutput,
  normalizeProposal,
  resolveFixCommand,
  type VerificationProposal,
} from "../../src/phases/verification-settings.js";
import { renderDashboardPage } from "../../src/ui/page.js";

describe("verification proposal normalization", () => {
  it("keeps the generic command, fix command, and optional specific commands", () => {
    const proposal = normalizeProposal(
      {
        command: "npm test",
        fixCommand: "npm run lint:fix",
        testGlobs: ["**/*.test.ts"],
        rationale: "standard script",
        specificCommands: [
          {
            id: "focused",
            label: "Focused",
            command: "npm test -- status",
            rationale: "narrow to status",
          },
        ],
      },
      { testGlobs: [] },
    );
    expect(proposal.command).toBe("npm test");
    expect(proposal.fixCommand).toBe("npm run lint:fix");
    expect(proposal.testGlobs).toEqual(["**/*.test.ts"]);
    expect(proposal.specificCommands).toEqual([
      {
        id: "focused",
        label: "Focused",
        command: "npm test -- status",
        rationale: "narrow to status",
      },
    ]);
    expect(proposal.source).toBe("agent");
  });

  it("falls back to live settings when the agent returns nothing usable", () => {
    const proposal = normalizeProposal(
      { command: "", testGlobs: [], specificCommands: [] },
      { command: "pnpm test", fixCommand: "pnpm format", testGlobs: ["**/*.spec.ts"] },
    );
    expect(proposal.command).toBe("pnpm test");
    expect(proposal.fixCommand).toBe("pnpm format");
    expect(proposal.testGlobs).toEqual(["**/*.spec.ts"]);
    expect(proposal.source).toBe("settings");
  });
});

describe("fix command inference", () => {
  it("extracts spotlessApply hints from verify output", () => {
    const output =
      "Execution failed for task ':civcraft:spotlessJavaCheck'.\nRun './gradlew :civcraft:spotlessApply' to fix these violations.";
    expect(inferFixCommandFromOutput(output)).toBe("./gradlew :civcraft:spotlessApply");
  });

  it("prefers proposal fixCommand over inferred hints", () => {
    const proposal: VerificationProposal = {
      command: "./gradlew spotlessCheck test",
      fixCommand: "./gradlew :civcraft:spotlessApply",
      testGlobs: [],
      specificCommands: [],
      source: "agent",
    };
    expect(resolveFixCommand(proposal, "Run './gradlew spotlessApply' to fix")).toBe(
      "./gradlew :civcraft:spotlessApply",
    );
  });
});

function verificationRun(artifacts: Record<string, unknown> = {}, gateId = "verification-settings"): Run {
  return {
    identity: {
      runId: "run-verification",
      projectKey: "proj",
      workflowBundleId: "default",
      controlRoot: "/tmp/control",
      worktreePath: "/tmp/work",
      baseSha: "abc",
      baseBranch: "main",
      createdAt: new Date().toISOString(),
    },
    state: {
      runId: "run-verification",
      status: "awaiting_input",
      phase: "verification-settings",
      idea: "Ship verification preflight",
      revision: 1,
      updatedAt: new Date().toISOString(),
      gate: { id: gateId, title: "Gate", questions: [] },
      artifacts,
      fog: [],
      tasks: [],
    },
    settings: DEFAULT_SETTINGS,
  };
}

function failedEvidence(output: string): VerificationEvidence {
  return {
    command: "npm test",
    passed: false,
    output,
    classification: "project_failure",
    exitCode: 1,
  };
}

describe("verification preflight gate UI", () => {
  it("embeds retry, fix, and continue actions for verification-preflight", () => {
    const html = renderDashboardPage();
    expect(html).toContain('gate.id === "verification-preflight"');
    expect(html).toContain("function renderVerificationPreflightGate");
    expect(html).toContain('data-decision="retry"');
    expect(html).toContain('data-decision="fix"');
    expect(html).toContain('data-decision="continue"');
    expect(html).toContain("Fix &amp; re-verify");
    expect(html).toContain("Continue anyway");
  });
});

describe("verification-settings preflight", () => {
  it("blocks on project_failure with a preflight gate", async () => {
    const verify = vi.fn(async () => failedEvidence("tests failed"));
    const ctx = { commands: { verify } } as unknown as Context;
    const phase = createVerificationSettingsPhase(ctx);
    const run = verificationRun({
      verificationProposal: {
        command: "npm test",
        testGlobs: [],
        specificCommands: [],
        source: "settings",
      },
    });

    const result = await phase.onAnswer!(run, { answers: { selection: "generic" } });

    expect(result).toEqual({
      kind: "await",
      gate: {
        id: "verification-preflight",
        title: "Verification preflight failed",
        questions: [],
      },
    });
    expect(run.state.artifacts.verificationPreflight).toMatchObject({
      command: "npm test",
      evidence: { passed: false, classification: "project_failure" },
    });
  });

  it("runs fixCommand then re-verifies when operator chooses fix", async () => {
    let calls = 0;
    const verify = vi.fn(async (_runId, command) => {
      calls += 1;
      if (command === "npm run lint:fix") {
        return { command, passed: true, output: "fixed", classification: "passed" as const, exitCode: 0 };
      }
      if (calls === 1) {
        return failedEvidence("Run 'npm run lint:fix' to fix");
      }
      return { command, passed: true, output: "ok", classification: "passed" as const, exitCode: 0 };
    });
    const ctx = { commands: { verify } } as unknown as Context;
    const phase = createVerificationSettingsPhase(ctx);
    const proposal: VerificationProposal = {
      command: "npm test",
      fixCommand: "npm run lint:fix",
      testGlobs: [],
      specificCommands: [],
      source: "agent",
    };
    let run = verificationRun({ verificationProposal: proposal });
    const first = await phase.onAnswer!(run, { answers: { selection: "generic" } });
    expect(first).toMatchObject({
      kind: "await",
      gate: { id: "verification-preflight" },
    });

    run = verificationRun({
      verificationProposal: proposal,
      verification: { command: "npm test" },
      verificationPreflight: {
        command: "npm test",
        proposal,
        evidence: failedEvidence("Run 'npm run lint:fix' to fix"),
        fixCommand: "npm run lint:fix",
      },
    });
    run.state.gate = { id: "verification-preflight", title: "Verification preflight failed", questions: [] };

    const result = await phase.onAnswer!(run, { answers: { decision: "fix" } });
    expect(result).toEqual({ kind: "continue" });
    expect(verify).toHaveBeenCalledWith("run-verification", "npm run lint:fix");
    expect(verify).toHaveBeenCalledWith("run-verification", "npm test");
    expect(run.state.artifacts.verificationFix).toMatchObject({ passed: true });
  });

  it("continues when operator acknowledges a failed preflight", async () => {
    const ctx = { commands: { verify: vi.fn() } } as unknown as Context;
    const phase = createVerificationSettingsPhase(ctx);
    const proposal: VerificationProposal = {
      command: "npm test",
      testGlobs: [],
      specificCommands: [],
      source: "settings",
    };
    const run = verificationRun({
      verification: { command: "npm test" },
      verificationPreflight: {
        command: "npm test",
        proposal,
        evidence: failedEvidence("still broken"),
      },
    });
    run.state.gate = { id: "verification-preflight", title: "Verification preflight failed", questions: [] };

    const result = await phase.onAnswer!(run, { answers: { decision: "continue" } });
    expect(result).toEqual({ kind: "continue" });
    expect(run.state.artifacts.verification).toMatchObject({
      command: "npm test",
      preflightAcknowledged: true,
    });
    expect(run.state.artifacts.verificationPreflight).toBeUndefined();
  });
});
