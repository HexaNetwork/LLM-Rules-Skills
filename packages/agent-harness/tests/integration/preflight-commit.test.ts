import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeBackend } from "../../src/infrastructure/agents/fake-backend.js";
import { writeRunWorkspace } from "../../src/config/io.js";
import { CONFIG_VERSION, configurationHash } from "../../src/config/schema.js";
import { createRunState, type RunState } from "../../src/domain.js";
import { canonicalizeWorkspacePath } from "../../src/domain/workspace.js";
import { HarnessEngine } from "../../src/application/harness-engine.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";
import {
  createProjectFixture,
  type ProjectFixture} from "../testkit/project-fixture.js";
import { git as runGit } from "../testkit/git.js";

const exec = promisify(execFile);

/**
 * New Git starts use per-run worktrees and no longer block on a dirty control
 * checkout. Commit-order preflight remains for legacy-shared runs only.
 */
async function startThenBlockDirtyWorktree(
  engine: HarnessEngine,
  runId: string,
  files: Record<string, string>,
  blockedFrom: RunState["blockedFrom"] = "new",
): Promise<RunState> {
  const started = await engine.start("Add a feature", runId, false, false);
  expect(started.phase).toBe("new");
  const worktree = engine.paths.workspaceRoot;
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(worktree, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, "utf8");
  }
  return engine.store.record(
    {
      ...started,
      phase: "blocked",
      blockedFrom,
      failure: "dirty tree",
      blockedKind: "workspace",
      blockedRetriable: true},
    "run.blocked",
    {},
  );
}

async function createLegacyBlockedRun(
  root: string,
  runId: string,
  dirtyFiles: Record<string, string>,
): Promise<HarnessEngine> {
  const config = fixtureConfig(root, { git: { enabled: true } as never });
  const engine = new HarnessEngine(config, { backend: createFakeBackend({}) });
  await engine.store.initialize();
  const state = createRunState(
    runId,
    "Legacy dirty tree",
    new Date().toISOString(),
    configurationHash(config),
    CONFIG_VERSION,
  );
  await engine.store.create(state);
  await engine.store.writeJson(runId, "config.json", {
    ...config,
    configVersion: CONFIG_VERSION});
  await writeRunWorkspace(config, runId, {
    version: 1,
    kind: "legacy-shared",
    controlRoot: canonicalizeWorkspacePath(root),
    createdAt: new Date().toISOString()});
  for (const [relative, contents] of Object.entries(dirtyFiles)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, "utf8");
  }
  await engine.store.record(
    {
      ...state,
      phase: "blocked",
      blockedFrom: "new",
      failure: "dirty tree",
      blockedKind: "workspace",
      blockedRetriable: true},
    "run.blocked",
    {},
  );
  return engine;
}

