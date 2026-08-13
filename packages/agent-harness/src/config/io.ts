import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import yaml from "js-yaml";
import { resolveHarnessPaths } from "../application/paths.js";
import {
  migrateRunWorkspace,
  WORKSPACE_SCHEMA_VERSION,
  type RunWorkspace,
} from "../domain/workspace.js";
import {
  CONFIG_NAMES,
  HarnessConfigSchema,
  ProjectSettingsPatchSchema,
  type HarnessConfig,
  type ProjectSettingsPatch,
} from "./schema.js";
import { normalizeFrozenRunConfig, rewriteGraphifyConfigKeys } from "./migrations.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const projectConfigWriteQueues = new Map<string, Promise<void>>();

async function withProjectConfigWriteLock<T>(
  configPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = projectConfigWriteQueues.get(configPath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  projectConfigWriteQueues.set(configPath, queued);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (projectConfigWriteQueues.get(configPath) === queued) {
      projectConfigWriteQueues.delete(configPath);
    }
  }
}

export async function loadConfig(
  configPath?: string,
  cwd = process.cwd(),
): Promise<{ config: HarnessConfig; path: string }> {
  let resolved: string | undefined;
  if (configPath) {
    resolved = path.resolve(cwd, configPath);
  } else {
    for (const name of CONFIG_NAMES) {
      const candidate = path.join(cwd, name);
      try {
        await readFile(candidate, "utf8");
        resolved = candidate;
        break;
      } catch {
        // Try the next conventional filename.
      }
    }
  }
  if (!resolved) {
    throw new Error("No harness config found. Run `agent-harness init` first.");
  }
  const raw = await readFile(resolved, "utf8");
  const value: unknown = resolved.endsWith(".json") ? JSON.parse(raw) : yaml.load(raw);
  const parsed = HarnessConfigSchema.parse(rewriteGraphifyConfigKeys(value));
  return {
    path: resolved,
    config: {
      ...parsed,
      repositoryRoot: path.resolve(path.dirname(resolved), parsed.repositoryRoot),
    },
  };
}

