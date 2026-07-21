import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireRunLock } from "../../src/util/run-lock.js";

const temporaryDirectories: string[] = [];

describe("run lock", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("rejects a concurrent orchestrator for the same run", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "harness-lock-"));
    temporaryDirectories.push(directory);
    const release = await acquireRunLock(directory);

    await expect(acquireRunLock(directory)).rejects.toThrow(
      /Run is already active/,
    );
    await release();
  });

  it("reclaims a lock owned by a dead local process", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "harness-lock-"));
    temporaryDirectories.push(directory);
    await writeFile(
      path.join(directory, ".orchestrator.lock"),
      JSON.stringify({
        token: "stale",
        pid: 2_147_483_647,
        hostname: hostname(),
        acquiredAt: new Date(0).toISOString(),
      }),
      "utf8",
    );

    const release = await acquireRunLock(directory);
    await release();
  });
});
