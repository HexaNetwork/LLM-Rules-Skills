import { describe, expect, it } from "vitest";
import { reportedTotal } from "../../src/agent.js";

describe("reportedTotal", () => {
  it("derives input + output instead of trusting a provider total that double-counts cache reads", () => {
    // Cursor SDK usage: inputTokens already includes cacheReadTokens, but its
    // totalTokens = input + output + cacheRead + cacheWrite counts them again.
    expect(
      reportedTotal({
        inputTokens: 320_653,
        outputTokens: 6_217,
        totalTokens: 598_134,
      }),
    ).toBe(326_870);
  });

  it("falls back to the provider total when components are missing", () => {
    expect(reportedTotal({ totalTokens: 105 })).toBe(105);
    expect(reportedTotal({ inputTokens: 100, totalTokens: 150 })).toBe(150);
  });

  it("returns undefined when nothing is reported", () => {
    expect(reportedTotal(undefined)).toBeUndefined();
    expect(reportedTotal({})).toBeUndefined();
  });
});
