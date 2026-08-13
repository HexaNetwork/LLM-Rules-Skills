import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, access } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createFakeBackend } from "../../src/infrastructure/agents/fake-backend.js";
import { dirtyTreeMessage } from "../../src/application/helpers.js";
import { resolveHarnessPaths } from "../../src/application/paths.js";
import { migrateRunWorkspace } from "../../src/domain/workspace.js";
import { GitService } from "../../src/git.js";
import { HarnessEngine } from "../../src/application/harness-engine.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";
import { git as runGit } from "../testkit/git.js";

const exec = promisify(execFile);

describe("run-start git preflight", () => {
  it("starts a worktree run while the control checkout is dirty without importing changes", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);
    await writeFile(path.join(root, "surprise.txt"), "untracked\n", "utf8");

    const config = fixtureConfig(root, { git: { enabled: true } as never });
    const engine = new HarnessEngine(config, { backend: createFakeBackend({}) });

    const state = await engine.start("Add a feature", "dirty-control");
    expect(state.phase).toBe("new");
    expect(state.blockedFrom).toBeUndefined();
    expect(await access(path.join(root, "surprise.txt")).then(() => true)).toBe(true);

    const workspace = migrateRunWorkspace(
      await engine.store.readJson("dirty-control", "workspace.json"),
      { controlRoot: root },
    );
    expect(workspace.kind).toBe("git-worktree");
    await expect(
      access(path.join(workspace.worktreePath!, "surprise.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const events = (await engine.store.readText("dirty-control", "events.jsonl"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string; detail: Record<string, unknown> });
    expect(events.some((event) => event.type === "run.control_checkout_notice")).toBe(false);
    expect(events.some((event) => event.type === "run.worktree_created")).toBe(true);
  });

  it("starts detached at baseSha without creating a delivery branch or switching control", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);
    const controlBranch = (await git(root, "branch", "--show-current")).trim();
    const baseSha = (await git(root, "rev-parse", "HEAD")).trim();

    const config = fixtureConfig(root, { git: { enabled: true } as never });
    const engine = new HarnessEngine(config, { backend: createFakeBackend({}) });

    const state = await engine.start("Add a feature", "run-early-branch");
    expect(state.phase).toBe("new");
    expect(state.blockedFrom).toBeUndefined();
    expect(state.branchName).toBeUndefined();
    expect((await git(root, "branch", "--show-current")).trim()).toBe(controlBranch);
    expect((await git(root, "branch", "--list", "harness/*")).trim()).toBe("");

    const workspace = migrateRunWorkspace(
      await engine.store.readJson("run-early-branch", "workspace.json"),
      { controlRoot: root },
    );
    expect(workspace.baseSha).toBe(baseSha);
    expect((await runGit(workspace.worktreePath!, "rev-parse", "HEAD")).trim()).toBe(baseSha);

    const raw = await engine.store.readText("run-early-branch", "events.jsonl");
    expect(raw).toContain("run.worktree_created");
    expect(raw).not.toContain("run.branch_ready");
  });

  it("creates the worktree from git.baseBranch while leaving the operator checkout alone", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);
    await writeFile(path.join(root, "only-on-feature.txt"), "feature\n", "utf8");
    await git(root, "checkout", "-b", "feature");
    await git(root, "add", "--all");
    await git(root, "commit", "-m", "feature-only file");

    const config = fixtureConfig(root, {
      git: { enabled: true, baseBranch: "main" } as never});
    const engine = new HarnessEngine(config, { backend: createFakeBackend({}) });
    const state = await engine.start("Add a feature", "run-from-base");

    expect(state.branchName).toBeUndefined();
    expect((await git(root, "branch", "--show-current")).trim()).toBe("feature");
    expect(await access(path.join(root, "only-on-feature.txt")).then(() => true)).toBe(true);

    const workspace = migrateRunWorkspace(
      await engine.store.readJson("run-from-base", "workspace.json"),
      { controlRoot: root },
    );
    await expect(
      access(path.join(workspace.worktreePath!, "only-on-feature.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips worktree creation when git.enabled is false", async () => {
    const root = await fixtureRoot();
    await writeFile(path.join(root, "surprise.txt"), "untracked\n", "utf8");

    const config = fixtureConfig(root);
    const engine = new HarnessEngine(config, { backend: createFakeBackend({}) });

    const state = await engine.start("Add a feature", "git-off");
    expect(state.phase).toBe("new");
    const workspace = migrateRunWorkspace(
      await engine.store.readJson("git-off", "workspace.json"),
      { controlRoot: root },
    );
    expect(workspace.kind).toBe("git-disabled");
    expect(resolveHarnessPaths(config, workspace).workspaceRoot).toBe(
      resolveHarnessPaths(config).controlRoot,
    );
  });

  it("blocks with a clear workspace message when git.enabled but the project is not a git repository", async () => {
    const root = await fixtureRoot();
    // Deliberately skip initGitRepo — mirrors install-wizard deploy into a plain folder.

    const config = fixtureConfig(root, { git: { enabled: true } as never });
    const engine = new HarnessEngine(config, { backend: createFakeBackend({}) });

    const state = await engine.start("Add a feature");
    expect(state.phase).toBe("blocked");
    expect(state.blockedFrom).toBe("new");
    expect(state.blockedKind).toBe("workspace");
    expect(state.failure).toMatch(/not a git repository/i);
    expect(state.failure).toMatch(/git\.enabled:\s*false|git init/i);
    expect(state.failure).not.toMatch(/failed \(128\)/);
  });

  it("formats dirty-tree messages with a truncated path list for operators", () => {
    const paths = Array.from({ length: 15 }, (_, index) =>
      `file-${String(index).padStart(2, "0")}.txt`,
    );
    const message = dirtyTreeMessage(paths);
    expect(message).toContain("+5 more");
    expect(message.match(/file-\d\d\.txt/g)).toHaveLength(10);
  });

  it("still rejects ensureRunBranch when the shared tree goes dirty (legacy helper)", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);

    const config = fixtureConfig(root, { git: { enabled: true } as never });
    const service = new GitService(config);
    expect(await service.ensureRunBranch("run-one")).toBe("harness/run-one");

    await writeFile(path.join(root, "late-change.txt"), "late\n", "utf8");
    await expect(service.ensureRunBranch("run-two")).rejects.toThrow(/dirty working tree/i);
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
