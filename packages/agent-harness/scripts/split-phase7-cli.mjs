import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Always start from the original monolithic CLI if create-cli was partially transformed.
const original = await readFile(path.join(root, "src/cli.ts"), "utf8").catch(() => null);
const target = path.join(root, "src/cli/create-cli.ts");
const src = original ?? (await readFile(target, "utf8"));

let body = src
  .replace(/^#!\/usr\/bin\/env node\r?\n/, "")
  .replaceAll('from "./agent.js"', 'from "../agent.js"')
  .replaceAll('from "./config.js"', 'from "../config.js"')
  .replaceAll('from "./engine.js"', 'from "../engine.js"')
  .replaceAll('from "./git.js"', 'from "../git.js"')
  .replaceAll('from "./knowledge.js"', 'from "../knowledge.js"')
  .replaceAll('from "./ui/server.js"', 'from "../ui/server.js"')
  .replaceAll("createCursorBackend()", "dependencies.createBackend()")
  .replaceAll('createCursorBackend("unused")', 'dependencies.createBackend("unused")')
  .replaceAll("await startUiServer({", "await dependencies.startUiServer({");

body = body.replace(
  /\r?\nprogram\.parseAsync\(process\.argv\)\.catch\(\(error: unknown\) => \{[\s\S]*\}\);\s*$/,
  "\n",
);

// Drop the original import block; we emit a new header.
const programIdx = body.indexOf("const program = new Command()");
if (programIdx < 0) throw new Error("const program not found");
const helpersIdx = body.indexOf("\nasync function discoverDeploymentSources");
if (helpersIdx < 0) throw new Error("helpers marker not found");

const programBlock = body.slice(programIdx, helpersIdx);
const helpers = body.slice(helpersIdx + 1); // keep leading async function...

const indentedProgram = programBlock
  .split(/\r?\n/)
  .map((line) => (line.length ? `  ${line}` : line))
  .join("\n");

const header = `import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Command } from "commander";
import { createCursorBackend, type AgentBackend } from "../agent.js";
import {
  defaultConfigYaml,
  deploymentConfigYaml,
  loadConfig,
  loadRunConfig,
  type HarnessConfig,
} from "../config.js";
import { HarnessEngine } from "../engine.js";
import { GitService } from "../git.js";
import { LocalKnowledgeBase } from "../knowledge.js";
import { startUiServer, type UiServer } from "../ui/server.js";

export type CliDependencies = {
  createBackend: (apiKey?: string) => AgentBackend;
  startUiServer: (options: Parameters<typeof startUiServer>[0]) => Promise<UiServer>;
};

export function productionCliDependencies(): CliDependencies {
  return {
    createBackend: (apiKey) => createCursorBackend(apiKey),
    startUiServer,
  };
}

export function createCli(dependencies: CliDependencies = productionCliDependencies()): Command {
`;

const out = `${header}${indentedProgram}
  return program;
}

${helpers}`;
await writeFile(target, out, "utf8");
console.log(`wrote ${target} (${out.length} bytes)`);
