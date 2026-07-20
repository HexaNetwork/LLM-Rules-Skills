import { describe, expect, it } from "vitest";
import type { Finding, VerifierReport } from "../../src/schemas/reports.js";

function blocking(findings: Finding[]): Finding[] {
  return findings.filter((finding) => finding.severity === "BLOCKING");
}

function advisory(findings: Finding[]): Finding[] {
  return findings.filter((finding) => finding.severity === "ADVISORY");
}

describe("severity policy", () => {
  it("only BLOCKING findings trigger repair decisions", () => {
    const report: VerifierReport = {
      contractVersion: "1",
      taskId: "t1",
      acceptance: [],
      findings: [
        {
          id: "f1",
          severity: "ADVISORY",
          criterionOrRule: "style",
          location: "a.ts",
          evidence: "naming",
          remediation: "rename",
        },
        {
          id: "f2",
          severity: "BLOCKING",
          criterionOrRule: "ac-1",
          location: "a.ts",
          evidence: "missing",
          remediation: "add",
        },
      ],
      browserProbeResults: [],
    };
    expect(blocking(report.findings)).toHaveLength(1);
    expect(advisory(report.findings)).toHaveLength(1);
    expect(blocking(report.findings)[0]?.id).toBe("f2");
  });
});
