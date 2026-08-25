import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
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

const exec = promisify(execFile);

export type ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type SandboxExec = {
  command: string[];
  stdin?: string;
  cwd?: string;
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
      const effectiveImage = (await pathExists(runDockerfilePath(ctx.store.home, runId)))
        ? runImageTag(runId)
        : image;
      const spec = buildRunSpec({
        runId,
        image: effectiveImage,
        worktreeHost: identity.worktreePath,
        cursorApiKey: process.env.CURSOR_API_KEY,
      });
      const siblings = (await ctx.store.listRunIds()).filter((id) => id !== runId);
      validateMounts(spec, {
        controlRoot: identity.controlRoot,
        harnessHome: ctx.store.home,
        siblingRunRoots: siblings.map((id) => `${ctx.store.home}/runs/${id}`),
      });
      await docker(buildDockerRunArgs(spec));
      specs.set(runId, spec);
      return spec;
    },
    async exec(runId, request) {
      if (mode === "none") {
        const identity = await ctx.store.readIdentity(runId);
        if (!identity) throw new Error(`Unknown run ${runId}`);
        return runLocal(request.command, request.cwd ?? identity.worktreePath, request.stdin);
      }
      await this.ensure(runId);
      const name = containerName(runId);
      return runDockerExec(name, request.command, request.stdin);
    },
    async destroy(runId, options) {
      if (mode === "none") return;
      const name = containerName(runId);
      await docker(["rm", "-f", name]).catch(() => undefined);
      specs.delete(runId);
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function runProcess(file: string, args: string[], cwd?: string, stdin?: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.stdin.end(stdin ?? "");
    child.on("error", (error) => {
      resolve({ exitCode: 1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function runLocal(command: string[], cwd: string, stdin?: string): Promise<ExecResult> {
  return runProcess(command[0]!, command.slice(1), cwd, stdin);
}

function runDockerExec(name: string, command: string[], stdin?: string): Promise<ExecResult> {
  return runProcess("docker", ["exec", "-i", name, ...command], undefined, stdin);
}

export function sandboxPlugin(ctx: Context, config: SandboxConfig = {}): void {
  ctx.provide("sandbox", createSandboxService(ctx, config));
}

Object.assign(sandboxPlugin, { inject: ["store"] });
