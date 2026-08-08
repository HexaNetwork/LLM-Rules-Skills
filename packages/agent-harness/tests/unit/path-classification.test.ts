import { describe, expect, it } from "vitest";

import { HarnessConfigSchema } from "../../src/config.js";
import { isTestPath } from "../../src/engine.js";

describe("test path classification", () => {
  it("rejects legacy test paths when patterns are customized", () => {
    const patterns = HarnessConfigSchema.parse({
      workflow: { testPathPatterns: ["spec/**"] },
    }).workflow.testPathPatterns;

    expect(isTestPath("tests/foo.test.ts", patterns)).toBe(false);
    expect(isTestPath("spec/foo.test.ts", patterns)).toBe(true);
  });
});
