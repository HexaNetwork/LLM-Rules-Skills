import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Worktrees for Docker bind mounts — prefer WSL ext4 on Windows when available. */
export async function resolveWorktreeRoot(harnessHome: string, projectKey: string): Promise<string> {
  const wslRoot = await resolveWslAgentHarnessRoot();
  if (wslRoot) {
    return path.join(wslRoot, "projects", projectKey, "worktrees");
  }
  return path.join(harnessHome, "projects", projectKey, "worktrees");
}

export async function ensureWorktreeRoot(worktreeRoot: string): Promise<void> {
  if (process.platform === "win32" && isWslUncPath(worktreeRoot)) {
    try {
      const { stdout } = await exec("wsl", ["wslpath", "-u", worktreeRoot], { windowsHide: true, timeout: 5000 });
      const linuxPath = stdout.trim();
      if (linuxPath.startsWith("/")) {
        await exec("wsl", ["-e", "mkdir", "-p", linuxPath], { windowsHide: true, timeout: 5000 });
        return;
      }
    } catch {
      // Fall through to Node mkdir.
    }
  }
  await mkdir(worktreeRoot, { recursive: true });
}

function wslWorktreesEnabled(): boolean {
  if (process.platform !== "win32") return false;
  if (process.env.AGENT_HARNESS_DISABLE_WSL_WORKTREES === "1") return false;
  return process.env.AGENT_HARNESS_WSL_WORKTREES === "1";
}

async function resolveWslAgentHarnessRoot(): Promise<string | undefined> {
  if (!wslWorktreesEnabled()) return undefined;
  try {
    const { stdout: wslHome } = await exec(
      "wsl",
      ["-e", "sh", "-lc", "printf '%s' \"$HOME/.agent-harness\""],
      { windowsHide: true, timeout: 5000 },
    );
    const linuxPath = wslHome.trim();
    if (!linuxPath.startsWith("/")) return undefined;
    const { stdout: winPath } = await exec("wsl", ["wslpath", "-w", linuxPath], {
      windowsHide: true,
      timeout: 5000,
    });
    const resolved = winPath.trim().replace(/\r?\n$/, "");
    return resolved.length > 0 ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function isWslUncPath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/").toLowerCase();
  return normalized.startsWith("//wsl") || normalized.startsWith("\\\\wsl");
}
