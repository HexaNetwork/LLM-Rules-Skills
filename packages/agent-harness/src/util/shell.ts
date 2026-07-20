import { spawn } from "node:child_process";

export type ShellResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export async function runShell(
  command: string,
  options: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<ShellResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: true,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer =
      options.timeoutMs != null
        ? setTimeout(() => {
            if (!settled) {
              child.kill("SIGTERM");
              settled = true;
              resolve({
                exitCode: 124,
                stdout,
                stderr: `${stderr}\nTimed out after ${options.timeoutMs}ms`,
                durationMs: Date.now() - started,
              });
            }
          }, options.timeoutMs)
        : undefined;

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout,
        stderr: error.message,
        durationMs: Date.now() - started,
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        durationMs: Date.now() - started,
      });
    });
  });
}