describe("commitPreflight", () => {
  let migratedFixture: ProjectFixture | undefined;

  afterEach(async () => {
    if (migratedFixture) {
      await migratedFixture.cleanup();
      migratedFixture = undefined;
    }
  });

  it("refuses commit-order controls for git-worktree runs", async () => {
    migratedFixture = await createProjectFixture({
      config: { git: { enabled: true } as never }});
    await migratedFixture.initGit();
    const engine = new HarnessEngine(migratedFixture.config, {
      backend: createFakeBackend({})});
    await startThenBlockDirtyWorktree(engine, "run-worktree-gate", {
      "surprise.txt": "untracked\n"});

    await expect(
      engine.commitPreflight("run-worktree-gate", { order: "branch-then-commit" }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/not offered for worktree|committed base/i)});
  });

  it("legacy-shared branch-then-commit still cuts the run branch from HEAD", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);
    const controlBranch = (await git(root, "branch", "--show-current")).trim();
    const engine = await createLegacyBlockedRun(root, "run-branch-first", {
      "surprise.txt": "untracked\n"});

    const resumed = await engine.commitPreflight("run-branch-first", {
      order: "branch-then-commit"});
    expect(resumed.phase).toBe("new");
    expect(resumed.blockedFrom).toBeUndefined();
    expect(resumed.branchName).toBe("harness/run-branch-first");
    expect((await git(root, "branch", "--show-current")).trim()).toBe("harness/run-branch-first");
    expect((await git(root, "status", "--porcelain")).trim()).toBe("");
    // Operator started on main; branch-then-commit moved the shared checkout onto the run branch.
    expect(controlBranch).toBe("main");
    const subject = (await git(root, "log", "-1", "--format=%s")).trim();
    expect(subject).toContain("run-branch-first");
  });

  it("legacy-shared commit-then-branch commits then cuts the run branch", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);
    const engine = await createLegacyBlockedRun(root, "run-commit-first", {
      "surprise.txt": "untracked\n"});

    const resumed = await engine.commitPreflight("run-commit-first", {
      order: "commit-then-branch"});
    expect(resumed.phase).toBe("new");
    expect(resumed.branchName).toBe("harness/run-commit-first");
    expect((await git(root, "status", "--porcelain")).trim()).toBe("");
    expect((await git(root, "branch", "--show-current")).trim()).toBe("harness/run-commit-first");

    const raw = await engine.store.readText("run-commit-first", "events.jsonl");
    expect(raw).toContain("run.preflight_committed");
  });

  it("legacy-shared records order and files on the audit event", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);
    const engine = await createLegacyBlockedRun(root, "audit-run", {
      "surprise.txt": "x\n",
      "second.txt": "y\n"});
    await engine.commitPreflight("audit-run", { order: "commit-then-branch" });

    const events = (await engine.store.readText("audit-run", "events.jsonl"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string; detail: Record<string, unknown> });
    const event = events.find((item) => item.type === "run.preflight_committed");
    expect(event?.detail.order).toBe("commit-then-branch");
    expect(event?.detail.files).toEqual(expect.arrayContaining(["surprise.txt", "second.txt"]));
    expect(event?.detail.auto).toBe(false);
  });

  it("legacy-shared branch-then-commit records the baseBranch deviation", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);
    const engine = await createLegacyBlockedRun(root, "deviation-run", {
      "surprise.txt": "x\n"});
    await engine.commitPreflight("deviation-run", { order: "branch-then-commit" });

    const event = (await engine.store.readText("deviation-run", "events.jsonl"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string; detail: Record<string, unknown> })
      .find((item) => item.type === "run.preflight_committed");
    expect(event!.detail.deviation).toMatch(/current HEAD/i);
  });

  it("legacy-shared never commits the harness state directory", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);
    const engine = await createLegacyBlockedRun(root, "run-state-guard", {
      "surprise.txt": "x\n"});
    await engine.commitPreflight("run-state-guard", { order: "commit-then-branch" });

    const committedFiles = (await runGit(root, "show", "--name-only", "--format=", "HEAD"))
      .split(/\r?\n/)
      .filter(Boolean);
    expect(committedFiles).toContain("surprise.txt");
    expect(committedFiles.some((file) => file.startsWith(".agent-harness/"))).toBe(false);
  });
});

describe("start() with dirty control checkout (worktree semantics)", () => {
  it("starts cleanly without auto-committing the control checkout when autoCommitPreflight is true", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);
    await writeFile(path.join(root, "surprise.txt"), "auto\n", "utf8");

    const config = fixtureConfig(root, {
      git: {
        enabled: true,
        autoCommitPreflight: true,
        preflightCommitOrder: "commit-then-branch"} as never});
    const engine = new HarnessEngine(config, { backend: createFakeBackend({}) });
    const state = await engine.start("Add a feature", "auto-commit-run");

    expect(state.phase).toBe("new");
    expect(state.blockedFrom).toBeUndefined();
    // Control dirty file remains; it is not imported into the worktree.
    expect((await git(root, "status", "--porcelain")).trim()).toContain("surprise.txt");
    expect(state.branchName).toBeUndefined();
    expect((await git(root, "branch", "--list", "harness/*")).trim()).toBe("");

    const raw = await engine.store.readText("auto-commit-run", "events.jsonl");
    expect(raw).toContain("run.worktree_created");
    expect(raw).not.toContain("run.control_checkout_notice");
    expect(raw).not.toContain("run.preflight_committed");
  });

  it("also starts cleanly when autoCommitPreflight is false (dirty control is non-blocking)", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);
    await writeFile(path.join(root, "surprise.txt"), "x\n", "utf8");

    const config = fixtureConfig(root, {
      git: { enabled: true, autoCommitPreflight: false } as never});
    const engine = new HarnessEngine(config, { backend: createFakeBackend({}) });
    const state = await engine.start("Add a feature", "no-auto-run");

    expect(state.phase).toBe("new");
    expect(state.blockedFrom).toBeUndefined();
  });

  it("leaves existing behavior unchanged when git.enabled is false", async () => {
    const root = await fixtureRoot();
    await writeFile(path.join(root, "surprise.txt"), "untracked\n", "utf8");

    const config = fixtureConfig(root, { git: { autoCommitPreflight: true } as never });
    const engine = new HarnessEngine(config, { backend: createFakeBackend({}) });
    const state = await engine.start("Add a feature", "git-disabled-run");

    expect(state.phase).toBe("new");
  });
});

async function initGitRepo(root: string): Promise<void> {
  await git(root, "init");
  await git(root, "config", "user.email", "harness@example.com");
  await git(root, "config", "user.name", "Harness Test");
  await writeFile(path.join(root, ".gitignore"), ".agent-harness/\n", "utf8");
  await git(root, "add", "--all");
  await git(root, "commit", "-m", "initial");
  await git(root, "branch", "-M", "main");
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await exec("git", args, { cwd, windowsHide: true });
  return result.stdout;
}
