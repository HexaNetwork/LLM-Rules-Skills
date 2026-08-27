import { describe, expect, it } from "vitest";
import { resolveWorktreeRoot } from "../../src/domain/worktree-paths.js";

describe("resolveWorktreeRoot", () => {
  it("uses harness home by default (WSL worktrees are opt-in)", async () => {
    delete process.env.AGENT_HARNESS_WSL_WORKTREES;
    delete process.env.AGENT_HARNESS_DISABLE_WSL_WORKTREES;
    const root = await resolveWorktreeRoot("D:/data/agent-harness", "app-deadbeef");
    expect(root.replace(/\\/g, "/")).toBe("D:/data/agent-harness/projects/app-deadbeef/worktrees");
  });

  it("prefers WSL ext4 paths on Windows when WSL worktrees are enabled", async () => {
    if (process.platform !== "win32") return;
    process.env.AGENT_HARNESS_WSL_WORKTREES = "1";
    delete process.env.AGENT_HARNESS_DISABLE_WSL_WORKTREES;
    const root = await resolveWorktreeRoot("C:/Users/me/AppData/Local/agent-harness", "proj");
    const normalized = root.replace(/\\/g, "/").toLowerCase();
    const usesWsl = normalized.includes("//wsl") || normalized.includes("wsl.localhost");
    const usesHarnessHome = normalized.includes("/agent-harness/projects/proj/worktrees");
    expect(usesWsl || usesHarnessHome).toBe(true);
    delete process.env.AGENT_HARNESS_WSL_WORKTREES;
  });
});
