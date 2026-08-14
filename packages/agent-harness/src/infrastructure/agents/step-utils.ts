import { detectInstallFromCommand } from "../../commands.js";
import path from "node:path";
import type { AgentStepEvent } from "./types.js";

/** Derive a bounded, args-free step summary for persistence and UI. */
export function summarizeAgentStep(step: {
  type: string;
  message?: { type?: string; args?: unknown };
}): AgentStepEvent {
  const toolName =
    step.type === "toolCall" && typeof step.message?.type === "string"
      ? step.message.type
      : undefined;
  const pathHint = toolName ? filePathFromToolArgs(step.message?.args) : undefined;
  let summary = toolName ?? step.type;
  if (toolName && pathHint) summary = `${toolName} ${pathHint}`;
  if (summary.length > 200) summary = `${summary.slice(0, 199)}…`;
  return {
    type: step.type,
    ...(toolName ? { toolName } : {}),
    summary,
  };
}

/** Provider tool names that execute shell/terminal commands. */
export const SHELL_TOOL_NAMES = new Set([
  "shell",
  "bash",
  "Shell",
  "Bash",
  "run_terminal_cmd",
  "run_command",
  "terminal",
]);

/** True when the tool name is a known or name-pattern command-execution tool. */
export function isShellToolName(toolName: string): boolean {
  return SHELL_TOOL_NAMES.has(toolName) || /shell|bash|terminal|command/i.test(toolName);
}

/** Detect install-like shell tool calls for passive logging. */
export function detectInstallFromToolStep(step: {
  type: string;
  message?: { type?: string; args?: unknown };
}): { manager: import("../../domain.js").PackageManager; packages: string[]; commandSummary: string } | undefined {
  if (step.type !== "toolCall") return undefined;
  const toolName = typeof step.message?.type === "string" ? step.message.type : "";
  if (!isShellToolName(toolName)) {
    return undefined;
  }
  const command = shellCommandFromToolArgs(step.message?.args);
  if (!command) return undefined;
  return detectInstallFromCommand(command);
}

/**
 * Defense-in-depth detection for provider file tools. Cursor's OS sandbox is
 * the authoritative boundary; this cancels conspicuous attempts and makes the
 * violation visible in durable run state.
 */
export function prohibitedAgentPathAccess(args: unknown, cwd: string): string | undefined {
  const text = allArgumentStrings(args).join("\n").replaceAll("\\", "/").toLocaleLowerCase();
  if (!text) return undefined;
  if (/(^|\/)agent-transcripts(?:\/|$)/m.test(text)) return "agent-transcripts";
  if (/(^|\/)\.cursor(?:\/|$)/m.test(text)) return ".cursor";
  if (/(^|\/)\.codegraph(?:\/|$)/m.test(text)) return ".codegraph";
  if (/(^|\/)graphify-out(?:\/|$)/m.test(text)) return "graphify-out";

  const normalizedCwd = cwd.replaceAll("\\", "/").toLocaleLowerCase();
  const containerWorkspace = normalizedCwd === "/workspace" || normalizedCwd.startsWith("/workspace/");
  if (containerWorkspace) {
    if (/(^|[\s"'])\/run-state(?:\/|$)/m.test(text)) return "run-state";
    if (/(^|[\s"'])\/seed\.bundle(?:\/|$)/m.test(text)) return "seed-bundle";
    if (/(^|[\s"'])\/(?!workspace(?:\/|$))/m.test(text)) return "outside-workspace";
    if (/(^|[\s"'])\.\.\//m.test(text)) return "outside-workspace";
    return undefined;
  }

  const resolvedCwd = path.resolve(cwd);
  const worktreeRoot = path.dirname(resolvedCwd);
  if (!/-worktrees$/i.test(path.basename(worktreeRoot))) return undefined;
  const normalizedRoot = worktreeRoot.replaceAll("\\", "/").toLocaleLowerCase();
  const hostCwd = resolvedCwd.replaceAll("\\", "/").toLocaleLowerCase();
  const rootPrefix = `${normalizedRoot}/`;
  let offset = text.indexOf(rootPrefix);
  while (offset >= 0) {
    const referenced = text.slice(offset).split(/[\s"']/u, 1)[0] ?? "";
    if (referenced && referenced !== hostCwd && !referenced.startsWith(`${hostCwd}/`)) {
      return "sibling-worktree";
    }
    offset = text.indexOf(rootPrefix, offset + rootPrefix.length);
  }
  if (/(^|[\s"'])\.\.\//m.test(text)) return "outside-worktree";
  return undefined;
}

function allArgumentStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(allArgumentStrings);
  if (!isRecord(value)) return [];
  return Object.values(value).flatMap(allArgumentStrings);
}

function shellCommandFromToolArgs(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  for (const key of ["command", "cmd", "script", "code", "input"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function taskIdFromPacketInput(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  if (typeof input.taskId === "string" && input.taskId.trim()) return input.taskId.trim();
  const task = input.task;
  if (isRecord(task) && typeof task.id === "string" && task.id.trim()) return task.id.trim();
  return undefined;
}

function filePathFromToolArgs(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  for (const key of ["path", "target", "file_path", "filePath", "relativePath"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
