import {
  runCommand,
  type CommandEnvironmentOptions,
  type CommandResult,
} from "../commands.js";
import type { AgentBackend, AgentCoordinator } from "../agent.js";
import { AgentCoordinator as AgentCoordinatorImpl } from "../agent.js";
import type { HarnessConfig } from "../config.js";
import type { GitService } from "../git.js";
import { GitService as GitServiceImpl } from "../git.js";
import {
  GraphifyRepositoryLookup,
  runGraphify,
  type GraphifyRunner,
  type GraphifySetupRunner,
} from "../graphify.js";
import type { LocalKnowledgeBase } from "../knowledge.js";
import { LocalKnowledgeBase as LocalKnowledgeBaseImpl } from "../knowledge.js";
import { RunStore } from "../store.js";
import { LocalTracker, type TrackerPort } from "../tracker.js";
import type { HarnessHomePaths, ProjectPaths } from "./harness-home.js";
import { resolveHarnessPaths, type HarnessPaths } from "./paths.js";

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
  store: RunStore;
  agents: AgentCoordinator;
  tracker: TrackerPort;
  knowledge: LocalKnowledgeBase;
  git: GitService;
  commands: CommandRunner;
  clock: Clock;
  sleep(ms: number): Promise<void>;
  graphifyRunner: GraphifyRunner;
  graphifySetupRunner?: GraphifySetupRunner;
  projectContext?: ProjectContext;
};

/** Public construction seam retained by HarnessEngine. */
export type HarnessDependencies = {
  backend: AgentBackend;
  tracker?: TrackerPort;
  store?: RunStore;
  knowledge?: LocalKnowledgeBase;
  git?: GitService;
  graphifyRunner?: GraphifyRunner;
  graphifySetupRunner?: GraphifySetupRunner;
  /** Test seam for provider-retry backoff; defaults to real wall-clock sleep. */
  sleep?: (ms: number) => Promise<void>;
  clock?: Clock;
  commands?: CommandRunner;
  paths?: HarnessPaths;
  projectContext?: ProjectContext;
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
  const graphifyRunner = dependencies.graphifyRunner ?? runGraphify;
  const knowledge =
    dependencies.knowledge ??
    new LocalKnowledgeBaseImpl(
      config,
      new GraphifyRepositoryLookup(config, graphifyRunner, paths),
      paths,
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
    graphifyRunner,
    graphifySetupRunner: dependencies.graphifySetupRunner,
    projectContext: dependencies.projectContext,
  };
}
