import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runShell } from "../../src/util/shell.js";

const temporaryDirectories: string[] = [];

describe("runShell", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  it("terminates the spawned process tree on timeout", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "harness-shell-"));
    temporaryDirectories.push(directory);
    const scriptPath = path.join(directory, "parent.mjs");
    const sentinelPath = path.join(directory, "child-finished.txt");
    await writeFile(
      scriptPath,
      [
        "import { spawn } from 'node:child_process';",
        "const sentinel = process.argv[2];",
        "spawn(process.execPath, ['-e',",
        "  `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'alive'), 500)`",
        "]);",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "utf8",
    );

    const result = await runShell(
      `node "${scriptPath}" "${sentinelPath}"`,
      { cwd: directory, timeoutMs: 100 },
    );
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(result.exitCode).toBe(124);
    await expect(readFile(sentinelPath, "utf8")).rejects.toThrow();
  });
});