export async function writeProjectSettings(
  configPath: string,
  patch: ProjectSettingsPatch,
): Promise<{ config: HarnessConfig; path: string }> {
  const resolved = path.resolve(configPath);
  return withProjectConfigWriteLock(resolved, async () => {
    const raw = await readFile(resolved, "utf8");
    const parsedValue: unknown = resolved.endsWith(".json") ? JSON.parse(raw) : yaml.load(raw);
    const value = rewriteGraphifyConfigKeys(parsedValue);
    if (!isRecord(value)) throw new Error("Harness config must contain an object");

    const parsedPatch = ProjectSettingsPatchSchema.parse(patch);
    const workflow = isRecord(value.workflow) ? value.workflow : {};
    const commands = isRecord(value.commands) ? value.commands : {};
    const git = isRecord(value.git) ? value.git : {};
    const execution = isRecord(value.execution) ? value.execution : {};
    const existingDocker = isRecord(execution.docker) ? execution.docker : {};
    const existingLimits = isRecord(existingDocker.limits) ? existingDocker.limits : {};
    const existingNetwork = isRecord(existingDocker.network) ? existingDocker.network : {};
    const existingSubmoduleLfs = isRecord(existingDocker.submoduleLfs)
      ? existingDocker.submoduleLfs
      : {};
    const existingBundleLimits = isRecord(existingDocker.bundleLimits)
      ? existingDocker.bundleLimits
      : {};
    const knowledge = isRecord(value.knowledge) ? value.knowledge : {};
    const existingRepositoryIntelligence = isRecord(knowledge.repositoryIntelligence)
      ? knowledge.repositoryIntelligence
      : {};
    const existingProviders = isRecord(existingRepositoryIntelligence.providers)
      ? existingRepositoryIntelligence.providers
      : {};
    const existingRoutes = isRecord(existingRepositoryIntelligence.routes)
      ? existingRepositoryIntelligence.routes
      : {};
    const patchRi = parsedPatch.knowledge?.repositoryIntelligence;
    const patchExecution = parsedPatch.execution;
    const patchDocker = patchExecution?.docker;
    const candidate = {
      ...value,
      ...(parsedPatch.workflow
        ? { workflow: { ...workflow, ...parsedPatch.workflow } }
        : {}),
      ...(parsedPatch.commands
        ? { commands: { ...commands, ...parsedPatch.commands } }
        : {}),
      ...(parsedPatch.git ? { git: { ...git, ...parsedPatch.git } } : {}),
      ...(patchExecution
        ? {
            execution: {
              ...execution,
              ...patchExecution,
              ...(patchDocker
                ? {
                    docker: {
                      ...existingDocker,
                      ...patchDocker,
                      ...(patchDocker.limits
                        ? { limits: { ...existingLimits, ...patchDocker.limits } }
                        : {}),
                      ...(patchDocker.network
                        ? { network: { ...existingNetwork, ...patchDocker.network } }
                        : {}),
                      ...(patchDocker.submoduleLfs
                        ? {
                            submoduleLfs: {
                              ...existingSubmoduleLfs,
                              ...patchDocker.submoduleLfs,
                            },
                          }
                        : {}),
                      ...(patchDocker.bundleLimits
                        ? {
                            bundleLimits: {
                              ...existingBundleLimits,
                              ...patchDocker.bundleLimits,
                            },
                          }
                        : {}),
                    },
                  }
                : {}),
            },
          }
        : {}),
      ...(patchRi
        ? {
            knowledge: {
              ...knowledge,
              repositoryIntelligence: {
                ...existingRepositoryIntelligence,
                ...patchRi,
                ...(patchRi.providers
                  ? {
                      providers: {
                        ...existingProviders,
                        ...(patchRi.providers.gitnexus
                          ? {
                              gitnexus: {
                                ...(isRecord(existingProviders.gitnexus)
                                  ? existingProviders.gitnexus
                                  : {}),
                                ...patchRi.providers.gitnexus,
                              },
                            }
                          : {}),
                        ...(patchRi.providers.codegraph
                          ? {
                              codegraph: {
                                ...(isRecord(existingProviders.codegraph)
                                  ? existingProviders.codegraph
                                  : {}),
                                ...patchRi.providers.codegraph,
                              },
                            }
                          : {}),
                      },
                    }
                  : {}),
                ...(patchRi.routes
                  ? {
                      routes: {
                        ...existingRoutes,
                        ...patchRi.routes,
                      },
                    }
                  : {}),
              },
            },
          }
        : {}),
    };
    HarnessConfigSchema.parse(candidate);

    const serialized = resolved.endsWith(".json")
      ? `${JSON.stringify(candidate, null, 2)}\n`
      : yaml.dump(candidate, { noRefs: true, lineWidth: -1 });
    const temporaryPath = `${resolved}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, serialized, "utf8");
      await rename(temporaryPath, resolved);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
    return loadConfig(resolved);
  });
}

export async function loadRunConfig(
  _projectConfig: HarnessConfig,
  runId: string,
): Promise<HarnessConfig> {
  const { stateRoot } = resolveHarnessPaths(_projectConfig);
  const snapshot = path.join(stateRoot, "runs", runId, "config.json");
  const raw: unknown = JSON.parse(await readFile(snapshot, "utf8"));
  return normalizeFrozenRunConfig(raw);
}

export function runWorkspacePath(projectConfig: HarnessConfig, runId: string): string {
  const { stateRoot } = resolveHarnessPaths(projectConfig);
  return path.join(stateRoot, "runs", runId, "workspace.json");
}

/**
 * Load workspace metadata.
 * Missing files are rejected for git-enabled projects; git-disabled projects
 * synthesize an explicit git-disabled workspace (never legacy-shared).
 */
export async function loadRunWorkspace(
  projectConfig: HarnessConfig,
  runId: string,
): Promise<RunWorkspace> {
  const { controlRoot } = resolveHarnessPaths(projectConfig);
  const snapshot = runWorkspacePath(projectConfig, runId);
  try {
    const raw: unknown = JSON.parse(await readFile(snapshot, "utf8"));
    return migrateRunWorkspace(raw, { controlRoot });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (!projectConfig.git.enabled) {
        return migrateRunWorkspace(
          {
            version: WORKSPACE_SCHEMA_VERSION,
            kind: "git-disabled",
            controlRoot,
            createdAt: new Date().toISOString(),
          },
          { controlRoot },
        );
      }
      return migrateRunWorkspace(null, { controlRoot });
    }
    throw error;
  }
}

export async function writeRunWorkspace(
  projectConfig: HarnessConfig,
  runId: string,
  workspace: RunWorkspace,
): Promise<void> {
  const snapshot = runWorkspacePath(projectConfig, runId);
  await writeFile(snapshot, `${JSON.stringify(workspace, null, 2)}\n`, "utf8");
}

/** Host path for restartable execution.json (writers land with the Docker runtime slice). */
export function runExecutionJsonPath(projectConfig: HarnessConfig, runId: string): string {
  const { stateRoot } = resolveHarnessPaths(projectConfig);
  return path.join(stateRoot, "runs", runId, "execution.json");
}

/** Host path for transport/import.json under the run directory. */
export function runTransportImportPath(projectConfig: HarnessConfig, runId: string): string {
  const { stateRoot } = resolveHarnessPaths(projectConfig);
  return path.join(stateRoot, "runs", runId, "transport", "import.json");
}
