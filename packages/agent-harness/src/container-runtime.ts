import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CommandResult, EnvironmentSpec } from "./types.js";
import { checked, runProcess } from "./process.js";

export type ContainerRuntimeOptions = { runnerImage: string; buildRoot: string };

export class ContainerRuntime {
  constructor(private readonly options: ContainerRuntimeOptions) {}

  async available(): Promise<boolean> { return (await runProcess("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 10_000 })).exitCode === 0; }
  containerName(runId: string): string { return `agent-harness-${runId.replace(/[^a-zA-Z0-9_.-]/g, "-")}`; }

  environmentHash(spec: EnvironmentSpec, runnerDigest: string): string {
    return createHash("sha256").update(JSON.stringify(normalizeSpec(spec))).update(runnerDigest).digest("hex");
  }

  async imageDigest(image: string): Promise<string> {
    const result = await checked("docker", ["image", "inspect", image, "--format", "{{index .RepoDigests 0}}|{{.Id}}"]);
    return result.stdout.trim();
  }

  async buildEnvironment(runId: string, spec: EnvironmentSpec): Promise<{ image: string; digest: string; log: string }> {
    validateEnvironmentPolicy(spec, this.options.runnerImage);
    const runnerDigest = await this.imageDigest(this.options.runnerImage);
    const hash = this.environmentHash(spec, runnerDigest);
    const image = `agent-harness-project:${hash}`;
    const exists = await runProcess("docker", ["image", "inspect", image]);
    if (exists.exitCode === 0) return { image, digest: await this.imageDigest(image), log: "reused cached image" };
    const directory = path.join(this.options.buildRoot, runId, "environment");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "Containerfile"), spec.containerfile, "utf8");
    const result = await runProcess("docker", ["build", "--pull=false", "--tag", image, "--file", "Containerfile", "."], { cwd: directory, timeoutMs: 30 * 60_000, maxOutput: 128_000 });
    if (result.exitCode !== 0) throw new Error(`Environment image build failed:\n${bounded(result.stderr || result.stdout)}`);
    return { image, digest: await this.imageDigest(image), log: result.stdout + result.stderr };
  }

  async createRunContainer(runId: string, image: string, workspace: string, caches: EnvironmentSpec["caches"]): Promise<string> {
    const name = this.containerName(runId);
    await this.destroy(name);
    const args = ["create", "--name", name, "--workdir", "/workspace", "--mount", `type=bind,src=${path.resolve(workspace)},dst=/workspace`];
    for (const cache of caches) args.push("--mount", `type=volume,src=agent-harness-${runId}-${cache.name},dst=${cache.containerPath}`);
    args.push("--env", "CURSOR_API_KEY", image, "tail", "-f", "/dev/null");
    await checked("docker", args, { env: credentialEnvironment() });
    await checked("docker", ["start", name]);
    return name;
  }

  async inspect(name: string): Promise<boolean> {
    const result = await runProcess("docker", ["inspect", "--format", "{{.State.Running}}", name]);
    return result.exitCode === 0 && result.stdout.trim() === "true";
  }

  async exec(name: string, command: string, timeoutMs?: number, input?: string): Promise<CommandResult> {
    const actionId = createHash("sha256").update(`${name}\0${command}`).digest("hex").slice(0, 24);
    const result = await runProcess("docker", ["exec", "-i", name, "sh", "-lc", command], { input, timeoutMs, maxOutput: 64_000 });
    return { actionId, ...result };
  }

  async invokeInRunner(runId: string, workspace: string, input: string, timeoutMs: number): Promise<CommandResult> {
    const args = ["run", "--rm", "--name", `${this.containerName(runId)}-agent`, "--interactive", "--workdir", "/workspace", "--mount", `type=bind,src=${path.resolve(workspace)},dst=/workspace,readonly`, "--env", "CURSOR_API_KEY", this.options.runnerImage, "node", "/opt/harness/worker.js"];
    const result = await runProcess("docker", args, { input, timeoutMs, env: credentialEnvironment(), maxOutput: 128_000 });
    return { actionId: "runner-agent", ...result };
  }

  async destroy(nameOrRunId: string): Promise<void> {
    const name = nameOrRunId.startsWith("agent-harness-") ? nameOrRunId : this.containerName(nameOrRunId);
    await runProcess("docker", ["rm", "--force", name], { timeoutMs: 30_000 });
    await runProcess("docker", ["rm", "--force", `${name}-agent`], { timeoutMs: 30_000 });
  }
}

export function normalizeSpec(spec: EnvironmentSpec): EnvironmentSpec {
  return { containerfile: spec.containerfile.replace(/\r\n/g, "\n").trim() + "\n", setupCommands: [...spec.setupCommands], healthcheckCommands: [...spec.healthcheckCommands], caches: [...spec.caches].sort((a, b) => a.name.localeCompare(b.name)) };
}

export function validateEnvironmentPolicy(spec: EnvironmentSpec, runnerImage: string): void {
  const firstInstruction = spec.containerfile.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#"));
  if (firstInstruction !== `FROM ${runnerImage}`) throw new Error(`Environment Containerfile must begin with FROM ${runnerImage}`);
  const forbidden = [/--privileged/i, /docker\.sock/i, /AGENT_HARNESS_HOME/i, /publication.*token/i];
  const combined = [spec.containerfile, ...spec.setupCommands, ...spec.healthcheckCommands].join("\n");
  for (const pattern of forbidden) if (pattern.test(combined)) throw new Error(`EnvironmentSpec violates container policy: ${pattern.source}`);
  const names = new Set<string>();
  for (const cache of spec.caches) {
    if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(cache.name) || names.has(cache.name)) throw new Error(`Invalid or duplicate cache name: ${cache.name}`);
    names.add(cache.name);
    if (!cache.containerPath.startsWith("/") || cache.containerPath === "/workspace" || cache.containerPath.startsWith("/workspace/")) throw new Error(`Cache path must be absolute and outside /workspace: ${cache.containerPath}`);
  }
}

function credentialEnvironment(): NodeJS.ProcessEnv { return { ...process.env, CURSOR_API_KEY: process.env.CURSOR_API_KEY }; }
function bounded(value: string): string { return value.length > 16_000 ? value.slice(-16_000) : value; }
