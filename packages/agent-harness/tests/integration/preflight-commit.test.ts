import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeBackend } from "../../src/agent.js";
import { HarnessEngine } from "../../src/engine.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";
import {
  createProjectFixture,
  type ProjectFixture,
} from "../testkit/project-fixture.js";

const exec = promisify(execFile);

describe("commitPreflight", () => {
  let migratedFixture: ProjectFixture | undefined;

  afterEach(async () => {
    if (migratedFixture) {
      await migratedFixture.cleanup();
      migratedFixture = undefined;
    }
  });

  it("branch-then-commit cuts the run branch from HEAD, commits onto it, and leaves the base branch untouched", async () => {
    migratedFixture = await createProjectFixture({
      config: { git: { enabled: true } as never },
    });
    await migratedFixture.initGit();
    const baseHeadBefore = (await migratedFixture.git("rev-parse", "main")).trim();
    await migratedFixture.write("surprise.txt", "untracked\n");

    const engine = new HarnessEngine(migratedFixture.config, {
      backend: createFakeBackend({}),
    });
    const blocked = await engine.start("Add a feature", "run-branch-first");
    expect(blocked.phase).toBe("blocked");
    expect(blocked.blockedFrom).toBe("new");

    const resumed = await engine.commitPreflight("run-branch-first", { order: "branch-then-commit" });
    expect(resumed.phase).toBe("new");
    expect(resumed.blockedFrom).toBeUndefined();
    expect(resumed.failure).toBeUndefined();
    expect(resumed.branchName).toBe("harness/run-branch-first");

    expect((await migratedFixture.git("branch", "--show-current")).trim()).toBe(
      "harness/run-branch-first",
    );
    expect((await migratedFixture.git("status", "--porcelain")).trim()).toBe("");

    const baseHeadAfter = (await migratedFixture.git("rev-parse", "main")).trim();
    expect(baseHeadAfter).toBe(baseHeadBefore);

    const subject = (await migratedFixture.git("log", "-1", "--format=%s")).trim();
    expect(subject).toContain("run-branch-first");
  });

  it("commit-then-branch commits on the current branch, then cuts the run branch for interview", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);
    await writeFile(path.join(root, "surprise.txt"), "untracked\n", "utf8");

    const config = fixtureConfig(root, { git: { enabled: true } as never });
    const engine = new HarnessEngine(config, { backend: createFakeBackend({}) });
    const blocked = await engine.start("Add a feature", "run-commit-first");
    expect(blocked.phase).toBe("blocked");

    const resumed = await engine.commitPreflight("run-commit-first", { order: "commit-then-branch" });
    expect(resumed.phase).toBe("new");
    // Preflight commit landed on main; the run branch is cut afterward so
    // reflect/grill do not keep using the operator checkout.
    expect(resumed.branchName).toBe("harness/run-commit-first");
    expect((await git(root, "branch", "--show-current")).trim()).toBe("harness/run-commit-first");
    expect((await git(root, "status", "--porcelain")).trim()).toBe("");

    const raw = await engine.store.readText("run-commit-first", "events.jsonl");
    const events = raw
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string; detail: Record<string, unknown> });
    const committed = events.find((event) => event.type === "run.preflight_committed");
    expect(committed!.detail.branch).toBe("main");
    expect(events.some((event) => event.type === "run.branch_ready")).toBe(true);
  });

  it("is safe to call on a run blocked from 'planning'", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);

    const config = fixtureConfig(root, { git: { enabled: true } as never });
    const engine = new HarnessEngine(config, { backend: createFakeBackend({}) });
    const started = await engine.start("Add a feature", "run-planning-block");
    expect(started.phase).toBe("new");

    // Simulate a run that reached "planning" before going dirty and getting blocked there.
    await engine.store.record(
      { ...started, phase: "blocked", blockedFrom: "planning", failure: "dirty tree during plan" },
      "run.blocked",
      {},
    );
    await writeFile(path.join(root, "late-change.txt"), "late\n", "utf8");

    const resumed = await engine.commitPreflight("run-planning-block", { order: "branch-then-commit" });
    expect(resumed.phase).toBe("planning");
    expect(resumed.blockedFrom).toBeUndefined();
    expect(resumed.branchName).toBe("harness/run-planning-block");
    expect((await git(root, "status", "--porcelain")).trim()).toBe("");
  });

  it("commits tracked files under a gitignored directory during preflight", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);
    await mkdir(path.join(root, ".cursor", "skills"), { recursive: true });
    await writeFile(path.join(root, ".cursor", "skills", "note.md"), "v1\n", "utf8");
    await git(root, "add", "-f", "--", ".cursor/skills/note.md");
    await git(root, "commit", "-m", "track cursor skill");
    await writeFile(path.join(root, ".gitignore"), ".agent-harness/\n/.cursor/\n", "utf8");
    await git(root, "add", "--", ".gitignore");
    await git(root, "commit", "-m", "ignore .cursor");
    await writeFile(path.join(root, ".cursor", "skills", "note.md"), "v2\n", "utf8");

    const config = fixtureConfig(root, { git: { enabled: true } as never });
    const engine = new HarnessEngine(config, { backend: createFakeBackend({}) });
    const blocked = await engine.start("Add a feature", "run-ignored-tracked");
    expect(blocked.phase).toBe("blocked");
    expect(blocked.failure).toMatch(/dirty working tree|uncommitted changes/i);

    const resumed = await engine.commitPreflight("run-ignored-tracked", {
      order: "commit-then-branch",
    });
    expect(resumed.phase).toBe("new");
    expect(resumed.failure).toBeUndefined();
    expect((await git(root, "status", "--porcelain")).trim()).toBe("");
    expect(await git(root, "show", "--pretty=", "--name-only", "HEAD")).toContain(
      ".cursor/skills/note.md",
    );
  });

  it("never commits the harness state directory, even when it is not gitignored", async () => {
    const root = await fixtureRoot();
    await git(root, "init");
    await git(root, "config", "user.email", "harness@example.com");
    await git(root, "config", "user.name", "Harness Test");
    await git(root, "add", "--all");
    await git(root, "commit", "-m", "initial");
    await git(root, "branch", "-M", "main");
    await writeFile(path.join(root, "surprise.txt"), "x\n", "utf8");

    const config = fixtureConfig(root, { git: { enabled: true } as never });
    const engine = new HarnessEngine(config, { backend: createFakeBackend({}) });
    await engine.start("Add a feature", "run-state-guard");

    const resumed = await engine.commitPreflight("run-state-guard", { order: "commit-then-branch" });
    expect(resumed.phase).toBe("new");

    const committedFiles = (await git(root, "show", "--name-only", "--format=", "HEAD"))
      .split(/\r?\n/)
      .filter(Boolean);
    expect(committedFiles).toContain("surprise.txt");
    expect(committedFiles.some((file) => file.startsWith(".agent-harness/"))).toBe(false);

    // The (ungitignored) state directory is still there, untracked, proving it was excluded on purpose.
    expect(await git(root, "status", "--porcelain")).toContain(".agent-harness/");
  });

  it("records the committed file list and order on the audit event", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);
    await writeFile(path.join(root, "surprise.txt"), "x\n", "utf8");
    await writeFile(path.join(root, "second.txt"), "y\n", "utf8");

    const config = fixtureConfig(root, { git: { enabled: true } as never });
    const engine = new HarnessEngine(config, { backend: createFakeBackend({}) });
    await engine.start("Add a feature", "audit-run");
    await engine.commitPreflight("audit-run", { order: "commit-then-branch" });

    const raw = await engine.store.readText("audit-run", "events.jsonl");
    const events = raw
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string; detail: Record<string, unknown> });
    const event = events.find((item) => item.type === "run.preflight_committed");
    expect(event).toBeTruthy();
    expect(event!.detail.order).toBe("commit-then-branch");
    expect(event!.detail.files).toEqual(
      expect.arrayContaining(["surprise.txt", "second.txt"]),
    );
    expect(event!.detail.auto).toBe(false);
  });

  it("branch-then-commit records the baseBranch deviation in the audit event detail", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);
    await writeFile(path.join(root, "surprise.txt"), "x\n", "utf8");

    const config = fixtureConfig(root, { git: { enabled: true } as never });
    const engine = new HarnessEngine(config, { backend: createFakeBackend({}) });
    await engine.start("Add a feature", "deviation-run");
    await engine.commitPreflight("deviation-run", { order: "branch-then-commit" });

    const raw = await engine.store.readText("deviation-run", "events.jsonl");
    const event = raw
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string; detail: Record<string, unknown> })
      .find((item) => item.type === "run.preflight_committed");
    expect(event!.detail.deviation).toMatch(/current HEAD/i);
  });
});

