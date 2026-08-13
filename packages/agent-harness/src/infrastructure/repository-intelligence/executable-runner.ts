import { execFile } from "node:child_process";
import type { ExecutableRunner } from "./types.js";

const DEFAULT_OUTPUT_LIMIT = 1_000_000;

export const runExecutable: ExecutableRunner = (executable, args, options) =>
  new Promise((resolve) => {
    execFile(
      executable,
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer ?? DEFAULT_OUTPUT_LIMIT,
        windowsHide: true,
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        const commandError = error as (Error & {
          code?: string | number;
          killed?: boolean;
        }) | null;
        resolve({
          exitCode:
            commandError == null
              ? 0
              : typeof commandError.code === "number"
                ? commandError.code
                : 1,
          stdout,
          stderr: stderr || commandError?.message || "",
          timedOut: commandError?.killed === true,
        });
      },
    );
  });
