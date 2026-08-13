import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ExecutableRunner } from "./types.js";

const DEFAULT_OUTPUT_LIMIT = 1_000_000;

/**
 * Quote a single argument for `cmd.exe /d /s /c` with `windowsVerbatimArguments`.
 * Doubles embedded quotes per cmd.exe rules; wraps when whitespace or quotes exist.
 */
export function quoteCmdArgument(value: string): string {
  if (value.length === 0) return '""';
  if (!/[\s"]/u.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Resolve how to invoke an argument-array CLI on the current platform.
 * On Windows, prefer `.cmd`/`.exe`/`.bat` over npm's extensionless Unix shim, and
 * run batch files via `ComSpec` so Node does not `spawn EINVAL` / `ENOENT`.
 */
export function resolveExecutableInvocation(
  executable: string,
  args: readonly string[],
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    existsSync?: (candidate: string) => boolean;
  } = {},
): { file: string; args: string[]; windowsVerbatimArguments?: boolean } {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.existsSync ?? existsSync;
  if (platform !== "win32") {
    return { file: executable, args: [...args] };
  }

  const resolved = resolveWindowsExecutable(executable, env, exists);
  if (resolved && /\.(?:cmd|bat)$/iu.test(resolved)) {
    const comspec = env.ComSpec?.trim() || "cmd.exe";
    const commandLine = [resolved, ...args].map(quoteCmdArgument).join(" ");
    return {
      file: comspec,
      args: ["/d", "/s", "/c", commandLine],
      windowsVerbatimArguments: true,
    };
  }
  return { file: resolved ?? executable, args: [...args] };
}

function resolveWindowsExecutable(
  executable: string,
  env: NodeJS.ProcessEnv,
  exists: (candidate: string) => boolean,
): string | undefined {
  if (path.isAbsolute(executable) || executable.includes("/") || executable.includes("\\")) {
    if (exists(executable)) return executable;
    for (const extension of windowsExecutableExtensions(env)) {
      const candidate = `${executable}${extension}`;
      if (exists(candidate)) return candidate;
    }
    return undefined;
  }

  const basename = executable.replace(/\.(?:cmd|bat|exe)$/iu, "");
  const pathEntries = [
    ...(env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean),
    // npm's default global bin is often on User PATH but missing from sanitized process PATH.
    ...(env.APPDATA ? [path.join(env.APPDATA, "npm")] : []),
  ];
  const seenDirs = new Set<string>();
  // Prefer Windows entrypoints over npm's extensionless `#!/bin/sh` shim.
  const extensions = [...windowsExecutableExtensions(env), ""];
  for (const dir of pathEntries) {
    const normalized = dir.trim().toLowerCase();
    if (!normalized || seenDirs.has(normalized)) continue;
    seenDirs.add(normalized);
    for (const extension of extensions) {
      const candidate = path.join(dir, `${basename}${extension}`);
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}

function windowsExecutableExtensions(env: NodeJS.ProcessEnv): string[] {
  const fromEnv = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => (value.startsWith(".") ? value : `.${value}`));
  const preferred = [".cmd", ".exe", ".bat"];
  const rest = fromEnv.filter(
    (extension) => !preferred.some((item) => item.toLowerCase() === extension.toLowerCase()),
  );
  return [...preferred, ...rest];
}

export const runExecutable: ExecutableRunner = (executable, args, options) =>
  new Promise((resolve) => {
    const invocation = resolveExecutableInvocation(executable, args);
    execFile(
      invocation.file,
      invocation.args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer ?? DEFAULT_OUTPUT_LIMIT,
        windowsHide: true,
        signal: options.signal,
        ...(invocation.windowsVerbatimArguments
          ? { windowsVerbatimArguments: true }
          : {}),
      },
      (error, stdout, stderr) => {
        const commandError = error as
          | (Error & {
              code?: string | number;
              killed?: boolean;
            })
          | null;
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
