import { describe, expect, it } from "vitest";
import { resolveRunBaseBranch } from "../../src/application/run-base-branch.js";
import { HarnessConfigSchema } from "../../src/config/schema.js";

function config(baseBranch: string, enabled = true) {
  return HarnessConfigSchema.parse({
    repositoryRoot: ".",
    git: { enabled, baseBranch },
  });
}

describe("resolveRunBaseBranch", () => {
  it("keeps an explicitly configured branch when it exists", async () => {
    const resolved = await resolveRunBaseBranch(config("release"), undefined, {
      listLocalBranches: async () => ["feature", "release"],
      currentBranch: async () => "feature",
    });
    expect(resolved).toBe("release");
  });

  it("falls back to the current branch when the generic default is absent", async () => {
    const resolved = await resolveRunBaseBranch(config("main"), undefined, {
      listLocalBranches: async () => ["develop", "season-9"],
      currentBranch: async () => "season-9",
    });
    expect(resolved).toBe("season-9");
  });

  it("accepts an arbitrary explicit local branch", async () => {
    const resolved = await resolveRunBaseBranch(config("main"), "custom/trunk", {
      listLocalBranches: async () => ["custom/trunk"],
      currentBranch: async () => "custom/trunk",
    });
    expect(resolved).toBe("custom/trunk");
  });

  it("fails clearly when no safe branch can be inferred", async () => {
    await expect(
      resolveRunBaseBranch(config("main"), undefined, {
        listLocalBranches: async () => ["alpha", "beta"],
        currentBranch: async () => undefined,
      }),
    ).rejects.toThrow(/select a base branch|git\.baseBranch/i);
  });
});
