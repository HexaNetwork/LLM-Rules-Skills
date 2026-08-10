import path from "node:path";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { HarnessConfigSchema, type HarnessConfig } from "../../src/config.js";
import { sanitizeWorktreeRunId } from "../../src/domain/workspace.js";
import { git } from "./git.js";

const FIXTURE_PREFIX = "agent-harness-test-";

export type LinkedWorktreeInfo = {
  path: string;
  runId: string;
  headSha: string;
  gitCommonDir: string;
  detached: boolean;
  registered: boolean;
  read(relativePath: string): Promise<string>;
  git(...args: string[]): Promise<string>;
};

export type ProjectFixture = {
  root: string;
  config: HarnessConfig;
  write(relativePath: string, contents: string | Uint8Array): Promise<void>;
  read(relativePath: string): Promise<string>;
  initGit(options?: { branch?: string; ignored?: string[] }): Promise<void>;
  git(...args: string[]): Promise<string>;
  /** Default parent for linked worktrees: `<root>/.agent-harness/worktrees`. */
  worktreeParent(): string;
  addDetachedWorktree(
    runId: string,
    options?: { baseSha?: string; parentDir?: string },
  ): Promise<LinkedWorktreeInfo>;
  inspectWorktree(worktreePath: string): Promise<LinkedWorktreeInfo>;
  reopenWorktree(worktreePath: string): Promise<LinkedWorktreeInfo>;
  removeWorktree(worktreePath: string, options?: { force?: boolean }): Promise<void>;
  listWorktrees(): Promise<Array<{ path: string; headSha: string; detached: boolean }>>;
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
    worktreeParent(this: ProjectFixture) {
      return path.join(this.root, ".agent-harness", "worktrees");
    },
    async addDetachedWorktree(this: ProjectFixture, runId, options = {}) {
      const safeRunId = sanitizeWorktreeRunId(runId);
      const parentDir = options.parentDir
        ? path.resolve(options.parentDir)
        : this.worktreeParent();
      assertPathInsideFixture(parentDir, this.root, "worktree parent");
      await mkdir(parentDir, { recursive: true });
      const worktreePath = path.join(parentDir, safeRunId);
      const baseSha = (options.baseSha ?? (await git(this.root, "rev-parse", "HEAD"))).trim();
      await git(this.root, "worktree", "add", "--detach", worktreePath, baseSha);
      return this.inspectWorktree(worktreePath);
    },
    async inspectWorktree(this: ProjectFixture, worktreePath) {
      const resolved = path.resolve(worktreePath);
      assertPathInsideFixture(resolved, this.root, "worktree path");
      const listed = await this.listWorktrees();
      const entry = listed.find((item) => pathsEqual(item.path, resolved));
      if (!entry) {
        throw new Error(`Worktree is not registered in git worktree list: ${resolved}`);
      }
      const commonRaw = (await git(resolved, "rev-parse", "--git-common-dir")).trim();
      return buildLinkedWorktreeInfo({
        path: resolved,
        runId: path.basename(resolved),
        headSha: entry.headSha,
        gitCommonDir: path.resolve(resolved, commonRaw),
        detached: entry.detached,
        registered: true,
      });
    },
    async reopenWorktree(this: ProjectFixture, worktreePath) {
      const info = await this.inspectWorktree(worktreePath);
      if (!info.registered) {
        throw new Error(
          `Refusing to reopen unregistered worktree (missing from git worktree list): ${info.path}`,
        );
      }
      // Touch the worktree through git to prove it is still usable after "process reconstruction".
      const head = (await info.git("rev-parse", "HEAD")).trim();
      const commonRaw = (await info.git("rev-parse", "--git-common-dir")).trim();
      return buildLinkedWorktreeInfo({
        ...info,
        headSha: head,
        gitCommonDir: path.resolve(info.path, commonRaw),
      });
    },
    async removeWorktree(this: ProjectFixture, worktreePath, options = {}) {
      const resolved = path.resolve(worktreePath);
      assertSafeFixtureRoot(this.root);
      assertPathInsideFixture(resolved, this.root, "worktree path");
      if (pathsEqual(resolved, this.root)) {
        throw new Error(`Refusing to remove the fixture control root as a worktree: ${resolved}`);
      }
      const listed = await this.listWorktrees();
      const registered = listed.some((item) => pathsEqual(item.path, resolved));
      if (!registered) {
        throw new Error(
          `Refusing to remove path that is not a registered worktree: ${resolved}`,
        );
      }
      const args = ["worktree", "remove"];
      if (options.force) args.push("--force");
      args.push(resolved);
      await git(this.root, ...args);
    },
    async listWorktrees(this: ProjectFixture) {
      const porcelain = await git(this.root, "worktree", "list", "--porcelain");
      return parseWorktreePorcelain(porcelain);
    },
    async cleanup(this: ProjectFixture) {
      assertSafeFixtureRoot(this.root);
      try {
        const listed = await this.listWorktrees();
        for (const entry of listed) {
          if (pathsEqual(entry.path, this.root)) continue;
          if (!normalizeForCompare(entry.path).startsWith(normalizeForCompare(this.root))) {
            continue;
          }
          try {
            await git(this.root, "worktree", "remove", "--force", entry.path);
          } catch {
            // Fall through to recursive rm of the fixture root.
          }
        }
      } catch {
        // Repo may already be partially deleted.
      }
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

function buildLinkedWorktreeInfo(info: Omit<LinkedWorktreeInfo, "read" | "git">): LinkedWorktreeInfo {
  return {
    ...info,
    async read(relativePath) {
      assertRelative(relativePath);
      return readFile(path.join(info.path, relativePath), "utf8");
    },
    async git(...args: string[]) {
      return git(info.path, ...args);
    },
  };
}

function parseWorktreePorcelain(
  porcelain: string,
): Array<{ path: string; headSha: string; detached: boolean }> {
  const entries: Array<{ path: string; headSha: string; detached: boolean }> = [];
  let current: { path?: string; headSha?: string; detached: boolean } | undefined;
  for (const line of porcelain.split(/\r?\n/)) {
    if (line === "") {
      if (current?.path && current.headSha) {
        entries.push({
          path: path.resolve(current.path),
          headSha: current.headSha,
          detached: current.detached,
        });
      }
      current = undefined;
      continue;
    }
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), detached: false };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) {
      current.headSha = line.slice("HEAD ".length).trim();
    } else if (line === "detached") {
      current.detached = true;
    }
  }
  if (current?.path && current.headSha) {
    entries.push({
      path: path.resolve(current.path),
      headSha: current.headSha,
      detached: current.detached,
    });
  }
  return entries;
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

function assertPathInsideFixture(target: string, root: string, label: string): void {
  assertSafeFixtureRoot(root);
  const normalizedTarget = normalizeForCompare(target);
  const normalizedRoot = normalizeForCompare(root);
  const prefix = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : `${normalizedRoot}${path.sep}`;
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(prefix)) {
    throw new Error(`Refusing ${label} outside fixture root (${root}): ${target}`);
  }
}

function pathsEqual(left: string, right: string): boolean {
  return normalizeForCompare(left) === normalizeForCompare(right);
}

function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
