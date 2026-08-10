#!/usr/bin/env node
import { createCli } from "./create-cli.js";

export async function main(argv = process.argv): Promise<void> {
  try {
    await createCli().parseAsync(argv);
  } catch (error: unknown) {
    if (isCommanderHelpOrVersion(error)) {
      process.exitCode = 0;
      return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = typeof (error as { exitCode?: unknown })?.exitCode === "number"
      ? Number((error as { exitCode: number }).exitCode)
      : 1;
  }
}

function isCommanderHelpOrVersion(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: string }).code;
  return code === "commander.helpDisplayed" || code === "commander.versionDisplayed";
}

const entry = process.argv[1];
if (entry && /[\\/]cli[\\/]main\.(js|ts|mjs|cjs)$/i.test(entry)) {
  void main();
}
