import path from "node:path";
import {
  runCommand,
  type CommandEnvironmentOptions,
  type CommandResult,
} from "../commands.js";
import type { AgentBackend } from "../infrastructure/agents/types.js";
import type { AgentCoordinator } from "../infrastructure/agents/agent-coordinator.js";
import { AgentCoordinator as AgentCoordinatorImpl } from "../infrastructure/agents/agent-coordinator.js";
import type { HarnessConfig } from "../config/schema.js";
import type { GitService } from "../git.js";
import { GitService as GitServiceImpl } from "../git.js";
import {
  createRepositoryIntelligenceBroker,
  runExecutable,
  type ExecutableRunner,
  type RepositoryIntelligenceBroker,
} from "../infrastructure/repository-intelligence/index.js";
import type { LocalKnowledgeBase } from "../knowledge.js";
import { LocalKnowledgeBase as LocalKnowledgeBaseImpl } from "../knowledge.js";
import { RunStore } from "../store.js";
import { LocalTracker, type TrackerPort } from "../tracker.js";
import {
  resolveWorkspaceProvisioner,
  type WorkspaceProvisioner,
} from "../workspace/index.js";
import type { HarnessHomePaths, ProjectPaths } from "./harness-home.js";
import { resolveHarnessPaths, type HarnessPaths } from "./paths.js";
import type { DockerClient } from "../infrastructure/container/types.js";
import { createDockerClient } from "../infrastructure/container/docker-client.js";
import type { RunRepository } from "./run-repository.js";
import type { RunStatePort } from "./run-state-port.js";
import type { RunWorkspace } from "../domain.js";

export type Clock = { now(): Date };

/** Optional external registration context threaded into run composition. */
export type ProjectContext = {
  home: HarnessHomePaths;
  paths: ProjectPaths;
};

export type RunCommandOptions = {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
} & CommandEnvironmentOptions;

export type CommandRunner = {
  run(command: string, options: RunCommandOptions): Promise<CommandResult>;
};

/** Narrow injectable bundle used by application services. */
export type ApplicationDependencies = {
  paths: HarnessPaths;
  store: RunRepository;
  agents: AgentCoordinator;
  tracker: TrackerPort;
  knowledge: LocalKnowledgeBase;
  git: GitService;
  commands: CommandRunner;
  clock: Clock;
  sleep(ms: number): Promise<void>;
  repositoryIntelligence: RepositoryIntelligenceBroker;
  repositoryIntelligenceRunner: ExecutableRunner;
  workspaceProvisioner: WorkspaceProvisioner;
  /** Argv Docker client (real or fake); used for Docker-mode readiness/image builds. */
  docker: DockerClient;
  projectContext?: ProjectContext;
  runStatePort?: RunStatePort;
  workspace?: RunWorkspace;
};

/** Public construction seam for HarnessEngine / openRunHarness. */
export type HarnessDependencies = {
  backend: AgentBackend;
  tracker?: TrackerPort;
  store?: RunRepository;
  knowledge?: LocalKnowledgeBase;
  git?: GitService;
  repositoryIntelligence?: RepositoryIntelligenceBroker;
  repositoryIntelligenceRunner?: ExecutableRunner;
  workspaceProvisioner?: WorkspaceProvisioner;
  /** Test seam / Docker-mode control plane; defaults to argv Docker CLI client. */
  docker?: DockerClient;
  /** Test seam for provider-retry backoff; defaults to real wall-clock sleep. */
  sleep?: (ms: number) => Promise<void>;
  clock?: Clock;
  commands?: CommandRunner;
  paths?: HarnessPaths;
  projectContext?: ProjectContext;
  runStatePort?: RunStatePort;
  workspace?: RunWorkspace;
};

export const systemClock: Clock = {
  now: () => new Date(),
};

export const processCommandRunner: CommandRunner = {
  run: (command, options) => runCommand(command, options),
};

export function createApplicationDependencies(
  config: HarnessConfig,
  dependencies: HarnessDependencies,
): ApplicationDependencies {
  const paths = dependencies.paths ?? resolveHarnessPaths(config);
  const store = dependencies.store ?? new RunStore(config, paths.stateRoot);
  const docker = dependencies.docker ?? createDockerClient();
  const workspaceProvisioner =
    dependencies.workspaceProvisioner ??
    resolveWorkspaceProvisioner(config, {
      paths,
      store,
      docker,
      projectKey: dependencies.projectContext?.paths
        ? path.basename(dependencies.projectContext.paths.projectStateRoot)
        : undefined,
    });
  const repositoryIntelligenceRunner: ExecutableRunner =
    dependencies.repositoryIntelligenceRunner ??
    runExecutable;
  const repositoryIntelligence =
    dependencies.repositoryIntelligence ??
    createRepositoryIntelligenceBroker({
      config,
      paths,
      runner: repositoryIntelligenceRunner,
      withRefreshLock: (providerId, work) =>
        store.withSharedIndexLock(
          { runId: "repository-intelligence", action: `refresh-${providerId}` },
          work,
        ),
    });
  const project = dependencies.projectContext;
  const knowledge =
    dependencies.knowledge ??
    new LocalKnowledgeBaseImpl(
      config,
      repositoryIntelligence,
      paths,
      {
        projectRoot:
          config.knowledge.guidance.projectRoot ?? project?.paths.projectGuidanceRoot,
        sharedRoot:
          config.knowledge.guidance.sharedRoot ?? project?.home.sharedGuidanceRoot,
        runsRoot: project?.paths.runsRoot ?? path.join(paths.stateRoot, "runs"),
      },
    );
  return {
    paths,
    store,
    knowledge,
    tracker: dependencies.tracker ?? new LocalTracker(store),
    git: dependencies.git ?? new GitServiceImpl(config, paths),
    agents: new AgentCoordinatorImpl(config, dependencies.backend, store, knowledge, paths),
    commands: dependencies.commands ?? processCommandRunner,
    clock: dependencies.clock ?? systemClock,
    sleep: dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    repositoryIntelligence,
    repositoryIntelligenceRunner,
    workspaceProvisioner,
    docker,
    projectContext: dependencies.projectContext,
    runStatePort: dependencies.runStatePort,
    workspace: dependencies.workspace,
  };
}
