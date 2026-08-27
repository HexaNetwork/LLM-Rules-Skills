import { describe, expect, it } from "vitest";
import { CHARS_PER_TOKEN, estimateTokens, estimateTokensFromChars } from "../../src/domain/token-estimate.js";

describe("token-estimate", () => {
  it("uses the harness chars-per-token ratio", () => {
    expect(CHARS_PER_TOKEN).toBe(4);
  });

  it("estimates tokens from text length", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("be brief")).toBe(2);
  });

  it("estimates tokens from a character count", () => {
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(8)).toBe(2);
    expect(estimateTokensFromChars(9)).toBe(3);
  });
});
