import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import yaml from "js-yaml";
import {
  CONFIG_NAMES,
  HarnessConfigSchema,
  ProjectSettingsPatchSchema,
  type HarnessConfig,
  type ProjectSettingsPatch,
} from "./schema.js";
import { normalizeFrozenRunConfig } from "./migrations.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  const parsed = HarnessConfigSchema.parse(value);
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
  await writeFile(resolved, serialized, "utf8");
  return loadConfig(resolved);
}

export async function loadRunConfig(
  _projectConfig: HarnessConfig,
  runId: string,
): Promise<HarnessConfig> {
  const snapshot = path.resolve(
    _projectConfig.repositoryRoot,
    _projectConfig.stateDirectory,
    "runs",
    runId,
    "config.json",
  );
  const raw: unknown = JSON.parse(await readFile(snapshot, "utf8"));
  return normalizeFrozenRunConfig(raw);
}
