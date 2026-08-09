import { spawn } from "node:child_process";
import type { CommandEvidence, PackageManager } from "./domain.js";

export type CommandResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  cancelled?: boolean;
};

const OUTPUT_LIMIT = 200_000;

/** Credentials used by the harness must never flow into arbitrary project commands. */
const PROTECTED_ENV_NAMES = new Set([
  "CURSOR_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
]);

const RUNTIME_ENV_NAMES = process.platform === "win32"
  ? ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "ComSpec", "PATHEXT", "WINDIR", "TEMP", "TMP"]
  : ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"];

export type CommandEnvironmentOptions = {
  /** Explicitly allowed project variables; provider credentials stay blocked. */
  passEnv?: string[];
  /** Additional provider credentials configured by this harness instance. */
  protectedEnvNames?: string[];
};

/**
 * Builds an execution environment that cannot accidentally leak the harness'
 * provider credentials through lifecycle hooks, test scripts, or their output.
 */
export function buildCommandEnvironment(options: CommandEnvironmentOptions = {}): {
  env: NodeJS.ProcessEnv;
  redactions: string[];
} {
  const protectedNames = new Set([
    ...PROTECTED_ENV_NAMES,
    ...(options.protectedEnvNames ?? []).map((name) => name.toUpperCase()),
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const name of [...RUNTIME_ENV_NAMES, ...(options.passEnv ?? [])]) {
    if (protectedNames.has(name.toUpperCase())) continue;
    const value = process.env[name];
    if (value != null) env[name] = value;
  }
  const redactions = Object.entries(process.env)
    .filter(([name]) => protectedNames.has(name.toUpperCase()))
    .map(([, value]) => value)
    .filter((value): value is string => typeof value === "string" && value.length >= 4)
    .sort((a, b) => b.length - a.length);
  return { env, redactions };
}

export function runCommand(
  command: string,
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal } & CommandEnvironmentOptions,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      resolve({
        command,
        exitCode: 130,
        stdout: "",
        stderr: "",
        durationMs: 0,
        timedOut: false,
        cancelled: true,
      });
      return;
    }
    const started = Date.now();
    const commandEnvironment = buildCommandEnvironment(options);
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      windowsHide: true,
      env: commandEnvironment.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    const capture = (current: string, chunk: Buffer): string =>
      `${current}${chunk.toString("utf8")}`.slice(-OUTPUT_LIMIT);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = capture(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = capture(stderr, chunk);
    });
    let settled = false;
    let forcedTimer: NodeJS.Timeout | undefined;
    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forcedTimer) clearTimeout(forcedTimer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        command,
        exitCode,
        stdout: redact(stdout, commandEnvironment.redactions),
        stderr: redact(
          timedOut ? `${stderr}\nCommand timed out after ${options.timeoutMs}ms`.trim() : stderr,
          commandEnvironment.redactions,
        ),
        durationMs: Date.now() - started,
        timedOut,
        ...(cancelled ? { cancelled: true } : {}),
      });
    };
    const forceSettle = (exitCode: number): void => {
      killTree(child.pid);
      forcedTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish(exitCode);
      }, 2_000);
    };
    const onAbort = (): void => {
      if (settled || timedOut) return;
      cancelled = true;
      forceSettle(130);
    };
    child.once("error", (error) => {
      if (timedOut) finish(124);
      else if (cancelled) finish(130);
      else reject(error);
    });
    const timer = setTimeout(() => {
      if (cancelled) return;
      timedOut = true;
      forceSettle(124);
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("close", (code) => {
      finish(cancelled ? 130 : timedOut ? 124 : (code ?? 1));
    });
  });
}

function redact(value: string, secrets: string[]): string {
  let result = value;
  for (const secret of secrets) result = result.replaceAll(secret, "[REDACTED]");
  return result;
}

function killTree(pid: number | undefined): void {
  if (pid == null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.unref();
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process already exited.
    }
  }
}

export function commandEvidence(purpose: string, result: CommandResult): CommandEvidence {
  return {
    purpose,
    command: result.command,
    exitCode: result.exitCode,
    passed: result.exitCode === 0 && !result.timedOut,
    stdout: result.stdout.slice(-20_000),
    stderr: result.stderr.slice(-20_000),
    durationMs: result.durationMs,
    at: new Date().toISOString(),
  };
}

export function evidenceOutput(evidence: CommandEvidence[]): string {
  return evidence
    .map((item) => {
      const output = [item.stderr, item.stdout].filter(Boolean).join("\n").slice(-8_000);
      return `${item.purpose}: ${item.passed ? "PASS" : "FAIL"}\nCommand: ${item.command}\nExit: ${item.exitCode}\n${output}`;
    })
    .join("\n\n");
}

