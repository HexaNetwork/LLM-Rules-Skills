import type { AgentBackend } from "../../infrastructure/agents/types.js";
import type { HarnessConfig } from "../../config/schema.js";
import type { CodegraphRunner } from "../../codegraph.js";
import type { LocalKnowledgeBase } from "../../knowledge.js";
import type { RunStore } from "../../store.js";
import type { RunJobService } from "../run-job-service.js";

export type UiAppContext = {
  getProjectConfig(): HarnessConfig;
  setProjectConfig(config: HarnessConfig): void;
  store: RunStore;
  knowledge: LocalKnowledgeBase;
  backend: AgentBackend;
  configPath?: string;
  agentReadiness: { ready: boolean; message?: string };
  jobs: RunJobService;
  codegraphRunner?: CodegraphRunner;
};
