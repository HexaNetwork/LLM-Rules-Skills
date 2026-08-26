import { execFile, spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Context } from "@deepseek-ai/cordis";
import { buildDockerRunArgs } from "../domain/docker-run.js";
import { packageRoot, runDockerfilePath, runImageTag } from "../domain/image-repair.js";
import {
  buildRunSpec,
  containerName,
  validateMounts,
  type ContainerSpec,
} from "../domain/mount-policy.js";
import { normalizeShellWrappers } from "../domain/shell-wrappers.js";

const exec = promisify(execFile);

export type ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
};

export type SandboxExec = {
  command: string[];
  stdin?: string;
  cwd?: string;
  timeoutMs?: number;
  onStdoutLine?: (line: string) => void | Promise<void>;
};

export type SandboxService = {
  mode: "none" | "docker";
  readonly image: string;
  ensure(runId: string): Promise<ContainerSpec | undefined>;
  exec(runId: string, request: SandboxExec): Promise<ExecResult>;
  destroy(runId: string, options?: { purgeImage?: boolean }): Promise<void>;
  buildImage(dockerfilePath: string, tag: string): Promise<string>;
  removeImage(tag: string): Promise<void>;
  inspect(runId: string): Promise<{
    image: string;
    status: string;
    mounts: Array<{ source: string; destination: string }>;
    env: string[];
  }>;
};

export type SandboxConfig = {
  mode?: "none" | "docker";
  image?: string;
};

export function createSandboxService(ctx: Context, config: SandboxConfig = {}): SandboxService {
  const mode = config.mode ?? (process.env.AGENT_HARNESS_SANDBOX === "docker" ? "docker" : "none");
  const image = config.image ?? process.env.AGENT_HARNESS_WORKER_IMAGE ?? "node:22-bookworm-slim";
  const specs = new Map<string, ContainerSpec>();
  const wrappersNormalized = new Set<string>();

  const ensureShellWrappers = async (runId: string, worktreePath: string): Promise<void> => {
    if (wrappersNormalized.has(runId)) return;
    await normalizeShellWrappers(worktreePath);
    wrappersNormalized.add(runId);
  };

  const buildImage = async (dockerfilePath: string, tag: string): Promise<string> => {
    const args = ["build", "-t", tag, "-f", dockerfilePath, packageRoot()];
    try {
      const { stdout, stderr } = await exec("docker", args, {
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
      });
      return `${stdout}${stderr}`;
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message?: string };
      const combined = `${failure.stdout ?? ""}${failure.stderr ?? ""}` || failure.message || "";
      throw new Error(`docker build failed for ${tag}: ${combined}`);
    }
  };

  const removeImage = async (tag: string): Promise<void> => {
    await docker(["rmi", "-f", tag]).catch(() => undefined);
  };

  return {
    mode,
    image,
    buildImage,
    removeImage,
    async ensure(runId) {
      if (mode === "none") return undefined;
      if (specs.has(runId)) return specs.get(runId);
      const identity = await ctx.store.readIdentity(runId);
      if (!identity) throw new Error(`Cannot start sandbox for unknown run ${runId}`);
      await ensureShellWrappers(runId, identity.worktreePath);
      const effectiveImage = (await pathExists(runDockerfilePath(ctx.store.home, runId)))
        ? runImageTag(runId)
        : image;
      const gradleCacheHost = path.join(
        ctx.store.home,
        "projects",
        identity.projectKey,
        "gradle-cache",
      );
      await mkdir(gradleCacheHost, { recursive: true });
      const spec = buildRunSpec({
        runId,
        image: effectiveImage,
        worktreeHost: identity.worktreePath,
        cursorApiKey: process.env.CURSOR_API_KEY,
        gradleCacheHost,
      });
      const siblings = (await ctx.store.listRunIds()).filter((id) => id !== runId);
      validateMounts(spec, {
        controlRoot: identity.controlRoot,
        harnessHome: ctx.store.home,
        siblingRunRoots: siblings.map((id) => `${ctx.store.home}/runs/${id}`),
      });
      await ensureDockerContainer(spec);
      specs.set(runId, spec);
      return spec;
    },
    async exec(runId, request) {
      if (mode === "none") {
        const identity = await ctx.store.readIdentity(runId);
        if (!identity) throw new Error(`Unknown run ${runId}`);
        await ensureShellWrappers(runId, identity.worktreePath);
        return runLocal(
          request.command,
          request.cwd ?? identity.worktreePath,
          request.stdin,
          request.timeoutMs,
          request.onStdoutLine,
        );
      }
      await this.ensure(runId);
      const name = containerName(runId);
      const result = await runDockerExec(
        name,
        request.command,
        request.stdin,
        request.timeoutMs,
        request.onStdoutLine,
      );
      if (result.timedOut) {
        // A timed-out docker exec is terminated by removing the dedicated run
        // container. Forget the cached spec so the next call recreates it.
        specs.delete(runId);
      }
      return result;
    },
    async destroy(runId, options) {
      if (mode === "none") return;
      const name = containerName(runId);
      await docker(["rm", "-f", name]).catch(() => undefined);
      specs.delete(runId);
      wrappersNormalized.delete(runId);
      if (options?.purgeImage) {
        await removeImage(runImageTag(runId));
      }
    },
    async inspect(runId) {
      const name = containerName(runId);
      const raw = await docker(["inspect", name]);
      const [info] = JSON.parse(raw) as Array<{
        Mounts?: Array<{ Source: string; Destination: string }>;
        Config?: { Env?: string[]; Image?: string };
        State?: { Status?: string };
      }>;
      return {
        image: info?.Config?.Image ?? "",
        status: info?.State?.Status ?? "unknown",
        mounts: (info?.Mounts ?? []).map((mount) => ({
          source: mount.Source,
          destination: mount.Destination,
        })),
        env: info?.Config?.Env ?? [],
      };
    },
  };
}

