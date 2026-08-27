import { spawn } from "node:child_process";

export type ProcessResult = { exitCode: number; stdout: string; stderr: string; timedOut?: boolean };

export function runProcess(file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number; maxOutput?: number } = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const limit = options.maxOutput ?? 64_000;
    let stdout = ""; let stderr = ""; let timedOut = false;
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout = (stdout + chunk).slice(-limit); });
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-limit); });
    child.on("error", reject);
    const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs) : undefined;
    timer?.unref();
    child.on("close", (code) => { if (timer) clearTimeout(timer); resolve({ exitCode: code ?? 1, stdout, stderr, timedOut: timedOut || undefined }); });
    child.stdin.end(options.input);
  });
}

export async function checked(file: string, args: string[], options: Parameters<typeof runProcess>[2] = {}): Promise<ProcessResult> {
  const result = await runProcess(file, args, options);
  if (result.exitCode !== 0) throw new Error(`${file} ${args[0] ?? ""} failed (${result.exitCode}): ${result.stderr || result.stdout}`.slice(0, 8_000));
  return result;
}
