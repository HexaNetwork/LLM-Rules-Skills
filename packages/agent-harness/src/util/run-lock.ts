import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { open, readFile, rm } from "node:fs/promises";
import { ensureDir } from "./fs.js";

type RunLockRecord = {
  token: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
};

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLock(lockPath: string): Promise<RunLockRecord | undefined> {
  try {
    return JSON.parse(await readFile(lockPath, "utf8")) as RunLockRecord;
  } catch {
    return undefined;
  }
}

export async function acquireRunLock(
  runDirectory: string,
): Promise<() => Promise<void>> {
  await ensureDir(runDirectory);
  const lockPath = path.join(runDirectory, ".orchestrator.lock");
  const record: RunLockRecord = {
    token: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    acquiredAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.close();
      return async () => {
        const current = await readLock(lockPath);
        if (current?.token === record.token) {
          await rm(lockPath, { force: true });
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await readLock(lockPath);
      const stale =
        owner != null &&
        owner.hostname === hostname() &&
        !isProcessAlive(owner.pid);
      if (stale && attempt === 0) {
        await rm(lockPath, { force: true });
        continue;
      }
      const detail = owner
        ? `pid ${owner.pid} on ${owner.hostname}, acquired ${owner.acquiredAt}`
        : "an unreadable lock file";
      throw new Error(`Run is already active (${detail})`);
    }
  }

  throw new Error("Unable to acquire run lock");
}
