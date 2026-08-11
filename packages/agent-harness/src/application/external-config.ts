import { mkdir, readFile, writeFile, cp, readdir, stat } from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import {
  HarnessConfigSchema,
  type HarnessConfig,
} from "../config/schema.js";
import { defaultConfigYaml } from "../config/defaults.js";
import { stripLegacyGuidanceSources } from "../config/migrations.js";
import { resolveGuidanceTemplateDirectory } from "../guidance-seed.js";
import { HarnessFailure } from "../errors.js";
import {
  resolveHarnessHome,
  type HarnessHomePaths,
} from "./harness-home.js";
import type { ProjectLookupResult } from "./project-registry.js";
import { ProjectRegistry } from "./project-registry.js";

export type LoadExternalConfigOptions = {
  projectKey?: string;
  repository?: string;
  cwd?: string;
  home?: HarnessHomePaths;
  /** Explicit CLI / env overrides applied after project config. */
  overrides?: Partial<HarnessConfig>;
  /** When true, allow falling back to repository-local agent-harness.config.*. */
  allowLegacy?: boolean;
};

export type LoadedProjectConfig = {
  config: HarnessConfig;
  path: string;
  lookup: ProjectLookupResult;
  legacy: boolean;
};

/**
 * Configuration precedence for a new run:
 * built-in defaults → harness-home defaults → external project config → CLI overrides.
 * Runtime paths are stamped from the registration (outside the policy hash).
 */
export async function loadExternalProjectConfig(
  options: LoadExternalConfigOptions = {},
): Promise<LoadedProjectConfig> {
  const home = options.home ?? resolveHarnessHome();
  const registry = new ProjectRegistry(home);

  let lookup: ProjectLookupResult;
  try {
    lookup = await registry.discover({
      projectKey: options.projectKey,
      repository: options.repository,
      cwd: options.cwd,
    });
  } catch (error) {
    if (options.allowLegacy !== false) {
      const legacy = await tryLoadLegacyConfig(options.cwd ?? process.cwd());
      if (legacy) return legacy;
    }
    throw error;
  }

  await ensureHarnessHomeDefaults(home);
  const homeDefaults = await readOptionalYamlConfig(path.join(home.homeRoot, "config.yaml"));
  const projectFile = await readOptionalYamlConfig(lookup.paths.projectConfigPath);
  if (!projectFile) {
    await writeFile(
      lookup.paths.projectConfigPath,
      externalProjectConfigYaml({
        projectGuidanceRoot: lookup.paths.projectGuidanceRoot,
        sharedGuidanceRoot: home.sharedGuidanceRoot,
        worktreeRoot: lookup.paths.worktreeRoot,
      }),
      "utf8",
    );
  }
  const projectConfig = (await readOptionalYamlConfig(lookup.paths.projectConfigPath)) ?? {};
  const builtIn = yaml.load(defaultConfigYaml()) as Record<string, unknown>;
  const layered = deepMerge(deepMerge(builtIn, homeDefaults ?? {}), projectConfig);
  const withOverrides = deepMerge(layered, (options.overrides ?? {}) as Record<string, unknown>);

  const existingSources =
    isRecord(projectConfig.knowledge) && Array.isArray(projectConfig.knowledge.sources)
      ? (projectConfig.knowledge.sources as unknown[])
      : undefined;
  const stripped = stripLegacyGuidanceSources(existingSources);
  const mergedKnowledge = isRecord(withOverrides.knowledge) ? withOverrides.knowledge : {};
  const homeKnowledge = isRecord(homeDefaults?.knowledge) ? homeDefaults.knowledge : {};
  const homeGuidance = isRecord(homeKnowledge.guidance) ? homeKnowledge.guidance : {};
  const projectKnowledge = isRecord(projectConfig.knowledge) ? projectConfig.knowledge : {};
  const mergedGuidance = isRecord(mergedKnowledge.guidance) ? mergedKnowledge.guidance : {};
  const projectGuidance = isRecord(projectKnowledge.guidance) ? projectKnowledge.guidance : {};

  const merged = HarnessConfigSchema.parse({
    ...withOverrides,
    knowledge: {
      ...mergedKnowledge,
      sources:
        stripped.sources && stripped.sources.length > 0
          ? stripped.sources
          : [
              { path: "README.md", scope: "project", visibility: "private" },
              { path: "docs", scope: "project", visibility: "private" },
            ],
      guidance: {
        ...mergedGuidance,
        projectRoot:
          (typeof projectGuidance.projectRoot === "string" && projectGuidance.projectRoot.trim()) ||
          (typeof homeGuidance.projectRoot === "string" && homeGuidance.projectRoot.trim()) ||
          lookup.paths.projectGuidanceRoot,
        sharedRoot:
          (typeof projectGuidance.sharedRoot === "string" && projectGuidance.sharedRoot.trim()) ||
          (typeof homeGuidance.sharedRoot === "string" && homeGuidance.sharedRoot.trim()) ||
          stripped.sharedRoot ||
          home.sharedGuidanceRoot,
      },
    },
    repositoryRoot: lookup.paths.controlRoot,
    stateDirectory: lookup.paths.projectStateRoot,
    worktreeRoot: lookup.registration.worktreeRoot ?? lookup.paths.worktreeRoot,
  });

  return {
    config: merged,
    path: lookup.paths.projectConfigPath,
    lookup,
    legacy: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function externalProjectConfigYaml(options: {
  projectGuidanceRoot: string;
  sharedGuidanceRoot: string;
  worktreeRoot: string;
}): string {
  // Keep project files sparse so harness-home defaults remain effective.
  const stamped = {
    version: 2,
    repositoryRoot: ".",
    // Load-time stamping replaces this with the absolute project state root.
    stateDirectory: ".",
    worktreeRoot: options.worktreeRoot,
    knowledge: {
      sources: [
        { path: "README.md", scope: "project", visibility: "private" },
        { path: "docs", scope: "project", visibility: "private" },
      ],
      guidance: {
        projectRoot: options.projectGuidanceRoot,
        sharedRoot: options.sharedGuidanceRoot,
      },
    },
  };
  return yaml.dump(stamped, { noRefs: true, lineWidth: -1 });
}

function deepMerge(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const prior = merged[key];
    merged[key] = isRecord(prior) && isRecord(value)
      ? deepMerge(prior, value)
      : value;
  }
  return merged;
}


/** Seed shared guidance under harness home (never into the target repository). */
export async function seedExternalGuidance(
  home: HarnessHomePaths = resolveHarnessHome(),
): Promise<{ sourcePath: string; copied: boolean }> {
  await mkdir(home.sharedGuidanceRoot, { recursive: true });
  const target = path.join(home.sharedGuidanceRoot, "General");
  const templateDirectory = resolveGuidanceTemplateDirectory();
  if (!(await isNonEmptyDirectory(templateDirectory))) {
    throw new HarnessFailure(
      `Guidance templates missing at ${templateDirectory}. Run npm run build in packages/agent-harness.`,
      "config",
      false,
    );
  }
  await mkdir(path.dirname(target), { recursive: true });
  const copiedFiles = await copyMissingGuidanceFiles(templateDirectory, target);
  return { sourcePath: target, copied: copiedFiles > 0 };
}

/** Add newly packaged guidance without overwriting operator-owned shared guidance. */
async function copyMissingGuidanceFiles(source: string, target: string): Promise<number> {
  await mkdir(target, { recursive: true });
  let copied = 0;
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copied += await copyMissingGuidanceFiles(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile() || (await stat(targetPath).catch(() => undefined))) continue;
    await cp(sourcePath, targetPath, { force: false, errorOnExist: false });
    copied += 1;
  }
  return copied;
}

