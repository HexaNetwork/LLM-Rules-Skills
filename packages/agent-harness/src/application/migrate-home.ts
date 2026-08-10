import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { CONFIG_NAMES, HarnessConfigSchema } from "../config/schema.js";
import { canonicalizeWorkspacePath } from "../domain/workspace.js";
import { HarnessFailure } from "../errors.js";
import {
  resolveHarnessHome,
  type HarnessHomePaths,
} from "./harness-home.js";
import { ProjectRegistry, type ProjectLookupResult } from "./project-registry.js";
import { seedExternalGuidance } from "./external-config.js";

export type MigrateHomeOptions = {
  repository: string;
  home?: HarnessHomePaths;
  name?: string;
  /** When true, also remove validated repository-local harness files after success. */
  cleanup?: boolean;
  now?: () => Date;
};

export type MigrateHomeResult = {
  lookup: ProjectLookupResult;
  copiedFiles: number;
  contentHashMatches: boolean;
  removablePaths: string[];
  cleaned: boolean;
  notes: string[];
};

const ACTIVE_PHASES = new Set([
  "new",
  "reflecting",
  "grilling",
  "planning",
  "awaiting_decision",
  "executing",
  "reviewing",
  "publishing",
  "blocked",
]);

/**
 * Copy-validate a repository-local harness install into the external home.
 * Leaves originals untouched until an explicit cleanup pass.
 */
export async function migrateHome(options: MigrateHomeOptions): Promise<MigrateHomeResult> {
  const repository = path.resolve(options.repository);
  const home = options.home ?? resolveHarnessHome();
  const notes: string[] = [];

  const legacyConfigPath = await findLegacyConfig(repository);
  if (!legacyConfigPath) {
    throw new HarnessFailure(
      `No repository-local harness config found under ${repository}. Nothing to migrate.`,
      "config",
      false,
    );
  }

  const legacyStateRoot = path.join(repository, ".agent-harness");
  await assertNoActivelyMutatingRun(legacyStateRoot);

  const registry = new ProjectRegistry(home);
  let lookup: ProjectLookupResult;
  try {
    lookup = await registry.discover({ repository });
    notes.push(`Reusing existing registration ${lookup.registration.projectKey}`);
  } catch {
    lookup = await registry.add({
      repository,
      name: options.name,
      home,
      now: options.now,
    });
    notes.push(`Created registration ${lookup.registration.projectKey}`);
  }

  await seedExternalGuidance(home);
  const guidanceSource = path.join(repository, "agent-harness", "guidance");
  if (await exists(guidanceSource)) {
    await cp(guidanceSource, lookup.paths.projectGuidanceRoot, { recursive: true });
    notes.push(`Copied project guidance into ${lookup.paths.projectGuidanceRoot}`);
  }

  const legacyConfigRaw = await readFile(legacyConfigPath, "utf8");
  const legacyValue: unknown = legacyConfigPath.endsWith(".json")
    ? JSON.parse(legacyConfigRaw)
    : yaml.load(legacyConfigRaw);
  const parsed = HarnessConfigSchema.parse(legacyValue);
  const externalConfig = {
    ...parsed,
    repositoryRoot: ".",
    stateDirectory: lookup.paths.projectStateRoot,
    worktreeRoot: lookup.paths.worktreeRoot,
  };
  await writeFile(
    lookup.paths.projectConfigPath,
    yaml.dump(externalConfig, { noRefs: true, lineWidth: -1 }),
    "utf8",
  );

  let copiedFiles = 0;
  if (await exists(legacyStateRoot)) {
    copiedFiles = await copyDirectoryContents(legacyStateRoot, lookup.paths.projectStateRoot, [
      "registration.json",
      "config.yaml",
    ]);
  }

  await rewriteWorkspacePaths(lookup.paths.runsRoot, {
    controlRoot: canonicalizeWorkspacePath(repository),
    // Keep existing worktree paths; only rewrite controlRoot identity.
  });

  const validation = await validateCopiedTree(legacyStateRoot, lookup.paths.projectStateRoot);
  if (!validation.ok) {
    throw new HarnessFailure(
      `Migration validation failed: ${validation.reason}. Original data left untouched.`,
      "config",
      false,
    );
  }
  const contentHashMatches = true;
  notes.push(
    `Validated ${validation.fileCount} migrated state file(s)` +
      (copiedFiles ? ` (${copiedFiles} copied this pass)` : ""),
  );

  const removablePaths = [
    legacyConfigPath,
    legacyStateRoot,
    path.join(repository, "agent-harness", "guidance"),
  ].filter((candidate) => candidate); // existence checked at cleanup time

  let cleaned = false;
  if (options.cleanup) {
    cleaned = await cleanupLegacyPaths(removablePaths);
    notes.push("Removed validated repository-local harness paths after migration.");
  } else {
    notes.push(
      "Original repository-local data left in place. Remove explicitly with: " +
        `agent-harness migrate-home --repository "${repository}" --cleanup`,
    );
  }

  return {
    lookup,
    copiedFiles,
    contentHashMatches: true,
    removablePaths,
    cleaned,
    notes,
  };
}

