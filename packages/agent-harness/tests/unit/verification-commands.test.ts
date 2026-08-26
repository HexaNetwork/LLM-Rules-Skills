import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/domain/settings.js";
import type { Run } from "../../src/domain/types.js";
import {
  verificationCommand,
  verificationCommandsForRun,
  runImplementerHarnessVerification,
} from "../../src/phases/verification.js";

function runWithVerification(artifacts: Record<string, unknown>): Run {
  return {
    identity: {
      runId: "run-verify-cmds",
      projectKey: "proj",
      workflowBundleId: "default",
      controlRoot: "/tmp/control",
      worktreePath: "/tmp/work",
      baseSha: "abc",
      baseBranch: "main",
      createdAt: new Date().toISOString(),
    },
    state: {
      runId: "run-verify-cmds",
      status: "active",
      phase: "implement",
      idea: "test",
      revision: 1,
      updatedAt: new Date().toISOString(),
      artifacts,
      fog: [],
      tasks: [],
    },
    settings: {
      ...DEFAULT_SETTINGS,
      verification: {
        testGlobs: [],
        command: "./gradlew test",
        fixCommand: "./gradlew spotlessApply",
      },
    },
  };
}

describe("verificationCommandsForRun", () => {
  it("prefers run artifact command and proposal fixCommand over live settings", () => {
    const run = runWithVerification({
      verification: {
        command: "./gradlew spotlessCheck test",
        proposal: { fixCommand: "./gradlew :civcraft:spotlessApply" },
      },
    });
    expect(verificationCommandsForRun(run)).toEqual({
      command: "./gradlew spotlessCheck test",
      fixCommand: "./gradlew :civcraft:spotlessApply",
    });
    expect(verificationCommand(run)).toBe("./gradlew spotlessCheck test");
  });

  it("falls back to live project settings", () => {
    const run = runWithVerification({});
    expect(verificationCommandsForRun(run)).toEqual({
      command: "./gradlew test",
      fixCommand: "./gradlew spotlessApply",
    });
  });

  it("infers fixCommand from prior verification output", () => {
    const run = runWithVerification({
      verification: { command: "./gradlew spotlessCheck test", proposal: {} },
    });
    run.settings.verification.fixCommand = undefined;
    expect(
      verificationCommandsForRun(run, {
        output: "Run './gradlew :civcraft:spotlessApply' to fix",
        passed: false,
        classification: "project_failure",
        command: "./gradlew spotlessCheck test",
      }).fixCommand,
    ).toBe("./gradlew :civcraft:spotlessApply");
  });
});

describe("runImplementerHarnessVerification", () => {
  it("runs fixCommand by default and verify when requested", async () => {
    const verify = vi.fn(async (_runId, command) => ({
      command: command ?? "",
      passed: command?.includes("spotlessApply") ? true : false,
      output: command ?? "",
      classification: "passed" as const,
      exitCode: 0,
    }));
    const ctx = { commands: { verify } } as unknown as import("@deepseek-ai/cordis").Context;
    const run = runWithVerification({
      verification: {
        command: "./gradlew spotlessCheck test",
        proposal: { fixCommand: "./gradlew :civcraft:spotlessApply" },
      },
    });
    const result = await runImplementerHarnessVerification(ctx, run, {
      summary: "done",
      files: [],
      verification: { runVerify: true },
    });
    expect(result.fix?.command).toBe("./gradlew :civcraft:spotlessApply");
    expect(result.verify?.command).toBe("./gradlew spotlessCheck test");
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it("skips fix when implementer sets runFix false", async () => {
    const verify = vi.fn();
    const ctx = { commands: { verify } } as unknown as import("@deepseek-ai/cordis").Context;
    const run = runWithVerification({
      verification: {
        command: "./gradlew test",
        proposal: { fixCommand: "./gradlew spotlessApply" },
      },
    });
    await runImplementerHarnessVerification(ctx, run, {
      summary: "done",
      files: [],
      verification: { runFix: false },
    });
    expect(verify).not.toHaveBeenCalled();
  });
});
