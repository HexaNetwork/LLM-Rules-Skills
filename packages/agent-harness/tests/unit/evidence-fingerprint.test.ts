import { describe, expect, it } from "vitest";
import {
  evaluateRepairProgress,
  evidenceFingerprint,
  failureCategoryFromEvidence,
} from "../../src/application/evidence-fingerprint.js";
import type { CommandEvidence } from "../../src/domain.js";

const evidence = (overrides: Partial<CommandEvidence> = {}): CommandEvidence => ({
  purpose: "tdd:green",
  command: "npm test",
  exitCode: 1,
  passed: false,
  stdout: "FAIL tests/greet.test.ts",
  stderr: "",
  durationMs: 10,
  at: "2026-08-10T20:00:00.000Z",
  ...overrides,
});

describe("evidenceFingerprint", () => {
  it("is stable for identical canonical inputs", () => {
    const input = {
      taskId: "greet",
      step: "implementing" as const,
      sourceTreeState: "tree-a",
      redCheckpointSha: "abc",
      failingTestIds: ["FAIL tests/greet.test.ts", "other"],
      failureCategory: "verification",
    };
    expect(evidenceFingerprint(input)).toBe(
      evidenceFingerprint({
        ...input,
        failingTestIds: ["other", "FAIL tests/greet.test.ts"],
      }),
    );
  });

  it("changes when the RED checkpoint or failure category changes", () => {
    const base = {
      taskId: "greet",
      step: "implementing" as const,
      sourceTreeState: "tree-a",
      redCheckpointSha: "abc",
      failingTestIds: ["x"],
      failureCategory: "verification",
    };
    expect(evidenceFingerprint(base)).not.toBe(
      evidenceFingerprint({ ...base, redCheckpointSha: "def" }),
    );
    expect(evidenceFingerprint(base)).not.toBe(
      evidenceFingerprint({ ...base, failureCategory: "test-repair" }),
    );
  });
});

describe("evaluateRepairProgress", () => {
  it("blocks identical fingerprints without new operator input", () => {
    const fingerprint = "fp-1";
    const result = evaluateRepairProgress({
      fingerprint,
      lastFingerprint: fingerprint,
      seenFingerprints: [fingerprint],
      seenEdges: [],
      fromRole: "implementer",
      toRole: "implementer",
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("no_progress");
  });

  it("blocks previously seen role-transition edges", () => {
    const fingerprint = "fp-2";
    const result = evaluateRepairProgress({
      fingerprint,
      seenFingerprints: [],
      seenEdges: [`${fingerprint}:implementer->test-writer`],
      fromRole: "implementer",
      toRole: "test-writer",
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("repeated_edge");
  });

  it("allows a new fingerprint", () => {
    const result = evaluateRepairProgress({
      fingerprint: "fp-new",
      lastFingerprint: "fp-old",
      seenFingerprints: ["fp-old"],
      seenEdges: [],
      fromRole: "implementer",
      toRole: "implementer",
    });
    expect(result).toEqual({ allowed: true, fingerprint: "fp-new" });
  });
});

describe("failureCategoryFromEvidence", () => {
  it("classifies command launch failures as config", () => {
    expect(
      failureCategoryFromEvidence(
        evidence({ stderr: "npm: command not found", stdout: "" }),
      ),
    ).toBe("config");
  });

  it("classifies test compilation diagnostics as test-repair", () => {
    expect(
      failureCategoryFromEvidence(
        evidence({
          stdout: "",
          stderr: "SyntaxError in tests/greet.test.ts",
        }),
      ),
    ).toBe("test-repair");
  });
});
