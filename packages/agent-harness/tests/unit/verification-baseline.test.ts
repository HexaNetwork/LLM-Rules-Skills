import { describe, expect, it } from "vitest";
import { isVerificationBaselineAcceptable } from "../../src/application/verification-evidence.js";
import type { CommandEvidence } from "../../src/domain.js";

function evidence(partial: Partial<CommandEvidence>): CommandEvidence {
  return {
    purpose: "verification:baseline",
    command: "npm test",
    exitCode: 1,
    passed: false,
    stdout: "",
    stderr: "",
    durationMs: 10,
    at: "2026-01-01T00:00:00.000Z",
    ...partial};
}

describe("isVerificationBaselineAcceptable", () => {
  it("accepts exit 0", () => {
    expect(
      isVerificationBaselineAcceptable(
        evidence({ exitCode: 0, passed: true, stdout: "ok" }),
      ),
    ).toBe(true);
  });

  it("accepts greenfield no-tests output on non-zero exit", () => {
    expect(
      isVerificationBaselineAcceptable(
        evidence({ stdout: "No test files found", exitCode: 1, passed: false }),
      ),
    ).toBe(true);
    expect(
      isVerificationBaselineAcceptable(
        evidence({ stderr: "No tests found", exitCode: 1, passed: false }),
      ),
    ).toBe(true);
  });

  it("rejects real failures", () => {
    expect(
      isVerificationBaselineAcceptable(
        evidence({ stdout: "1 failed", exitCode: 1, passed: false }),
      ),
    ).toBe(false);
  });

  it("rejects command-not-launched even with no-tests wording", () => {
    expect(
      isVerificationBaselineAcceptable(
        evidence({
          stderr: "npm: command not found\nNo tests found",
          exitCode: 127,
          passed: false}),
      ),
    ).toBe(false);
    expect(
      isVerificationBaselineAcceptable(
        evidence({
          stderr: "'vitest' is not recognized as an internal or external command",
          exitCode: 1,
          passed: false}),
      ),
    ).toBe(false);
  });

  it("rejects timeouts", () => {
    expect(
      isVerificationBaselineAcceptable(
        evidence({
          exitCode: 124,
          passed: false,
          stderr: "Command timed out after 1000ms"}),
      ),
    ).toBe(false);
  });
});
