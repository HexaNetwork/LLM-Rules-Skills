import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createFakeBackend } from "../../src/agent.js";
import { GitService } from "../../src/git.js";
import { HarnessEngine } from "../../src/engine.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

const exec = promisify(execFile);

describe("run-start git preflight", () => {
  it("blocks with blockedFrom 'new' on a dirty tree and never invokes the reflector", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);
    await writeFile(path.join(root, "surprise.txt"), "untracked\n", "utf8");

    const config = fixtureConfig(root, { git: { enabled: true } as never });
    const engine = new HarnessEngine(config, { backend: createFakeBackend({}) });

    const state = await engine.start("Add a feature");
    expect(state.phase).toBe("blocked");
    expect(state.blockedFrom).toBe("new");
    expect(state.failure).toMatch(/uncommitted changes/i);
    expect(state.failure).toContain("surprise.txt");
  });

  it("proceeds past start on a clean tree", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);

    const config = fixtureConfig(root, { git: { enabled: true } as never });
    const engine = new HarnessEngine(config, { backend: createFakeBackend({}) });

    const state = await engine.start("Add a feature");
    expect(state.phase).toBe("new");
    expect(state.blockedFrom).toBeUndefined();
  });

  it("skips the preflight entirely when git.enabled is false", async () => {
    const root = await fixtureRoot();
    await writeFile(path.join(root, "surprise.txt"), "untracked\n", "utf8");

    const config = fixtureConfig(root);
    const engine = new HarnessEngine(config, { backend: createFakeBackend({}) });

    const state = await engine.start("Add a feature");
    expect(state.phase).toBe("new");
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

  it("truncates the offending-path list for a large dirty tree", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);
    for (let index = 0; index < 15; index += 1) {
      await writeFile(path.join(root, `file-${String(index).padStart(2, "0")}.txt`), "x\n", "utf8");
    }

    const config = fixtureConfig(root, { git: { enabled: true } as never });
    const engine = new HarnessEngine(config, { backend: createFakeBackend({}) });

    const state = await engine.start("Add a feature");
    expect(state.phase).toBe("blocked");
    expect(state.failure).toContain("+5 more");
    expect(state.failure?.match(/file-\d\d\.txt/g)).toHaveLength(10);
  });

  it("still rejects a tree that goes dirty after a clean start (defense in depth)", async () => {
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
