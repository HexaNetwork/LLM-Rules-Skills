import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WORKER_DOCKERFILE_RELATIVE = path.join("docker", "worker", "Dockerfile");

export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../");
}

export function mainDockerfilePath(): string {
  return path.join(packageRoot(), WORKER_DOCKERFILE_RELATIVE);
}

export function runImageTag(runId: string): string {
  const safe = runId.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return `agent-harness-worker-run-${safe}`;
}

export function runDockerfilePath(harnessHome: string, runId: string): string {
  return path.join(harnessHome, "runs", runId, "image", "Dockerfile");
}

export async function readMainDockerfile(): Promise<string> {
  return readFile(mainDockerfilePath(), "utf8");
}

export async function readRunDockerfile(
  harnessHome: string,
  runId: string,
): Promise<string | undefined> {
  try {
    return await readFile(runDockerfilePath(harnessHome, runId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeRunDockerfile(
  harnessHome: string,
  runId: string,
  content: string,
): Promise<void> {
  const target = runDockerfilePath(harnessHome, runId);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

export function validateRepairedDockerfile(base: string, repaired: string): string | undefined {
  if (repaired.trim().length === 0) return "Repaired Dockerfile is empty";
  const baseFrom = base.match(/^FROM\s+\S+/m)?.[0];
  const repairedFrom = repaired.match(/^FROM\s+\S+/m)?.[0];
  if (baseFrom && repairedFrom !== baseFrom) {
    return `Repaired Dockerfile must keep the base image \`${baseFrom}\``;
  }
  if (!/USER\s+10001:10001/.test(repaired)) {
    return "Repaired Dockerfile must keep `USER 10001:10001`";
  }
  if (!/WORKDIR\s+\/workspace/.test(repaired)) {
    return "Repaired Dockerfile must keep `WORKDIR /workspace`";
  }
  if (!/CMD\s+\[\s*"sleep",\s*"infinity"\s*\]/.test(repaired)) {
    return 'Repaired Dockerfile must keep `CMD ["sleep", "infinity"]`';
  }
  return undefined;
}
