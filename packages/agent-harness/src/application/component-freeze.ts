import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile, cp } from "node:fs/promises";
import path from "node:path";
import type { HarnessConfig } from "../config/schema.js";
import { resolveGuidanceTemplateDirectory } from "../guidance-seed.js";
import type { HarnessHomePaths } from "./harness-home.js";
import type { ProjectPaths } from "./harness-home.js";

export const COMPONENT_MANIFEST_VERSION = 1 as const;

export type FrozenComponentEntry = {
  kind: "rule" | "skill" | "workflow" | "agent" | "guidance-tree";
  id: string;
  sourcePath: string;
  relativePath: string;
  sha256: string;
};

export type FrozenComponentManifest = {
  version: typeof COMPONENT_MANIFEST_VERSION;
  createdAt: string;
  components: FrozenComponentEntry[];
};

/**
 * Resolve reusable components: project-specific → user/global home → packaged.
 * At run creation, copy effective contents under the run directory and record hashes.
 */
export async function freezeRunComponents(options: {
  runId: string;
  runsRoot: string;
  project: ProjectPaths;
  home: HarnessHomePaths;
  config: HarnessConfig;
  now?: () => Date;
}): Promise<FrozenComponentManifest> {
  const runDir = path.join(options.runsRoot, options.runId);
  const freezeRoot = path.join(runDir, "frozen-components");
  await mkdir(freezeRoot, { recursive: true });

  const components: FrozenComponentEntry[] = [];
  const guidanceCandidates = [
    options.project.projectGuidanceRoot,
    options.home.sharedGuidanceRoot,
    path.dirname(resolveGuidanceTemplateDirectory()),
  ];

  for (const candidate of guidanceCandidates) {
    if (!(await isNonEmptyDirectory(candidate))) continue;
    const relative = "guidance";
    const destination = path.join(freezeRoot, relative);
    if (await isNonEmptyDirectory(destination)) break;
    await cp(candidate, destination, { recursive: true });
    const hash = await hashDirectory(destination);
    components.push({
      kind: "guidance-tree",
      id: "guidance",
      sourcePath: candidate,
      relativePath: relative,
      sha256: hash,
    });
    break;
  }

  // Workflow + agent profile directories (optional; empty when unused).
  for (const [kind, roots] of [
    ["workflow", [path.join(options.project.projectStateRoot, "workflows"), options.home.workflowsRoot]],
    ["agent", [path.join(options.project.projectStateRoot, "agents"), options.home.agentsRoot]],
  ] as const) {
    for (const root of roots) {
      if (!(await isNonEmptyDirectory(root))) continue;
      const relative = kind === "workflow" ? "workflows" : "agents";
      const destination = path.join(freezeRoot, relative);
      if (await isNonEmptyDirectory(destination)) break;
      await cp(root, destination, { recursive: true });
      components.push({
        kind,
        id: relative,
        sourcePath: root,
        relativePath: relative,
        sha256: await hashDirectory(destination),
      });
      break;
    }
  }

  const manifest: FrozenComponentManifest = {
    version: COMPONENT_MANIFEST_VERSION,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    components,
  };
  await writeFile(
    path.join(runDir, "frozen-components.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  // Bind knowledge sources for this run to the frozen guidance copy when present.
  void options.config;
  return manifest;
}

export async function loadFrozenComponentManifest(
  runsRoot: string,
  runId: string,
): Promise<FrozenComponentManifest | undefined> {
  try {
    const raw: unknown = JSON.parse(
      await readFile(path.join(runsRoot, runId, "frozen-components.json"), "utf8"),
    );
    return raw as FrozenComponentManifest;
  } catch {
    return undefined;
  }
}

async function hashDirectory(directory: string): Promise<string> {
  const hash = createHash("sha256");
  const files = await listFilesRecursive(directory);
  files.sort();
  for (const file of files) {
    const relative = path.relative(directory, file).replaceAll("\\", "/");
    hash.update(relative);
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function listFilesRecursive(directory: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...(await listFilesRecursive(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

async function isNonEmptyDirectory(directory: string): Promise<boolean> {
  const info = await stat(directory).catch(() => undefined);
  if (!info?.isDirectory()) return false;
  const entries = await readdir(directory);
  return entries.length > 0;
}
