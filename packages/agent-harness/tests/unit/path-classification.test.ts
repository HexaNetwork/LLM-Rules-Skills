import { describe, expect, it } from "vitest";

import { HarnessConfigSchema } from "../../src/config.js";
import { isTestPath } from "../../src/engine.js";

describe("test path classification", () => {
  it("rejects legacy test paths when patterns are customized", () => {
    const patterns = HarnessConfigSchema.parse({
      workflow: { testPathPatterns: ["spec/**"] }}).workflow.testPathPatterns;

    expect(isTestPath("tests/foo.test.ts", patterns)).toBe(false);
    expect(isTestPath("spec/foo.test.ts", patterns)).toBe(true);
  });

  it("treats only testPathPatterns matches as RED-legal paths", () => {
    const patterns = HarnessConfigSchema.parse({}).workflow.testPathPatterns;

    expect(isTestPath("tests/foo.test.ts", patterns)).toBe(true);
    expect(isTestPath("src/foo.ts", patterns)).toBe(false);
    expect(isTestPath("src/greet.ts", patterns)).toBe(false);
    // Affected production paths are no longer RED-legal scaffolds.
    expect(isTestPath("src/greet.ts", patterns)).toBe(false);
  });
});
