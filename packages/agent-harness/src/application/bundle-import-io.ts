import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { HarnessConfig } from "../config/schema.js";
import { runTransportImportPath } from "../config/io.js";
import {
  BundleImportStateSchema,
  type BundleImportState,
} from "../domain/run-execution.js";
import { runBundleImportPath, resolveHarnessPaths } from "./paths.js";

export async function loadBundleImportState(
  projectConfig: HarnessConfig,
  runId: string,
): Promise<BundleImportState | undefined> {
  const filePath = runTransportImportPath(projectConfig, runId);
  try {
    const raw: unknown = JSON.parse(await readFile(filePath, "utf8"));
    return BundleImportStateSchema.parse(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeBundleImportState(
  projectConfig: HarnessConfig,
  runId: string,
  state: BundleImportState,
): Promise<BundleImportState> {
  const parsed = BundleImportStateSchema.parse({
    ...state,
    updatedAt: new Date().toISOString(),
  });
  const filePath = runTransportImportPath(projectConfig, runId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return parsed;
}

/** Worker-visible path helper when stateRoot is already `/run-state`. */
export function workerBundleImportPath(runId: string, stateRoot = "/run-state"): string {
  return runBundleImportPath(stateRoot, runId);
}

export function createEmptyBundleImportState(): BundleImportState {
  return BundleImportStateSchema.parse({
    version: 1,
    status: "none",
    updatedAt: new Date().toISOString(),
  });
}

export function hostTransportDirectory(projectConfig: HarnessConfig, runId: string): string {
  const { stateRoot } = resolveHarnessPaths(projectConfig);
  return path.join(stateRoot, "runs", runId, "transport");
}
