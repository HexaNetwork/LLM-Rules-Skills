import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { HarnessConfig } from "../config/schema.js";
import {
  RunExecutionStateSchema,
  type RunExecutionState,
} from "../domain/run-execution.js";
import { resolveHarnessPaths } from "./paths.js";
import { runExecutionJsonPath } from "../config/io.js";

export async function loadRunExecutionState(
  projectConfig: HarnessConfig,
  runId: string,
): Promise<RunExecutionState | undefined> {
  const filePath = runExecutionJsonPath(projectConfig, runId);
  try {
    const raw: unknown = JSON.parse(await readFile(filePath, "utf8"));
    return RunExecutionStateSchema.parse(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeRunExecutionState(
  projectConfig: HarnessConfig,
  runId: string,
  state: RunExecutionState,
): Promise<RunExecutionState> {
  const parsed = RunExecutionStateSchema.parse({
    ...state,
    updatedAt: new Date().toISOString(),
  });
  const filePath = runExecutionJsonPath(projectConfig, runId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return parsed;
}

export function hostRunDirectory(projectConfig: HarnessConfig, runId: string): string {
  const { stateRoot } = resolveHarnessPaths(projectConfig);
  return path.join(stateRoot, "runs", runId);
}

export function createPendingDockerExecutionState(input?: {
  containerName?: string;
}): RunExecutionState {
  return RunExecutionStateSchema.parse({
    version: 1,
    runtime: "docker",
    lifecycle: "pending",
    ...(input?.containerName ? { containerName: input.containerName } : {}),
    updatedAt: new Date().toISOString(),
  });
}
