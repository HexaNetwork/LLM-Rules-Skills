import { describe, expect, it, vi } from "vitest";
import { continueDockerRunAfterWorkspaceReady } from "../../src/application/docker-initial-setup.js";
import type { DockerClient } from "../../src/infrastructure/container/types.js";
import type { HarnessConfig } from "../../src/config/schema.js";

vi.mock("../../src/config/io.js", () => ({
  loadRunWorkspace: vi.fn(),
}));

vi.mock("../../src/application/docker-worker-session.js", () => ({
  ensureDockerWorkerSession: vi.fn(),
}));

import { loadRunWorkspace } from "../../src/config/io.js";
import { ensureDockerWorkerSession } from "../../src/application/docker-worker-session.js";

describe("continueDockerRunAfterWorkspaceReady", () => {
  it("starts the worker and invokes advance against the docker-clone", async () => {
    const invoke = vi.fn(async () => ({ runId: "run-1", phase: "reflecting", revision: 2 }));
    vi.mocked(loadRunWorkspace).mockResolvedValue({
      version: 1,
      kind: "docker-clone",
      controlRoot: "D:/repo",
      containerName: "ah-project-run-1",
      workspaceVolumeName: "ah-ws-project-run-1",
      workspacePath: "/workspace",
      imageDigest: "sha256:abc",
      baseSha: "deadbeef",
      seedBundleHash: "sha256:bundle",
      generation: 0,
      baseBranch: "main",
      createdAt: new Date().toISOString(),
    });
    vi.mocked(ensureDockerWorkerSession).mockResolvedValue({
      execution: { runtime: "docker", lifecycle: "running" } as never,
      client: { invoke } as never,
      secretFilePath: "secret",
    });

    const progress: string[] = [];
    await continueDockerRunAfterWorkspaceReady({
      projectConfig: { repositoryRoot: "D:/repo" } as HarnessConfig,
      runId: "run-1",
      docker: {} as DockerClient,
      onProgress: (message) => progress.push(message),
    });

    expect(ensureDockerWorkerSession).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        image: "sha256:abc",
        workspaceVolumeName: "ah-ws-project-run-1",
        containerName: "ah-project-run-1",
        startIfMissing: true,
      }),
    );
    expect(invoke).toHaveBeenCalledWith("advance", {});
    expect(progress.some((message) => /Docker worker/i.test(message))).toBe(true);
  });

  it("rejects non-docker workspaces", async () => {
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
    ).rejects.toThrow(/docker-clone workspace/i);
  });
});
