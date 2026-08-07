import { spawn } from "node:child_process";
import type { CommandEvidence } from "./domain.js";

export type CommandResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
};

const OUTPUT_LIMIT = 200_000;

export function runCommand(
  command: string,
  options: { cwd: string; timeoutMs: number },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      windowsHide: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
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
      resolve({
        command,
        exitCode,
        stdout,
        stderr: timedOut ? `${stderr}\nCommand timed out after ${options.timeoutMs}ms`.trim() : stderr,
        durationMs: Date.now() - started,
        timedOut,
      });
    };
    child.once("error", (error) => {
      if (timedOut) finish(124);
      else reject(error);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      forcedTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish(124);
      }, 2_000);
    }, options.timeoutMs);
    child.once("close", (code) => {
      finish(timedOut ? 124 : (code ?? 1));
    });
  });
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
