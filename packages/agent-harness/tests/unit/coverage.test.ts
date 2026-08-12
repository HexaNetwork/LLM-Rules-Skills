import { describe, expect, it } from "vitest";
import {
  measureCoverage,
  parseClover,
  parseCobertura,
  parseLcov,
} from "../../src/application/coverage.js";

describe("coverage parsers", () => {
  it("parses lcov line hits", () => {
    const report = parseLcov(`
SF:src/greet.ts
DA:1,1
DA:2,0
DA:3,4
end_of_record
SF:src/other.ts
DA:1,0
end_of_record
`);
    expect(report.total).toBe(4);
    expect(report.covered).toBe(2);
    expect(report.percentage).toBe(0.5);
    expect(report.files.get("src/greet.ts")).toEqual({ covered: 2, total: 3 });
  });

  it("parses cobertura class files", () => {
    const report = parseCobertura(`
<coverage>
  <packages>
    <package>
      <classes>
        <class filename="src/greet.ts">
          <lines>
            <line number="1" hits="1"/>
            <line number="2" hits="0"/>
          </lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>
`);
    expect(report.files.get("src/greet.ts")).toEqual({ covered: 1, total: 2 });
    expect(report.percentage).toBe(0.5);
  });

  it("parses clover file metrics", () => {
    const report = parseClover(`
<coverage>
  <project>
    <file name="src/greet.ts">
      <line num="1" count="1"/>
      <line num="2" count="0"/>
    </file>
  </project>
</coverage>
`);
    expect(report.files.get("src/greet.ts")).toEqual({ covered: 1, total: 2 });
  });

  it("scopes changed production files and falls back when unmatched", () => {
    const report = parseLcov(`
SF:src/greet.ts
DA:1,1
DA:2,1
end_of_record
SF:tests/greet.test.ts
DA:1,1
end_of_record
`);
    const scoped = measureCoverage({
      report,
      scope: "changed",
      changedFiles: ["src/greet.ts", "tests/greet.test.ts"],
      testPathPatterns: ["tests/**", "**/*.test.*"],
    });
    expect(scoped.fallback).toBe(false);
    expect(scoped.total).toBe(2);
    expect(scoped.percentage).toBe(1);

    const fallback = measureCoverage({
      report,
      scope: "changed",
      changedFiles: ["src/missing.ts"],
      testPathPatterns: ["tests/**"],
    });
    expect(fallback.fallback).toBe(true);
    expect(fallback.total).toBe(3);
  });
});
