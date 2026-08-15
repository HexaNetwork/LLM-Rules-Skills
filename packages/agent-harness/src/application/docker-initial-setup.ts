import { loadRunWorkspace } from "../config/io.js";
import type { HarnessConfig } from "../config/schema.js";
import { HarnessFailure } from "../errors.js";
import type { DockerClient } from "../infrastructure/container/types.js";

/**
 * After Approve & build creates the host worktree, the host owns workflow
 * advance. This remains as a readiness check so callers do not spawn git
 * against the worker constant `/workspace`.
 */
export async function continueDockerRunAfterWorkspaceReady(input: {
  projectConfig: HarnessConfig;
  runId: string;
  docker: DockerClient;
  projectKey?: string;
  runDirectory?: string;
  onProgress?: (message: string) => void;
  stateServiceEndpoint?: string;
  providerCaCertificatePath?: string;
  issueStateCredential?: (
    runId: string,
    options: { workerInstanceId: string },
  ) => Promise<{ token: string }>;
}): Promise<void> {
  const workspace = await loadRunWorkspace(input.projectConfig, input.runId, {
    ...(input.runDirectory ? { runDirectory: input.runDirectory } : {}),
  });
  if (workspace.kind !== "host-worktree") {
    throw new HarnessFailure(
      "Host initial setup requires a host-worktree workspace.",
      "execution",
      false,
    );
  }
  input.onProgress?.("Host worktree is ready; lifecycle stays on the host");
}
