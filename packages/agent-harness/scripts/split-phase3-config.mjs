import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const configPath = path.join(root, "src", "config.ts");
const backupPath = path.join(root, "src", "config.ts.phase3-backup");
if (!existsSync(backupPath)) copyFileSync(configPath, backupPath);
const lines = readFileSync(backupPath, "utf8").split(/\r?\n/);

function slice(start1, end1) {
  return lines.slice(start1 - 1, end1).join("\n");
}

function write(rel, contents) {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  if (!contents.endsWith("\n")) contents += "\n";
  writeFileSync(file, contents, "utf8");
  console.log(`wrote ${rel} (${contents.split("\n").length - 1} lines)`);
}

// Find line markers
function findLine(re, from = 0) {
  for (let i = from; i < lines.length; i++) if (re.test(lines[i])) return i + 1;
  return -1;
}

const marks = {
  schemaStart: 1,
  harnessSchema: findLine(/^export const HarnessConfigSchema/),
  projectPatch: findLine(/^export const ProjectSettingsPatchSchema/),
  configNames: findLine(/^export const CONFIG_NAMES/),
  loadConfig: findLine(/^export async function loadConfig/),
  writeSettings: findLine(/^export async function writeProjectSettings/),
  loadRun: findLine(/^export async function loadRunConfig/),
  modelForRole: findLine(/^export function modelForRole/),
  defaultYaml: findLine(/^export function defaultConfigYaml/),
  deployYaml: findLine(/^export function deploymentConfigYaml/),
  isRecord: findLine(/^function isRecord/),
  configHash: findLine(/^export function configurationHash/),
  total: lines.length,
};
console.log(marks);

// schema.ts: imports through ProjectSettingsPatch + CONFIG_NAMES + hash helpers
// Lines 1-304 roughly for schemas; hash at end
write(
  "src/config/schema.ts",
  `import { createHash } from "node:crypto";
import { z } from "zod";
import { AgentRoleSchema, type AgentRole } from "../domain.js";

${slice(8, 304)}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Canonical policy view for hashing: keys sorted recursively; environment paths omitted.
 */
function canonicalConfigForHash(config: unknown): unknown {
  return canonicalizeForHash(config, "");
}

/** Stable sha256 over the canonical policy view of a harness config. */
export function configurationHash(config: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalConfigForHash(config)))
    .digest("hex");
}

function canonicalizeForHash(value: unknown, keyPath: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeForHash(item, keyPath));
  }
  if (!isRecord(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const childPath = keyPath ? \`\${keyPath}.\${key}\` : key;
    if (CONFIG_HASH_OMIT_PATHS.has(childPath)) {
      continue;
    }
    out[key] = canonicalizeForHash(value[key], childPath);
  }
  return out;
}
`,
);

// defaults.ts
write(
  "src/config/defaults.ts",
  `import yaml from "js-yaml";
import type { AgentRole } from "../domain.js";
import {
  HarnessConfigSchema,
  type HarnessConfig,
  type KnowledgeScope,
  type KnowledgeVisibility,
} from "./schema.js";

const SMALL_ROLES = new Set<AgentRole>(["prompt-builder", "message-writer"]);

export function modelForRole(config: HarnessConfig, role: AgentRole): string {
  return config.models.roles[role] ??
    (SMALL_ROLES.has(role) ? config.models.small : config.models.capable);
}

${slice(424, 638)}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
`,
);

// migrations.ts — frozen-run / historical normalization
write(
  "src/config/migrations.ts",
  `import { HarnessConfigSchema, type HarnessConfig } from "./schema.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize a frozen per-run config snapshot into a HarnessConfig.
 * Older snapshots without knowledge.guidance keep guidance disabled so
 * in-progress deliveries do not silently change retrieval behavior.
 */
export function normalizeFrozenRunConfig(raw: unknown): HarnessConfig {
  const { configVersion: _configVersion, ...withoutVersion } = isRecord(raw)
    ? raw
    : { configVersion: undefined };
  if (
    isRecord(withoutVersion) &&
    isRecord(withoutVersion.knowledge) &&
    !Object.hasOwn(withoutVersion.knowledge, "guidance")
  ) {
    return HarnessConfigSchema.parse({
      ...withoutVersion,
      knowledge: { ...withoutVersion.knowledge, guidance: { enabled: false } },
    });
  }
  return HarnessConfigSchema.parse(withoutVersion);
}

/**
 * Apply live project policy overlays that are intentionally not frozen
 * (and omitted from configurationHash).
 */
export function applyLiveProjectPolicy(
  frozen: HarnessConfig,
  projectConfig: HarnessConfig,
): HarnessConfig {
  return {
    ...frozen,
    git: {
      ...frozen.git,
      ignoredArtifactPatterns: projectConfig.git.ignoredArtifactPatterns,
    },
    workflow: {
      ...frozen.workflow,
      testPathPatterns: projectConfig.workflow.testPathPatterns,
    },
  };
}
`,
);

// io.ts
write(
  "src/config/io.ts",
  `import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import yaml from "js-yaml";
import {
  CONFIG_NAMES,
  HarnessConfigSchema,
  ProjectSettingsPatchSchema,
  type HarnessConfig,
  type ProjectSettingsPatch,
} from "./schema.js";
import { applyLiveProjectPolicy, normalizeFrozenRunConfig } from "./migrations.js";

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
    throw new Error("No harness config found. Run \`agent-harness init\` first.");
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
    ? \`\${JSON.stringify(candidate, null, 2)}\\n\`
    : yaml.dump(candidate, { noRefs: true, lineWidth: -1 });
  await writeFile(resolved, serialized, "utf8");
  return loadConfig(resolved);
}

export async function loadRunConfig(
  projectConfig: HarnessConfig,
  runId: string,
): Promise<HarnessConfig> {
  const snapshot = path.resolve(
    projectConfig.repositoryRoot,
    projectConfig.stateDirectory,
    "runs",
    runId,
    "config.json",
  );
  const raw: unknown = JSON.parse(await readFile(snapshot, "utf8"));
  const frozen = normalizeFrozenRunConfig(raw);
  return applyLiveProjectPolicy(frozen, projectConfig);
}
`,
);

// barrel
write(
  "src/config.ts",
  `/** Compatibility barrel for config modules (Phase 3). */
export {
  CONFIG_NAMES,
  CONFIG_VERSION,
  DEFAULT_IGNORED_ARTIFACT_PATTERNS,
  HarnessConfigSchema,
  KnowledgeScopeSchema,
  KnowledgeSourceSchema,
  KnowledgeVisibilitySchema,
  PreflightCommitOrderSchema,
  ProjectSettingsPatchSchema,
  configurationHash,
  type HarnessConfig,
  type KnowledgeScope,
  type KnowledgeSource,
  type KnowledgeVisibility,
  type PreflightCommitOrder,
  type ProjectSettingsPatch,
} from "./config/schema.js";
export {
  defaultConfigYaml,
  deploymentConfigYaml,
  modelForRole,
} from "./config/defaults.js";
export {
  loadConfig,
  loadRunConfig,
  writeProjectSettings,
} from "./config/io.js";
export {
  applyLiveProjectPolicy,
  normalizeFrozenRunConfig,
} from "./config/migrations.js";
`,
);

console.log("config split complete");
