import type { Context } from "@deepseek-ai/cordis";
import type { VerificationEvidence } from "../domain/types.js";

export type CommandResult = VerificationEvidence;

export type CommandService = {
  verify(runId: string, command?: string): Promise<CommandResult | undefined>;
};

export function createCommandService(ctx: Context): CommandService {
  return {
    async verify(runId, command) {
      if (!command?.trim()) return undefined;
      const startedAt = new Date().toISOString();
      const startMs = Date.now();
      await ctx.store.appendEvent(runId, {
        kind: "verification",
        at: startedAt,
        status: "started",
        command,
      });
      const parts = splitCommand(command, ctx.sandbox.mode);
      const result = await ctx.sandbox.exec(runId, { command: parts });
      const endedAt = new Date().toISOString();
      const durationMs = Date.now() - startMs;
      const output = `${result.stdout}${result.stderr}`.trim();
      const passed = result.exitCode === 0;
      const evidence: CommandResult = {
        command,
        passed,
        output,
        classification: passed ? "passed" : classifyFailure(output),
        startedAt,
        endedAt,
        durationMs,
        exitCode: result.exitCode,
      };
      await ctx.store.appendEvent(runId, {
        kind: "verification",
        at: endedAt,
        status: passed ? "passed" : "failed",
        command,
        durationMs,
        exitCode: result.exitCode,
        classification: evidence.classification,
      });
      return evidence;
    },
  };
}

export function classifyFailure(output: string): "project_failure" | "environment_failure" {
  const text = output.toLowerCase();
  const environmentSignals = [
    "command not found",
    // dash/ash: "sh: 1: ./gradlew: not found" (also CRLF shebang → missing /bin/sh\r)
    ": not found",
    "is not recognized as an internal or external command",
    "no such file or directory",
    "bad interpreter",
    "could not find java",
    "no 'java' command could be found",
    "java_home is not set",
    "unable to locate executable",
    "executable file not found",
  ];
  return environmentSignals.some((signal) => text.includes(signal))
    ? "environment_failure"
    : "project_failure";
}

function splitCommand(command: string, sandboxMode?: "none" | "docker"): string[] {
  if (sandboxMode === "docker" || process.platform !== "win32") return ["sh", "-c", command];
  return ["cmd", "/c", command];
}

export const commandsPlugin = Object.assign(
  (ctx: Context) => {
    ctx.provide("commands", createCommandService(ctx));
  },
  { inject: ["sandbox", "store"] },
);