async function assertNoActivelyMutatingRun(stateRoot: string): Promise<void> {
  const runsRoot = path.join(stateRoot, "runs");
  if (!(await exists(runsRoot))) return;
  const entries = await readdir(runsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const stateRaw: unknown = JSON.parse(
        await readFile(path.join(runsRoot, entry.name, "state.json"), "utf8"),
      );
      const phase =
        typeof stateRaw === "object" &&
        stateRaw !== null &&
        "phase" in stateRaw &&
        typeof (stateRaw as { phase: unknown }).phase === "string"
          ? (stateRaw as { phase: string }).phase
          : undefined;
      const advancing =
        typeof stateRaw === "object" &&
        stateRaw !== null &&
        "advancing" in stateRaw &&
        (stateRaw as { advancing?: boolean }).advancing === true;
      if (advancing || (phase && ACTIVE_PHASES.has(phase) && advancing)) {
        throw new HarnessFailure(
          `Refuse to migrate while run ${entry.name} is actively mutating (phase=${phase}). Stop/cancel the run first.`,
          "config",
          true,
        );
      }
      // Also refuse when a run lock is present.
      const lockPath = path.join(runsRoot, entry.name, "run.lock");
      if (await exists(lockPath)) {
        throw new HarnessFailure(
          `Refuse to migrate while run lock exists for ${entry.name} (${lockPath}).`,
          "config",
          true,
        );
      }
    } catch (error) {
      if (error instanceof HarnessFailure) throw error;
    }
  }
}

async function findLegacyConfig(repository: string): Promise<string | undefined> {
  for (const name of CONFIG_NAMES) {
    const candidate = path.join(repository, name);
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

async function copyDirectoryContents(
  source: string,
  destination: string,
  skipNames: string[] = [],
): Promise<number> {
  await mkdir(destination, { recursive: true });
  let count = 0;
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (skipNames.includes(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      count += await copyDirectoryContents(from, to, skipNames);
    } else if (entry.isFile()) {
      await mkdir(path.dirname(to), { recursive: true });
      await cp(from, to);
      count += 1;
    }
  }
  return count;
}

async function rewriteWorkspacePaths(
  runsRoot: string,
  update: { controlRoot: string },
): Promise<void> {
  if (!(await exists(runsRoot))) return;
  const entries = await readdir(runsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspacePath = path.join(runsRoot, entry.name, "workspace.json");
    if (!(await exists(workspacePath))) continue;
    try {
      const raw = JSON.parse(await readFile(workspacePath, "utf8")) as Record<string, unknown>;
      raw.controlRoot = update.controlRoot;
      const temp = `${workspacePath}.tmp`;
      await writeFile(temp, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
      await rename(temp, workspacePath);
    } catch {
      // Leave unreadable workspace metadata for operator inspection.
    }
  }
}

async function cleanupLegacyPaths(paths: string[]): Promise<boolean> {
  let removed = false;
  for (const candidate of paths) {
    if (!(await exists(candidate))) continue;
    await rm(candidate, { recursive: true, force: true });
    removed = true;
  }
  return removed;
}

async function validateCopiedTree(
  sourceRoot: string,
  destinationRoot: string,
): Promise<{ ok: boolean; reason?: string; fileCount: number }> {
  if (!(await exists(sourceRoot))) return { ok: true, fileCount: 0 };
  const files = await listFiles(sourceRoot);
  let fileCount = 0;
  for (const file of files) {
    const relative = path.relative(sourceRoot, file).replaceAll("\\", "/");
    const dest = path.join(destinationRoot, relative);
    if (!(await exists(dest))) {
      return { ok: false, reason: `missing migrated file ${relative}`, fileCount };
    }
    const sourceDigest = createHash("sha256").update(await readFile(file)).digest("hex");
    const destDigest = createHash("sha256").update(await readFile(dest)).digest("hex");
    if (sourceDigest !== destDigest) {
      return { ok: false, reason: `content hash mismatch for ${relative}`, fileCount };
    }
    fileCount += 1;
  }
  return { ok: true, fileCount };
}

async function listFiles(directory: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
