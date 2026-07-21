import path from "node:path";
import { readFile } from "node:fs/promises";
import yaml from "js-yaml";
import { ProjectConfigSchema, type ProjectConfig } from "../schemas/config.js";
import { pathExists } from "../util/fs.js";

export const CONFIG_FILENAMES = [
  "agent-harness.config.yaml",
  "agent-harness.config.yml",
  "agent-harness.config.json",
] as const;

export async function findConfigPath(
  cwd = process.cwd(),
): Promise<string | undefined> {
  for (const name of CONFIG_FILENAMES) {
    const candidate = path.join(cwd, name);
    if (await pathExists(candidate)) return candidate;
  }
  return undefined;
}

export async function loadProjectConfig(
  configPath?: string,
  cwd = process.cwd(),
): Promise<{ config: ProjectConfig; path: string }> {
  const resolved =
    configPath != null
      ? path.resolve(cwd, configPath)
      : await findConfigPath(cwd);
  if (!resolved) {
    throw new Error(
      `No Agent Harness config found. Run \`agent-harness init\` or pass --config.`,
    );
  }
  const raw = await readFile(resolved, "utf8");
  const parsed = resolved.endsWith(".json")
    ? JSON.parse(raw)
    : yaml.load(raw);
  const config = ProjectConfigSchema.parse({
    ...(parsed as object),
    repositoryRoot: path.resolve(
      path.dirname(resolved),
      (parsed as { repositoryRoot?: string }).repositoryRoot ?? ".",
    ),
  });
  return { config, path: resolved };
}

export function defaultConfigYaml(name: string): string {
  return `contractVersion: "1"
name: ${name}
repositoryRoot: .
baseBranch: main
branchPrefix: agent-harness
models:
  prepare: composer-2.5
  worker: composer-2.5
  verifier: composer-2.5
  repair: composer-2.5
  adversarial: composer-2.5
commandGates:
  - id: typecheck
    command: npm run typecheck
  - id: test
    command: npm run test:run
  - id: build
    command: npm run build
pathPolicy:
  protectedGlobs:
    - .env
    - .env.*
    - "**/*secret*"
    - "**/*credential*"
  defaultAllowedGlobs:
    - "**/*"
retries:
  sdkStartupAttempts: 3
  commandOrSpecRepairs: 2
  reviewRepairs: 1
  finalBranchRepairs: 1
watchdogs:
  # Cancel worker if worktree idle (no new diffs) this long; stays armed until gates.
  workerNoCodeMs: 300000
allowlist:
  terminalAllowlist:
    - git
    - npm
    - npm:*
    - node
    - npx
  mcpAllowlist: []
  networkAllowlist: []
browser:
  enabled: false
runDirectory: .agent-harness/runs
# github:
#   owner: your-org
#   repo: your-repo
#   assigneeLogin: your-login
#   afkLabel: afk
#   hitlLabel: hitl
`;
}
