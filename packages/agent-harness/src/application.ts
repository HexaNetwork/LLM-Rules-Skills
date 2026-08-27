import path from "node:path";
import { Store } from "./store.js";
import { ContainerRuntime } from "./container-runtime.js";
import { AgentRuntime } from "./agent-runtime.js";
import { EnvironmentManager } from "./environment-manager.js";
import { GitRuntime } from "./git-runtime.js";
import { WorkflowEngine } from "./workflow-engine.js";
import { Coordinator } from "./coordinator.js";
import { ApiServer } from "./api-server.js";
import { WORKFLOWS } from "./workflows/index.js";
import { readConfig } from "./config.js";

export async function createApplication(home: string) {
  const config = await readConfig(home); const store = await Store.open(home); const worktreeRoot = path.join(home, "worktrees");
  const containers = new ContainerRuntime({ runnerImage: config.runnerImage, buildRoot: path.join(home, "builds") });
  const agent = new AgentRuntime(containers); const environments = new EnvironmentManager(containers, store); const git = new GitRuntime(worktreeRoot);
  const engine = new WorkflowEngine({ store, workflows: WORKFLOWS, agent, containers, environments, git, worktreeRoot });
  const coordinator = new Coordinator(store, engine, environments, worktreeRoot); const api = new ApiServer(store, coordinator, home, containers);
  return { store, containers, agent, environments, git, engine, coordinator, api, async close() { await api.close().catch(() => undefined); await coordinator.stop(); store.close(); } };
}
