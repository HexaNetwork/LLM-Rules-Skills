import type { HarnessConfig } from "../../config/schema.js";
import type { HarnessPaths } from "../../application/paths.js";
import { CodeGraphAdapter } from "./adapters/codegraph-adapter.js";
import { GitNexusAdapter } from "./adapters/gitnexus-adapter.js";
import { RepositoryIntelligenceBroker } from "./broker.js";
import { runExecutable } from "./executable-runner.js";
import type { ExecutableRunner, RepositoryCapability } from "./types.js";

export * from "./types.js";
export { RepositoryIntelligenceBroker } from "./broker.js";
export { CodeGraphAdapter } from "./adapters/codegraph-adapter.js";
export { GitNexusAdapter } from "./adapters/gitnexus-adapter.js";
export { runExecutable } from "./executable-runner.js";

export function createRepositoryIntelligenceBroker(options: {
  config: HarnessConfig;
  paths: HarnessPaths;
  runner?: ExecutableRunner;
  withRefreshLock?: <T>(providerId: string, work: () => Promise<T>) => Promise<T>;
}): RepositoryIntelligenceBroker {
  const { config, paths } = options;
  const settings = config.knowledge.repositoryIntelligence;
  const runner = options.runner ?? runExecutable;
  const maxCharacters = config.workflow.repositoryContextCharacters;
  const adapters = [
    new GitNexusAdapter(
      paths,
      {
        ...settings.providers.gitnexus,
        sourceExtensions: settings.sourceExtensions,
        maxCharacters,
      },
      runner,
    ),
    new CodeGraphAdapter(
      paths,
      {
        ...settings.providers.codegraph,
        maxFiles: settings.providers.codegraph.maxResults,
        sourceExtensions: settings.sourceExtensions,
        maxCharacters,
      },
      runner,
    ),
  ];
  return new RepositoryIntelligenceBroker({
    adapters,
    routes: settings.enabled
      ? settings.routes as Record<RepositoryCapability, string[]>
      : {},
    withRefreshLock: options.withRefreshLock,
  });
}
