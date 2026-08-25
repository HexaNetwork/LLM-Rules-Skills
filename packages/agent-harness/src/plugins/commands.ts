import type { Context } from "@deepseek-ai/cordis";

export type CommandResult = {
  command: string;
  passed: boolean;
  output: string;
  classification: "passed" | "project_failure" | "environment_failure";
};

export type CommandService = {
  verify(runId: string, command?: string): Promise<CommandResult | undefined>;
};

export function createCommandService(ctx: Context): CommandService {
  return {
    async verify(runId, command) {
      if (!command?.trim()) return undefined;
      const parts = splitCommand(command, ctx.sandbox.mode);
      const result = await ctx.sandbox.exec(runId, { command: parts });
      const output = `${result.stdout}${result.stderr}`.trim();
      const passed = result.exitCode === 0;
      return {
        command,
        passed,
        output,
        classification: passed ? "passed" : classifyFailure(output),
      };
    },
  };
}

export function classifyFailure(output: string): "project_failure" | "environment_failure" {
  const text = output.toLowerCase();
  const environmentSignals = [
    "command not found",
    "is not recognized as an internal or external command",
    "no such file or directory",
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
  { inject: ["sandbox"] },
);