describe("start() with git.autoCommitPreflight", () => {
  it("proceeds on a dirty tree when autoCommitPreflight is true", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);
    await writeFile(path.join(root, "surprise.txt"), "auto\n", "utf8");

    const config = fixtureConfig(root, {
      git: { enabled: true, autoCommitPreflight: true, preflightCommitOrder: "commit-then-branch" } as never,
    });
    const engine = new HarnessEngine(config, { backend: createFakeBackend({}) });
    const state = await engine.start("Add a feature", "auto-commit-run");

    expect(state.phase).toBe("new");
    expect(state.blockedFrom).toBeUndefined();
    expect((await git(root, "status", "--porcelain")).trim()).toBe("");
    expect(state.branchName).toBe("harness/auto-commit-run");
    expect((await git(root, "branch", "--show-current")).trim()).toBe("harness/auto-commit-run");

    const raw = await engine.store.readText("auto-commit-run", "events.jsonl");
    expect(raw).toContain("run.preflight_committed");
    expect(raw).toContain("run.branch_ready");
  });

  it("still blocks on a dirty tree when autoCommitPreflight is false (unchanged default behavior)", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);
    await writeFile(path.join(root, "surprise.txt"), "x\n", "utf8");

    const config = fixtureConfig(root, { git: { enabled: true, autoCommitPreflight: false } as never });
    const engine = new HarnessEngine(config, { backend: createFakeBackend({}) });
    const state = await engine.start("Add a feature", "no-auto-run");

    expect(state.phase).toBe("blocked");
    expect(state.blockedFrom).toBe("new");
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
