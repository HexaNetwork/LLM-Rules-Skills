import { mkdir, mkdtemp, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const HARNESS_TEMP_ROOT = path.join(tmpdir(), "agent-harness");
const TEST_RUNS_ROOT = path.join(HARNESS_TEMP_ROOT, "test-runs");

export default async function setup(): Promise<() => Promise<void>> {
  await mkdir(TEST_RUNS_ROOT, { recursive: true });
  const runRoot = await mkdtemp(path.join(TEST_RUNS_ROOT, "run-"));
  process.env.AGENT_HARNESS_TEST_TEMP_ROOT = runRoot;

  return async () => {
    await rm(runRoot, { recursive: true, force: true, maxRetries: 3 });
    await removeIfEmpty(TEST_RUNS_ROOT);
    await removeIfEmpty(HARNESS_TEMP_ROOT);
  };
}

async function removeIfEmpty(directory: string): Promise<void> {
  try {
    await rmdir(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
  }
}
