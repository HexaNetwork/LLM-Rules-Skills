import type { AgentBackend } from "../../infrastructure/agents/types.js";
import type { HarnessConfig } from "../../config/schema.js";
import type { ExecutableRunner } from "../../infrastructure/repository-intelligence/index.js";
import type { LocalKnowledgeBase } from "../../knowledge.js";
import type { RunStore } from "../../store.js";
import type { RunJobService } from "../run-job-service.js";
import type { DockerClient } from "../../infrastructure/container/types.js";
import type { ExecutionRuntimeStatus } from "../../application/execution-runtime-status.js";
import type { HostRunLifecycleService } from "../../vnext/plugins/host-run-lifecycle.js";

export type UiAppContext = {
  getProjectConfig(): HarnessConfig;
  setProjectConfig(config: HarnessConfig): void;
  store: RunStore;
  knowledge: LocalKnowledgeBase;
  backend: AgentBackend;
  configPath?: string;
  agentReadiness: { ready: boolean; message?: string };
  jobs: RunJobService;
  runLifecycle: HostRunLifecycleService;
  repositoryIntelligenceRunner?: ExecutableRunner;
  /** Optional argv Docker client for execution readiness probes. */
  docker?: DockerClient;
  /**
   * Cached/lazy execution runtime status for bootstrap (slice 2 service API).
   * Pass `{ force: true }` for create-run gates so policy/Docker changes are not stale.
   */
  getExecutionStatus?: (options?: {
    force?: boolean;
  }) => Promise<ExecutionRuntimeStatus>;
  workerState: {
    endpoint(): string;
    issueCredential(runId: string, options: { workerInstanceId: string }): Promise<{ token: string }>;
  };
};
