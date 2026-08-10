import { describe, expect, it } from "vitest";
import {
  proposeDeliveryBranchName,
  shortRunIdForBranch,
  slugifyFeatureTitle,
} from "../../src/domain/workspace.js";

describe("slugifyFeatureTitle", () => {
  it("lowercases, hyphenates, and trims punctuation", () => {
    expect(slugifyFeatureTitle("Ship a Feature!")).toBe("ship-a-feature");
    expect(slugifyFeatureTitle("  Add Greeting Tone  ")).toBe("add-greeting-tone");
  });

  it("falls back when the title has no usable characters", () => {
    expect(slugifyFeatureTitle("!!!")).toBe("feature");
    expect(slugifyFeatureTitle("   ")).toBe("feature");
  });

  it("avoids bare Windows reserved basenames", () => {
    expect(slugifyFeatureTitle("CON")).toBe("con-feature");
    expect(slugifyFeatureTitle("aux tools")).toMatch(/^aux-/);
  });

  it("bounds slug length so prefix + short id remain usable", () => {
    const long = "A".repeat(120);
    expect(slugifyFeatureTitle(long).length).toBeLessThanOrEqual(48);
  });
});

describe("shortRunIdForBranch", () => {
  it("uses the first 8 alphanumeric characters of the run id", () => {
    expect(shortRunIdForBranch("4e78e0fa-aa32-4709-b904-38e9de2d07e7")).toBe("4e78e0fa");
    expect(shortRunIdForBranch("Worktree-Start-1")).toBe("worktree");
  });

  it("falls back when the run id has no alphanumeric characters", () => {
    expect(shortRunIdForBranch("---")).toBe("run");
  });
});

describe("proposeDeliveryBranchName", () => {
  it("builds branchPrefix/title-slug-shortRunId", () => {
    expect(
      proposeDeliveryBranchName({
        branchPrefix: "harness",
        title: "Ship a Feature",
        runId: "4e78e0fa-aa32-4709-b904-38e9de2d07e7",
      }),
    ).toBe("harness/ship-a-feature-4e78e0fa");
  });

  it("is deterministic for the same title and run id", () => {
    const args = {
      branchPrefix: "feat",
      title: "Add greeting tone",
      runId: "abc12345-rest",
    };
    expect(proposeDeliveryBranchName(args)).toBe(proposeDeliveryBranchName(args));
    expect(proposeDeliveryBranchName(args)).toBe("feat/add-greeting-tone-abc12345");
  });
});