/** Newest-first, budgeted rendering of command evidence for a prompt. */
export function recentEvidenceOutput(
  evidence: CommandEvidence[],
  options: { entries?: number; charactersPerEntry?: number } = {},
): string {
  const entries = options.entries ?? 2;
  const charactersPerEntry = options.charactersPerEntry ?? 2_000;
  if (evidence.length === 0 || entries <= 0) return "";

  const selected: CommandEvidence[] = [];
  const latest = evidence[evidence.length - 1]!;
  selected.push(latest);
  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const item = evidence[index]!;
    if (!item.passed && item !== latest) {
      selected.push(item);
      break;
    }
  }
  for (let index = evidence.length - 1; index >= 0 && selected.length < entries; index -= 1) {
    const item = evidence[index]!;
    if (!selected.includes(item)) selected.push(item);
  }

  return selected
    .slice(0, entries)
    .map((item) => {
      const output = [item.stderr, item.stdout].filter(Boolean).join("\n").slice(-charactersPerEntry);
      return `${item.purpose}: ${item.passed ? "PASS" : "FAIL"}\nCommand: ${item.command}\nExit: ${item.exitCode}\n${output}`;
    })
    .join("\n\n");
}

const PACKAGE_TOKEN = /^[@a-zA-Z0-9][a-zA-Z0-9._+/-]*$/;
const MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "pip", "uv", "cargo"]);

export type DetectedInstall = {
  manager: PackageManager;
  packages: string[];
  commandSummary: string;
};

/** Build an allowlisted install command (manager + package args only). */
export function buildInstallCommand(
  manager: PackageManager,
  packages: string[],
): string {
  const safe = packages.map(assertSafePackageArg);
  if (safe.length === 0) throw new Error("At least one package is required");
  switch (manager) {
    case "npm":
      return ["npm", "install", ...safe].join(" ");
    case "pnpm":
      return ["pnpm", "add", ...safe].join(" ");
    case "yarn":
      return ["yarn", "add", ...safe].join(" ");
    case "bun":
      return ["bun", "add", ...safe].join(" ");
    case "pip":
      return ["pip", "install", ...safe].join(" ");
    case "uv":
      return ["uv", "add", ...safe].join(" ");
    case "cargo":
      return ["cargo", "add", ...safe].join(" ");
  }
}

export async function runApprovedInstall(
  manager: PackageManager,
  packages: string[],
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal } & CommandEnvironmentOptions,
): Promise<CommandResult> {
  const command = buildInstallCommand(manager, packages);
  return runCommand(command, options);
}

/**
 * Detect package-manager install invocations in a shell-like command string.
 * Passive logging only — never blocks the agent.
 */
export function detectInstallFromCommand(command: string): DetectedInstall | undefined {
  const normalized = command.replace(/\r?\n/g, " ").trim();
  if (!normalized) return undefined;
  // Walk simple && / ; / | chains and return the first install-like segment.
  for (const segment of normalized.split(/(?:&&|;|\|)/)) {
    const detected = detectInstallSegment(segment.trim());
    if (detected) return detected;
  }
  return undefined;
}

function detectInstallSegment(segment: string): DetectedInstall | undefined {
  const tokens = tokenizeShell(segment);
  if (tokens.length < 2) return undefined;
  let index = 0;
  // Skip env assignments: FOO=bar npm install …
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[index]!)) {
    index += 1;
  }
  const managerToken = tokens[index]?.toLowerCase();
  if (!managerToken || !MANAGERS.has(managerToken)) return undefined;
  const manager = managerToken as PackageManager;
  index += 1;
  const verb = tokens[index]?.toLowerCase();
  if (!verb) return undefined;

  let packagesStart = index + 1;
  let matched = false;
  if (manager === "npm" && (verb === "install" || verb === "i" || verb === "add")) {
    matched = true;
  } else if ((manager === "pnpm" || manager === "yarn" || manager === "bun") && (verb === "add" || verb === "install")) {
    matched = true;
  } else if (manager === "pip" && verb === "install") {
    matched = true;
  } else if (manager === "uv" && verb === "add") {
    matched = true;
  } else if (manager === "uv" && verb === "pip" && tokens[index + 1]?.toLowerCase() === "install") {
    matched = true;
    packagesStart = index + 2;
  } else if (manager === "cargo" && verb === "add") {
    matched = true;
  }
  if (!matched) return undefined;

  const packages: string[] = [];
  for (let i = packagesStart; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.startsWith("-")) continue;
    if (!PACKAGE_TOKEN.test(token)) continue;
    packages.push(token);
  }
  const commandSummary = [manager, verb, ...packages].join(" ").slice(0, 200);
  return { manager, packages, commandSummary };
}

function tokenizeShell(command: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|[^\s"']+/g;
  for (const match of command.matchAll(re)) {
    let token = match[0]!;
    if (
      (token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'"))
    ) {
      token = token.slice(1, -1);
    }
    if (token) tokens.push(token);
  }
  return tokens;
}

function assertSafePackageArg(value: string): string {
  const trimmed = value.trim();
  if (!PACKAGE_TOKEN.test(trimmed)) {
    throw new Error(`Unsafe package argument: ${value}`);
  }
  return trimmed;
}
