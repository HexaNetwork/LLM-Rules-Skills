import { loadRunWorkspace } from "../config/io.js";
import type { HarnessConfig } from "../config/schema.js";
import { HarnessFailure } from "../errors.js";
import type { DockerClient } from "../infrastructure/container/types.js";
import { ensureDockerWorkerSession } from "./docker-worker-session.js";

/**
 * After Approve & build creates a docker-clone workspace, finish `new`-phase setup
 * inside the worker where `/workspace` is a real mount.
 *
 * Invokes the existing `advance` RPC so already-built worker images keep working.
 * Newer workers run repository setup when phase is still `new`.
 *
 * Host-side `runInitialSetupThenAdvance` must not spawn git/codegraph against the
 * worker constant `/workspace` — on Windows that surfaces as the misleading
 * `spawn git ENOENT`.
 */
export async function continueDockerRunAfterWorkspaceReady(input: {
  projectConfig: HarnessConfig;
  runId: string;
  docker: DockerClient;
  projectKey?: string;
  /** Prefer store run directory when projectConfig.stateDirectory is wrong/stale. */
  runDirectory?: string;
  onProgress?: (message: string) => void;
}): Promise<void> {
  const workspace = await loadRunWorkspace(input.projectConfig, input.runId, {
    ...(input.runDirectory ? { runDirectory: input.runDirectory } : {}),
  });
  if (workspace.kind !== "docker-clone") {
    throw new HarnessFailure(
      "Docker initial setup requires a docker-clone workspace. Create the seed-clone before continuing.",
      "execution",
      false,
    );
  }

  input.onProgress?.("Starting Docker worker for repository setup");
  const session = await ensureDockerWorkerSession({
    projectConfig: input.projectConfig,
    runId: input.runId,
    docker: input.docker,
    image: workspace.imageDigest,
    workspaceVolumeName: workspace.workspaceVolumeName,
    containerName: workspace.containerName,
    projectKey: input.projectKey ?? "project",
    startIfMissing: true,
  });

  input.onProgress?.("Advancing run inside Docker worker");
  await session.client.invoke("advance", {});
}