async function ensureHarnessHomeDefaults(home: HarnessHomePaths): Promise<void> {
  await mkdir(home.homeRoot, { recursive: true });
  const homeConfig = path.join(home.homeRoot, "config.yaml");
  try {
    await stat(homeConfig);
  } catch {
    await writeFile(homeConfig, defaultConfigYaml(), "utf8");
  }
  await seedExternalGuidance(home).catch(() => undefined);
}

async function readOptionalYamlConfig(
  filePath: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    const value: unknown = filePath.endsWith(".json") ? JSON.parse(raw) : yaml.load(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function tryLoadLegacyConfig(cwd: string): Promise<LoadedProjectConfig | undefined> {
  const { loadConfig } = await import("../config/io.js");
  try {
    const loaded = await loadConfig(undefined, cwd);
    // Synthesize a lookup-shaped result for callers that only need config+path.
    const home = resolveHarnessHome();
    const registry = new ProjectRegistry(home);
    // Legacy path: no registration; fabricate a non-persisted lookup for path helpers.
    const controlRoot = loaded.config.repositoryRoot;
    const fakeKey = "legacy";
    const { resolveProjectPaths } = await import("./harness-home.js");
    const paths = resolveProjectPaths({
      projectKey: fakeKey,
      controlRoot,
      home,
      worktreeRoot: loaded.config.worktreeRoot,
    });
    return {
      config: loaded.config,
      path: loaded.path,
      lookup: {
        registration: {
          version: 1,
          projectKey: fakeKey,
          displayName: path.basename(controlRoot),
          controlRoot,
          canonicalControlRoot: controlRoot,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
        paths: {
          ...paths,
          // Preserve legacy state under the repository when present.
          projectStateRoot: path.isAbsolute(loaded.config.stateDirectory)
            ? path.resolve(loaded.config.stateDirectory)
            : path.resolve(controlRoot, loaded.config.stateDirectory),
          projectConfigPath: loaded.path,
        },
        home: registry.homePaths,
      },
      legacy: true,
    };
  } catch {
    return undefined;
  }
}

async function isNonEmptyDirectory(directory: string): Promise<boolean> {
  const info = await stat(directory).catch(() => undefined);
  if (!info?.isDirectory()) return false;
  const entries = await readdir(directory);
  return entries.length > 0;
}
