import { describe, expect, it } from "vitest";
import {
  decideWorktreeCleanup,
  type WorktreeCleanupFacts} from "../../src/domain/workspace-cleanup.js";

function facts(overrides: Partial<WorktreeCleanupFacts> = {}): WorktreeCleanupFacts {
  return {
    phase: "completed",
    workspaceKind: "git-worktree",
    alreadyRemoved: false,
    dirty: false,
    pathValid: true,
    registered: true,
    gitCommonDirMatches: true,
    commitsReachableFromRetainedRef: true,
    hasRetainedNamedRef: true,
    discard: false,
    ...overrides};
}

describe("decideWorktreeCleanup", () => {
  it("allows removing a clean completed worktree when commits are on a retained ref", () => {
    expect(decideWorktreeCleanup(facts())).toEqual({
      allow: true,
      reason: "published-complete"});
  });

  it("allows already-removed worktrees as a no-op", () => {
    expect(decideWorktreeCleanup(facts({ alreadyRemoved: true }))).toEqual({
      allow: true,
      reason: "already-removed"});
  });

  it("allows clean settled runs with no unique commits even without a delivery branch", () => {
    expect(
      decideWorktreeCleanup(
        facts({
          phase: "cancelled",
          hasRetainedNamedRef: false,
          commitsReachableFromRetainedRef: true}),
      ),
    ).toEqual({
      allow: true,
      reason: "published-complete"});
  });

  it("allows discarded unpublished runs only with discard confirmation", () => {
    expect(
      decideWorktreeCleanup(
        facts({
          phase: "cancelled",
          hasRetainedNamedRef: false,
          commitsReachableFromRetainedRef: false,
          discard: false}),
      ),
    ).toEqual({
      allow: false,
      reason: "unpublished-requires-discard"});

    expect(
      decideWorktreeCleanup(
        facts({
          phase: "cancelled",
          hasRetainedNamedRef: false,
          commitsReachableFromRetainedRef: false,
          discard: true}),
      ),
    ).toEqual({
      allow: true,
      reason: "discarded-unpublished"});
  });

  it("refuses dirty, non-settled, path-invalid, unregistered, and common-dir mismatches", () => {
    expect(decideWorktreeCleanup(facts({ dirty: true })).allow).toBe(false);
    expect(decideWorktreeCleanup(facts({ phase: "executing" })).allow).toBe(false);
    expect(decideWorktreeCleanup(facts({ phase: "blocked" })).allow).toBe(false);
    expect(decideWorktreeCleanup(facts({ pathValid: false })).allow).toBe(false);
    expect(decideWorktreeCleanup(facts({ registered: false })).allow).toBe(false);
    expect(decideWorktreeCleanup(facts({ gitCommonDirMatches: false })).allow).toBe(false);
  });

  it("refuses non-worktree kinds", () => {
    expect(decideWorktreeCleanup(facts({ workspaceKind: "legacy-shared" })).allow).toBe(false);
    expect(decideWorktreeCleanup(facts({ workspaceKind: "git-disabled" })).allow).toBe(false);
  });

  it("refuses completed detached unpublished history without discard", () => {
    expect(
      decideWorktreeCleanup(
        facts({
          hasRetainedNamedRef: false,
          commitsReachableFromRetainedRef: false,
          discard: false}),
      ),
    ).toEqual({
      allow: false,
      reason: "unpublished-requires-discard"});
  });
});
