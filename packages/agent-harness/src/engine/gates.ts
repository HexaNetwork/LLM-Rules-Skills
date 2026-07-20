import path from "node:path";
import type { CommandGate, ProjectConfig } from "../schemas/config.js";
import type { CommandGateResult } from "../schemas/reports.js";
import { anyGlobMatches } from "../util/glob.js";
import { runShell } from "../util/shell.js";

export async function runCommandGates(
  gates: CommandGate[],
  cwd: string,
): Promise<CommandGateResult[]> {
  const results: CommandGateResult[] = [];
  for (const gate of gates) {
    const gateCwd = gate.cwd ? path.resolve(cwd, gate.cwd) : cwd;
    const shell = await runShell(gate.command, {
      cwd: gateCwd,
      timeoutMs: gate.timeoutMs ?? 10 * 60 * 1000,
    });
    results.push({
      gateId: gate.id,
      command: gate.command,
      exitCode: shell.exitCode,
      passed: shell.exitCode === 0,
      stdout: shell.stdout.slice(0, 20_000),
      stderr: shell.stderr.slice(0, 20_000),
      durationMs: shell.durationMs,
    });
    if (shell.exitCode !== 0) break;
  }
  return results;
}

export function allGatesPassed(results: CommandGateResult[]): boolean {
  return results.length > 0 && results.every((result) => result.passed);
}

export function validatePathScope(
  changedPaths: string[],
  allowedGlobs: string[],
  protectedGlobs: string[],
): { ok: true } | { ok: false; reason: "PATH_SCOPE_VIOLATION" | "PROTECTED_PATH"; detail: string } {
  for (const filePath of changedPaths) {
    if (anyGlobMatches(filePath, protectedGlobs)) {
      return {
        ok: false,
        reason: "PROTECTED_PATH",
        detail: `Protected path changed: ${filePath}`,
      };
    }
    if (!anyGlobMatches(filePath, allowedGlobs)) {
      return {
        ok: false,
        reason: "PATH_SCOPE_VIOLATION",
        detail: `Path outside allowed globs: ${filePath}`,
      };
    }
  }
  return { ok: true };
}

export function writeAllowlistFiles(
  config: ProjectConfig,
): { permissions: unknown; sandbox: unknown } {
  return {
    permissions: {
      terminalAllowlist: config.allowlist.terminalAllowlist,
      mcpAllowlist: config.allowlist.mcpAllowlist,
      autoRun: {
        allow_instructions: [
          "Allow only allowlisted terminal and MCP operations for Agent Harness runs.",
        ],
        block_instructions: [
          "Block any shell, MCP, or network action not explicitly allowlisted.",
          "Block deletes outside the repository worktree.",
        ],
      },
    },
    sandbox: {
      network: config.allowlist.networkAllowlist,
    },
  };
}
