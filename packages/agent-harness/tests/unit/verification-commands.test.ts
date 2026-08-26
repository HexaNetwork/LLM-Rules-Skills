import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/domain/settings.js";
import type { Run } from "../../src/domain/types.js";
import {
  verificationCommand,
  verificationCommandsForRun,
  verifyWithHarness,
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

describe("verifyWithHarness", () => {
  it("runs fixCommand then command when both are configured", async () => {
    const verify = vi.fn(async (_runId, command) => ({
      command: command ?? "",
      passed: true,
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
    const result = await verifyWithHarness(ctx, run);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(verify.mock.calls[0]?.[1]).toBe("./gradlew :civcraft:spotlessApply");
    expect(verify.mock.calls[1]?.[1]).toBe("./gradlew spotlessCheck test");
    expect(result?.command).toBe("./gradlew spotlessCheck test");
    expect(result?.passed).toBe(true);
  });

  it("runs fix even when fix fails, then returns main command evidence", async () => {
    const verify = vi.fn(async (_runId, command) => ({
      command: command ?? "",
      passed: !command?.includes("spotlessApply"),
      output: command ?? "",
      classification: command?.includes("spotlessApply") ? "project_failure" : "passed",
      exitCode: command?.includes("spotlessApply") ? 1 : 0,
    }));
    const ctx = { commands: { verify } } as unknown as import("@deepseek-ai/cordis").Context;
    const run = runWithVerification({});
    const result = await verifyWithHarness(ctx, run);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(result?.command).toBe("./gradlew test");
    expect(result?.passed).toBe(true);
  });

  it("uses priorEvidence for fixCommand inference", async () => {
    const verify = vi.fn(async (_runId, command) => ({
      command: command ?? "",
      passed: true,
      output: "",
      classification: "passed" as const,
      exitCode: 0,
    }));
    const ctx = { commands: { verify } } as unknown as import("@deepseek-ai/cordis").Context;
    const run = runWithVerification({
      verification: { command: "./gradlew spotlessCheck test", proposal: {} },
    });
    run.settings.verification.fixCommand = undefined;
    await verifyWithHarness(ctx, run, {
      output: "Run './gradlew :civcraft:spotlessApply' to fix",
      passed: false,
      classification: "project_failure",
      command: "./gradlew spotlessCheck test",
    });
    expect(verify.mock.calls[0]?.[1]).toBe("./gradlew :civcraft:spotlessApply");
    expect(verify.mock.calls[1]?.[1]).toBe("./gradlew spotlessCheck test");
  });

  it("returns undefined when no command is configured", async () => {
    const verify = vi.fn();
    const ctx = { commands: { verify } } as unknown as import("@deepseek-ai/cordis").Context;
    const run = runWithVerification({});
    run.settings.verification.command = "";
    const result = await verifyWithHarness(ctx, run);
    expect(result).toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
  });
});
