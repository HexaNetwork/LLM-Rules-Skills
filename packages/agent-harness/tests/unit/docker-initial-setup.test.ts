import { describe, expect, it, vi } from "vitest";
import { continueDockerRunAfterWorkspaceReady } from "../../src/application/docker-initial-setup.js";
import type { DockerClient } from "../../src/infrastructure/container/types.js";
import type { HarnessConfig } from "../../src/config/schema.js";

vi.mock("../../src/config/io.js", () => ({
  loadRunWorkspace: vi.fn(),
}));

import { loadRunWorkspace } from "../../src/config/io.js";

describe("continueDockerRunAfterWorkspaceReady", () => {
  it("accepts a host-worktree and leaves lifecycle on the host", async () => {
    vi.mocked(loadRunWorkspace).mockResolvedValue({
      version: 1,
      kind: "host-worktree",
      controlRoot: "D:/repo",
      worktreePath: "D:/state/worktrees/run-1",
      gitCommonDir: "D:/repo/.git",
      workspacePath: "/workspace",
      baseSha: "deadbeef",
      baseBranch: "main",
      createdAt: new Date().toISOString(),
    });

    const progress: string[] = [];
    await continueDockerRunAfterWorkspaceReady({
      projectConfig: { repositoryRoot: "D:/repo" } as HarnessConfig,
      runId: "run-1",
      docker: {} as DockerClient,
      onProgress: (message) => progress.push(message),
    });

    expect(progress.some((message) => /host/i.test(message))).toBe(true);
  });

  it("rejects workspaces the host does not own", async () => {
    vi.mocked(loadRunWorkspace).mockResolvedValue({
      version: 1,
      kind: "git-disabled",
      controlRoot: "D:/repo",
      createdAt: new Date().toISOString(),
    });

    await expect(
      continueDockerRunAfterWorkspaceReady({
        projectConfig: { repositoryRoot: "D:/repo" } as HarnessConfig,
        runId: "run-1",
        docker: {} as DockerClient,
      }),
    ).rejects.toThrow(/host-worktree/i);
  });
});
