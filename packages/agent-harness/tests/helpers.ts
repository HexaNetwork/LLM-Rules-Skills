import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { bootHost, type BootedHost } from "../src/boot.js";
import { hostRuntimeRows } from "../src/plugins/profile.js";
import type { WorkflowBundle } from "../src/domain/types.js";

const exec = promisify(execFile);

export async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export async function createTempRepo(): Promise<string> {
  const dir = await createTempDir("harness-repo-");
  await exec("git", ["init"], { cwd: dir, windowsHide: true });
  await exec("git", ["config", "user.email", "harness@example.test"], { cwd: dir, windowsHide: true });
  await exec("git", ["config", "user.name", "Harness Tests"], { cwd: dir, windowsHide: true });
  await writeFile(path.join(dir, "README.md"), "# toy repo\n", "utf8");
  await exec("git", ["add", "README.md"], { cwd: dir, windowsHide: true });
  await exec("git", ["commit", "-m", "init"], { cwd: dir, windowsHide: true });
  return dir;
}

export async function bootTestHost(options: {
  home?: string;
  bundles?: WorkflowBundle[];
} = {}): Promise<{ home: string; host: BootedHost }> {
  const home = options.home ?? (await createTempDir("harness-home-"));
  const host = await bootHost({
    home,
    extraRows: hostRuntimeRows({
      agents: { mode: "fake" },
      sandbox: { mode: "none" },
      bundles: options.bundles,
    }),
  });
  return { home, host };
}
