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
    const value: unknown = resolved.endsWith(".json") ? JSON.parse(raw) : yaml.load(raw);
    if (!isRecord(value)) throw new Error("Harness config must contain an object");

    const parsedPatch = ProjectSettingsPatchSchema.parse(patch);
    const workflow = isRecord(value.workflow) ? value.workflow : {};
    const commands = isRecord(value.commands) ? value.commands : {};
    const git = isRecord(value.git) ? value.git : {};
    const candidate = {
      ...value,
      ...(parsedPatch.workflow
        ? { workflow: { ...workflow, ...parsedPatch.workflow } }
        : {}),
      ...(parsedPatch.commands
        ? { commands: { ...commands, ...parsedPatch.commands } }
        : {}),
      ...(parsedPatch.git ? { git: { ...git, ...parsedPatch.git } } : {}),
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
