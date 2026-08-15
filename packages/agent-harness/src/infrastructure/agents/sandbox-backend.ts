import { randomUUID } from "node:crypto";
import { HarnessFailure } from "../../errors.js";
import { harnessWorkerEnv, type SandboxProvider } from "../../sandbox/index.js";
import type { DockerExecutionPolicy } from "../../config/schema.js";
import type { AgentBackend, AgentBackendResult, AgentRequest } from "./types.js";

export type SandboxAgentBackendOptions = {
  sandboxProvider: SandboxProvider;
  image: () => string | undefined;
  dockerPolicy: () => DockerExecutionPolicy;
  rpcUrl: () => string;
  projectKey?: string;
  issueCapability(
    runId: string,
    workerInstanceId: string,
  ): Promise<{ token: string }>;
  revokeCapability(runId: string): Promise<void>;
  publicReadOnlyMounts?: () => ReadonlyArray<{ source: string; target: string }>;
};

/**
 * Executes every provider invocation in a fresh container. The host retains
 * workflow, state, Git, and publication ownership.
 */
export class SandboxAgentBackend implements AgentBackend {
  constructor(private readonly options: SandboxAgentBackendOptions) {}

  readiness(): { ready: boolean; message?: string } {
    return this.options.image()?.trim()
      ? { ready: true }
      : { ready: false, message: "A digest-pinned worker image is required." };
  }

  workspaceCapabilities() {
    return { canRestrictWritableWorkspace: true, providerId: "cursor-sandbox" };
  }

  async run(request: AgentRequest): Promise<AgentBackendResult> {
    const image = this.options.image()?.trim();
    if (!image) throw new HarnessFailure("Worker image is not configured", "execution", false);
    if (!request.runId) throw new HarnessFailure("Sandbox invocation requires a run ID", "execution", false);
    const workerInstanceId = randomUUID();
    const name = sandboxName(this.options.projectKey ?? "project", request.runId, workerInstanceId);
    const issued = await this.options.issueCapability(request.runId, workerInstanceId);
    let sandbox: Awaited<ReturnType<SandboxProvider["create"]>> | undefined;
    let primaryError: unknown;
    try {
      sandbox = await this.options.sandboxProvider.create({
        name,
        image,
        projectKey: this.options.projectKey ?? "project",
        runId: request.runId,
        workspace: { kind: "bind", hostPath: request.cwd },
        dockerPolicy: this.options.dockerPolicy(),
        env: harnessWorkerEnv({ rpcUrl: this.options.rpcUrl(), token: issued.token }),
        publicReadOnlyMounts: this.options.publicReadOnlyMounts?.(),
      });
      const wireRequest = {
        runId: request.runId,
        role: request.role,
        model: request.model,
        prompt: request.prompt,
        continuationPrompt: request.continuationPrompt,
        providerSessionId: request.providerSessionId,
        retainProviderSession: request.retainProviderSession,
        mode: request.mode,
        allowTools: request.allowTools,
        sandboxEnabled: true,
        taskId: request.taskId,
      };
      const result = await sandbox.exec(
        ["/opt/agent-harness/cli", "sandbox-agent-child"],
        {
          timeoutMs: 30 * 60_000,
          input: JSON.stringify(wireRequest),
          signal: request.signal,
        },
      );
      if (result.exitCode !== 0) {
        throw new HarnessFailure(
          `Sandbox agent failed: ${result.stderr || result.stdout}`,
          "provider",
          true,
        );
      }
      const line = result.stdout.trim().split(/\r?\n/).at(-1);
      if (!line) throw new HarnessFailure("Sandbox agent returned no result", "provider", true);
      return JSON.parse(line) as AgentBackendResult;
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      const cleanup = await Promise.allSettled([
        sandbox?.destroy() ?? Promise.resolve(),
        this.options.revokeCapability(request.runId),
      ]);
      if (!primaryError) {
        const failed = cleanup.find(
          (entry): entry is PromiseRejectedResult => entry.status === "rejected",
        );
        if (failed) throw failed.reason;
      }
    }
  }
}

function sandboxName(projectKey: string, runId: string, invocationId: string): string {
  const safe = (value: string, length: number) =>
    value.replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, length);
  return `ah-${safe(projectKey, 20)}-${safe(runId, 20)}-${safe(invocationId, 12)}`
    .toLowerCase()
    .slice(0, 63);
}
