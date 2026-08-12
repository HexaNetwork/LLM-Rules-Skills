import { describe, expect, it } from "vitest";
import {
  offersPreflightCommitOrders,
  preflightCommitUnavailableMessage} from "../../src/application/helpers.js";

describe("preflight commit-order gate", () => {
  it("offers commit-order controls only for legacy-shared workspaces", () => {
    expect(offersPreflightCommitOrders("legacy-shared")).toBe(true);
    expect(offersPreflightCommitOrders("git-worktree")).toBe(false);
    expect(offersPreflightCommitOrders("git-disabled")).toBe(false);
  });

  it("explains that worktree runs use committed-base semantics", () => {
    expect(preflightCommitUnavailableMessage("git-worktree")).toMatch(
      /committed base|worktree|not offered/i,
    );
  });
});
