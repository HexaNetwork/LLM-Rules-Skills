import path from "node:path";
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { KnowledgeSource } from "./config.js";

export const SEEDED_GUIDANCE_RELATIVE_PATH = "agent-harness/guidance/General";
export const ROOT_GENERAL_RELATIVE_PATH = "General";

export type GuidanceSeedResult = {
  /** Repository-relative path to configure as scope:global, or undefined when skipped. */
  sourcePath?: string;
  /** True when files were copied from the package templates. */
  copied: boolean;
  /** True when an existing General/ or prior seed was reused without copying. */
  reused: boolean;
};

/**
 * Seed package General/ rules+skills into the project (Graphify-templates pattern).
 * Avoids double-copy when agent-harness/guidance/General or root General/ already exists.
 */
export async function seedGlobalGuidance(
  project: string,
  options: { enabled?: boolean } = {},
): Promise<GuidanceSeedResult> {
  if (options.enabled === false) return { copied: false, reused: false };

  const seededAbsolute = path.join(project, ...SEEDED_GUIDANCE_RELATIVE_PATH.split("/"));
  const rootGeneralAbsolute = path.join(project, ROOT_GENERAL_RELATIVE_PATH);

  if (await isNonEmptyDirectory(seededAbsolute)) {
    return { sourcePath: SEEDED_GUIDANCE_RELATIVE_PATH, copied: false, reused: true };
  }
  if (await isNonEmptyDirectory(rootGeneralAbsolute)) {
    return { sourcePath: ROOT_GENERAL_RELATIVE_PATH, copied: false, reused: true };
  }

  const templateDirectory = resolveGuidanceTemplateDirectory();
  if (!(await isNonEmptyDirectory(templateDirectory))) {
    throw new Error(
      `Guidance templates missing at ${templateDirectory}. Run npm run build in packages/agent-harness.`,
    );
  }
  await mkdir(path.dirname(seededAbsolute), { recursive: true });
  await cp(templateDirectory, seededAbsolute, { recursive: true });
  return { sourcePath: SEEDED_GUIDANCE_RELATIVE_PATH, copied: true, reused: false };
}

/** Ensure knowledge.sources lists the seeded path once with scope:global. */
export function withGlobalGuidanceSource(
  sources: KnowledgeSource[],
  sourcePath: string | undefined,
): KnowledgeSource[] {
  if (!sourcePath) return sources;
  const normalized = normalizeRepoPath(sourcePath);
  const without = sources.filter((source) => normalizeRepoPath(source.path) !== normalized);
  return [{ path: normalized, scope: "global", visibility: "private" }, ...without];
}

export function resolveGuidanceTemplateDirectory(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../templates/guidance/General");
}

async function isNonEmptyDirectory(directory: string): Promise<boolean> {
  const info = await stat(directory).catch(() => undefined);
  if (!info?.isDirectory()) return false;
  const entries = await readdir(directory);
  return entries.length > 0;
}

function normalizeRepoPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}