async function docker(args: string[]): Promise<string> {
  const { stdout } = await exec("docker", args, { windowsHide: true });
  return stdout;
}

/** Reuse a healthy container or replace a stale one after process restart / retry. */
async function ensureDockerContainer(spec: ContainerSpec): Promise<void> {
  try {
    const raw = await docker(["inspect", "-f", "{{.State.Running}}", spec.name]);
    if (raw.trim() === "true") return;
    await docker(["rm", "-f", spec.name]);
  } catch {
    // Container does not exist yet.
  }
  await docker(buildDockerRunArgs(spec));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function runProcess(
  file: string,
  args: string[],
  cwd?: string,
  stdin?: string,
  timeoutMs?: number,
  onStdoutLine?: (line: string) => void | Promise<void>,
  onTimeout?: () => Promise<void>,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stdoutRemainder = "";
    let stderr = "";
    let settled = false;
    const finish = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const flushStdoutLine = async (line: string): Promise<void> => {
      if (!onStdoutLine) return;
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        await onStdoutLine(trimmed);
      } catch {
        // Streaming persistence must not abort the worker process.
      }
    };
    const drainStdoutLines = async (): Promise<void> => {
      let newlineIndex = stdoutRemainder.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = stdoutRemainder.slice(0, newlineIndex);
        stdoutRemainder = stdoutRemainder.slice(newlineIndex + 1);
        await flushStdoutLine(line);
        newlineIndex = stdoutRemainder.indexOf("\n");
      }
    };
    const timer = timeoutMs
      ? setTimeout(() => {
          void (async () => {
            await onTimeout?.().catch(() => undefined);
            await terminateProcessTree(child.pid).catch(() => undefined);
            finish({
              // Timeouts are never successful, regardless of a shell or pipe's
              // last observed exit code.
              exitCode: 124,
              stdout,
              stderr: `${stderr}${stderr ? "\n" : ""}Agent worker timed out after ${timeoutMs}ms`,
              timedOut: true,
            });
          })();
        }, timeoutMs)
      : undefined;
    timer?.unref();
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      if (!onStdoutLine) return;
      stdoutRemainder += text;
      void drainStdoutLines();
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.stdin.end(stdin ?? "");
    child.on("error", (error) => {
      finish({ exitCode: 1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      if (onStdoutLine && stdoutRemainder.length > 0) {
        void flushStdoutLine(stdoutRemainder).finally(() => {
          stdoutRemainder = "";
          finish({ exitCode: code ?? 1, stdout, stderr });
        });
        return;
      }
      finish({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function runLocal(
  command: string[],
  cwd: string,
  stdin?: string,
  timeoutMs?: number,
  onStdoutLine?: (line: string) => void | Promise<void>,
): Promise<ExecResult> {
  return runProcess(command[0]!, command.slice(1), cwd, stdin, timeoutMs, onStdoutLine);
}

function runDockerExec(
  name: string,
  command: string[],
  stdin?: string,
  timeoutMs?: number,
  onStdoutLine?: (line: string) => void | Promise<void>,
): Promise<ExecResult> {
  return runProcess(
    "docker",
    ["exec", "-i", name, ...command],
    undefined,
    stdin,
    timeoutMs,
    onStdoutLine,
    async () => {
      // Killing the docker CLI does not kill the exec'd process. This container
      // is dedicated to one run, so removing it is the only reliable tree kill.
      await docker(["rm", "-f", name]).catch(() => undefined);
    },
  );
}

async function terminateProcessTree(pid: number | undefined): Promise<void> {
  if (!pid) return;
  if (process.platform === "win32") {
    await exec("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
    }).catch(() => undefined);
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The process group already exited after SIGTERM.
  }
}

export function sandboxPlugin(ctx: Context, config: SandboxConfig = {}): void {
  ctx.provide("sandbox", createSandboxService(ctx, config));
}

Object.assign(sandboxPlugin, { inject: ["store"] });
