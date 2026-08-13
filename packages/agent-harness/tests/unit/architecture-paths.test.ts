import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const srcRoot = path.join(packageRoot, "src");

/** Run-scoped execution modules must not treat config.repositoryRoot as the execution cwd. */
const EXECUTION_MODULES = [
  "application/task-execution-service.ts",
  "application/planning-service.ts",
  "application/recovery-service.ts",
  "infrastructure/agents/agent-coordinator.ts",
  "git.ts",
  "knowledge.ts"] as const;

/** Control-plane helpers may still read repositoryRoot while deriving HarnessPaths. */
const ALLOWED_REPOSITORY_ROOT_PATTERNS = [
  /resolveHarnessPaths/,
  /path\.resolve\(\s*config\.repositoryRoot/,
  /paths\.controlRoot/];

async function readSrc(relativePath: string): Promise<string> {
  return readFile(path.join(srcRoot, relativePath), "utf8");
}

function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/(['"`])(?:\\.|(?!\1)[\s\S])*\1/g, '""');
}

describe("architecture: HarnessPaths wiring", () => {
  it("requires RunStore to take an explicit stateRoot instead of deriving it from repositoryRoot", async () => {
    const source = await readSrc("store.ts");
    expect(source).toMatch(/constructor\s*\(\s*readonly config:\s*HarnessConfig,\s*stateRoot:\s*string/);
    expect(source).not.toMatch(
      /this\.root\s*=\s*path\.resolve\(\s*config\.repositoryRoot\s*,\s*config\.stateDirectory\s*\)/,
    );
  });

  it("threads HarnessPaths through ApplicationContext and dependency composition", async () => {
    const contextSource = await readSrc("application/application-context.ts");
    const depsSource = await readSrc("application/dependencies.ts");
    const pathsSource = await readSrc("application/paths.ts");

    expect(pathsSource).toMatch(/export type HarnessPaths\s*=\s*\{/);
    expect(pathsSource).toMatch(/controlRoot:\s*string/);
    expect(pathsSource).toMatch(/stateRoot:\s*string/);
    expect(pathsSource).toMatch(/workspaceRoot:\s*string/);
    expect(pathsSource).toMatch(/worktreeRoot:\s*string/);
    expect(pathsSource).toMatch(/workspaceRoot/);
    expect(pathsSource).toMatch(/git-worktree/);
    expect(pathsSource).toMatch(/controlRoot/);
    expect(pathsSource).toMatch(/deriveSiblingWorktreeRoot|isPathUnderControlRoot/);

    expect(contextSource).toMatch(/readonly paths:\s*HarnessPaths/);
    expect(depsSource).toMatch(/paths:\s*HarnessPaths/);
    expect(depsSource).toMatch(/new RunStore\(\s*config\s*,\s*paths\.stateRoot\s*\)/);
  });

  it("keeps external home path contracts and rejects controlRoot-nested new-run state helpers", async () => {
    const homeSource = await readSrc("application/harness-home.ts");
    expect(homeSource).toMatch(/export type HarnessHomePaths\s*=\s*\{/);
    expect(homeSource).toMatch(/homeRoot:\s*string/);
    expect(homeSource).toMatch(/projectsRoot:\s*string/);
    expect(homeSource).toMatch(/export type ProjectPaths\s*=\s*\{/);
    expect(homeSource).toMatch(/worktreeRoot:\s*string/);
    expect(homeSource).toMatch(/projectStateRoot:\s*string/);
    expect(homeSource).toMatch(/AGENT_HARNESS_HOME/);
    expect(homeSource).toMatch(/assertWorktreeRootOutsideControlRoot/);

    const pathsSource = await readSrc("application/paths.ts");
    // Absolute external state stays outside controlRoot; relative legacy nests.
    expect(pathsSource).toMatch(/path\.isAbsolute\(config\.stateDirectory\)/);
  });

  it("keeps run-scoped execution on paths.workspaceRoot (or an equivalent workspaceRoot field)", async () => {
    const violations: string[] = [];

    for (const relativePath of EXECUTION_MODULES) {
      const source = await readSrc(relativePath);
      const code = stripCommentsAndStrings(source);
      const usesWorkspaceRoot =
        /\.paths\.workspaceRoot\b/.test(source) ||
        /\bthis\.workspaceRoot\b/.test(source) ||
        /\bthis\.paths\.workspaceRoot\b/.test(source) ||
        /\bpaths\.workspaceRoot\b/.test(source);

      expect(usesWorkspaceRoot, `${relativePath} must consume workspaceRoot`).toBe(true);

      const repoRootMatches = [...code.matchAll(/\b(?:this\.)?(?:ctx\.)?config\.repositoryRoot\b/g)];
      for (const match of repoRootMatches) {
        const index = match.index ?? 0;
        const window = source.slice(Math.max(0, index - 80), index + 80);
        const allowed = ALLOWED_REPOSITORY_ROOT_PATTERNS.some((pattern) => pattern.test(window));
        if (!allowed) {
          violations.push(`${relativePath}: uses config.repositoryRoot near ${window.trim()}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("does not let ApplicationContext command cwd fall back to config.repositoryRoot", async () => {
    const files = [
      "application/task-execution-service.ts",
      "application/planning-service.ts",
      "application/recovery-service.ts"];
    for (const relativePath of files) {
      const source = await readSrc(relativePath);
      expect(source).not.toMatch(/cwd:\s*this\.ctx\.config\.repositoryRoot/);
      expect(source).toMatch(/cwd:\s*this\.ctx\.paths\.workspaceRoot/);
    }
  });
});

describe("architecture: package source inventory", () => {
  it("keeps the execution-module list aligned with src layout", async () => {
    for (const relativePath of EXECUTION_MODULES) {
      await expect(readSrc(relativePath)).resolves.toMatch(/\S/);
    }
    const applicationEntries = await readdir(path.join(srcRoot, "application"));
    expect(applicationEntries).toContain("paths.ts");
  });
});
