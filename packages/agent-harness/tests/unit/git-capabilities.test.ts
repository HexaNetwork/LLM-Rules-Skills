import { describe, expect, it } from "vitest";
import {
  MIN_GIT_WORKTREE_VERSION,
  evaluateGitWorktreeSupport,
  parseGitVersionOutput} from "../../src/git/capabilities.js";

describe("parseGitVersionOutput", () => {
  it("parses common git --version strings", () => {
    expect(parseGitVersionOutput("git version 2.45.1.windows.1")).toEqual({
      major: 2,
      minor: 45,
      patch: 1,
      version: "2.45.1"});
    expect(parseGitVersionOutput("git version 2.5.0")).toEqual({
      major: 2,
      minor: 5,
      patch: 0,
      version: "2.5.0"});
  });

  it("rejects unreadable version output", () => {
    expect(() => parseGitVersionOutput("not a version")).toThrow(/git version/i);
  });
});

describe("evaluateGitWorktreeSupport", () => {
  it("accepts versions at or above the worktree minimum", () => {
    const ok = evaluateGitWorktreeSupport({
      major: MIN_GIT_WORKTREE_VERSION.major,
      minor: MIN_GIT_WORKTREE_VERSION.minor,
      patch: MIN_GIT_WORKTREE_VERSION.patch,
      version: "2.5.0"});
    expect(ok.worktreesSupported).toBe(true);
  });

  it("returns an actionable error for older Git", () => {
    const result = evaluateGitWorktreeSupport({
      major: 2,
      minor: 4,
      patch: 9,
      version: "2.4.9"});
    expect(result.worktreesSupported).toBe(false);
    expect(result.message).toMatch(/2\.5\.0/);
    expect(result.message).toMatch(/worktree/i);
    expect(result.message).toMatch(/2\.4\.9/);
  });
});
