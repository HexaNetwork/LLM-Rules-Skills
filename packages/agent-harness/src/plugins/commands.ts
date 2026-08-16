import type { Context } from "@deepseek-ai/cordis";

export type CommandResult = {
  command: string;
  passed: boolean;
  output: string;
};

export type CommandService = {
  verify(runId: string, command?: string): Promise<CommandResult | undefined>;
};

export function createCommandService(ctx: Context): CommandService {
  return {
    async verify(runId, command) {
      if (!command?.trim()) return undefined;
      const parts = splitCommand(command);
      const result = await ctx.sandbox.exec(runId, { command: parts });
      const output = `${result.stdout}${result.stderr}`.trim();
      return { command, passed: result.exitCode === 0, output };
    },
  };
}

function splitCommand(command: string): string[] {
  if (process.platform === "win32") return ["cmd", "/c", command];
  return ["sh", "-c", command];
}

export const commandsPlugin = Object.assign(
  (ctx: Context) => {
    ctx.provide("commands", createCommandService(ctx));
  },
  { inject: ["sandbox"] },
);
