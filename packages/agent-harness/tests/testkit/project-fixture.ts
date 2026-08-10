import path from "node:path";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { HarnessConfigSchema, type HarnessConfig } from "../../src/config.js";
import { git } from "./git.js";

const FIXTURE_PREFIX = "agent-harness-test-";

export type ProjectFixture = {
  root: string;
  config: HarnessConfig;
  write(relativePath: string, contents: string | Uint8Array): Promise<void>;
  read(relativePath: string): Promise<string>;
  initGit(options?: { branch?: string; ignored?: string[] }): Promise<void>;
  git(...args: string[]): Promise<string>;
  cleanup(): Promise<void>;
};

export async function createProjectFixture(options?: {
  config?: Partial<HarnessConfig>;
  initialFiles?: Record<string, string>;
}): Promise<ProjectFixture> {
  const root = await mkdtemp(path.join(tmpdir(), FIXTURE_PREFIX));
  const initialFiles = options?.initialFiles ?? {
    "README.md": "# Fixture\n",
    "docs/.gitkeep": "",
  };

  for (const [relativePath, contents] of Object.entries(initialFiles)) {
    const absolute = path.join(root, relativePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  }

  const config = buildFixtureConfig(root, options?.config);

  const fixture: ProjectFixture = {
    root,
    config,
    async write(this: ProjectFixture, relativePath, contents) {
      assertRelative(relativePath);
      const absolute = path.join(this.root, relativePath);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, contents);
    },
    async read(this: ProjectFixture, relativePath) {
      assertRelative(relativePath);
      return readFile(path.join(this.root, relativePath), "utf8");
    },
    async initGit(this: ProjectFixture, gitOptions = {}) {
      const branch = gitOptions.branch ?? "main";
      const ignored = gitOptions.ignored ?? [".agent-harness/"];
      await git(this.root, "init");
      await git(this.root, "config", "user.email", "harness@example.com");
      await git(this.root, "config", "user.name", "Harness Test");
      const gitignorePath = path.join(this.root, ".gitignore");
      let existing = "";
      try {
        await access(gitignorePath);
        existing = await readFile(gitignorePath, "utf8");
      } catch {
        // no .gitignore yet
      }
      const lines = new Set(
        existing
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean),
      );
      for (const entry of ignored) lines.add(entry);
      await writeFile(gitignorePath, `${[...lines].join("\n")}\n`, "utf8");
      await git(this.root, "add", "--all");
      await git(this.root, "commit", "-m", "initial");
      await git(this.root, "branch", "-M", branch);
    },
    async git(this: ProjectFixture, ...args: string[]) {
      return git(this.root, ...args);
    },
    async cleanup(this: ProjectFixture) {
      assertSafeFixtureRoot(this.root);
      await rm(this.root, { recursive: true, force: true, maxRetries: 3 });
    },
  };

  return fixture;
}

/** Build a parsed harness config rooted at `root` (shared with legacy helpers). */
export function buildFixtureConfig(
  root: string,
  overrides: Partial<HarnessConfig> = {},
): HarnessConfig {
  const base = HarnessConfigSchema.parse({
    version: 2,
    repositoryRoot: root,
    stateDirectory: ".agent-harness",
    models: { small: "small-model", capable: "capable-model", roles: {} },
    agent: {
      provider: "cursor",
      timeoutMs: 1_000,
      promptBuilder: true,
      schemaRepairAttempts: 0,
    },
    workflow: {
      tdd: true,
      maxStepsPerRun: 25,
      maxTestAttempts: 2,
      maxImplementationAttempts: 3,
      maxReviewAttempts: 2,
      maxGrillQuestionsPerEpisode: 5,
      staleAnswerMinutes: 30,
      contextResults: 6,
      contextCharacters: 12_000,
    },
    commands: { test: 'node -e "process.exit(0)"', gates: [] },
    git: {
      enabled: false,
      baseBranch: "main",
      branchPrefix: "harness",
      remote: "origin",
      push: false,
      openPullRequest: false,
    },
    tracker: { kind: "local" },
    knowledge: { sources: ["README.md", "docs"], chunkCharacters: 400 },
  });
  return HarnessConfigSchema.parse({
    ...base,
    ...overrides,
    repositoryRoot: root,
    models: { ...base.models, ...overrides.models },
    agent: { ...base.agent, ...overrides.agent },
    workflow: { ...base.workflow, ...overrides.workflow },
    commands: { ...base.commands, ...overrides.commands },
    git: { ...base.git, ...overrides.git },
    tracker: { ...base.tracker, ...overrides.tracker },
    knowledge: { ...base.knowledge, ...overrides.knowledge },
  });
}

export function fixtureTempPrefix(): string {
  return path.resolve(tmpdir(), FIXTURE_PREFIX);
}

function assertRelative(relativePath: string): void {
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
    throw new Error(`Fixture paths must be relative and contained: ${relativePath}`);
  }
}

function assertSafeFixtureRoot(root: string): void {
  const resolved = path.resolve(root);
  const prefix = fixtureTempPrefix();
  const normalizedRoot = normalizeForCompare(resolved);
  const normalizedPrefix = normalizeForCompare(prefix);
  if (!normalizedRoot.startsWith(normalizedPrefix)) {
    throw new Error(
      `Refusing to cleanup path outside fixture temp prefix (${prefix}): ${resolved}`,
    );
  }
}

function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
