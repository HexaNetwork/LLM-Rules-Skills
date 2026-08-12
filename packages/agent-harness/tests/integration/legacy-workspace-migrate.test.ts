import path from "node:path";
import { access, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeBackend } from "../../src/agent.js";
import { CONFIG_VERSION, configurationHash, writeRunWorkspace } from "../../src/config.js";
import { createRunState } from "../../src/domain.js";
import { canonicalizeWorkspacePath, migrateRunWorkspace } from "../../src/domain/workspace.js";
import { HarnessEngine } from "../../src/engine.js";
import { assertGitWorktreeCapability } from "../../src/git/capabilities.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";
import { git as runGit } from "../testkit/git.js";

describe("legacy workspace migration (Slice 7)", () => {
  afterEach(async () => {
    // fixture roots are temp dirs left for OS cleanup
  });

  async function createLegacyRun(root: string, runId: string): Promise<HarnessEngine> {
    const config = fixtureConfig(root, { git: { enabled: true } as never });
    const engine = new HarnessEngine(config, { backend: createFakeBackend({}) });
    await engine.store.initialize();
    const state = createRunState(
      runId,
      "Legacy migrate me",
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
      baseBranch: "main",
      baseSha: (await runGit(root, "rev-parse", "HEAD")).trim(),
      branchName: "harness/legacy-migrate",
      createdAt: new Date().toISOString()});
    await runGit(root, "checkout", "-b", "harness/legacy-migrate");
    return engine;
  }

  it("refuses silent migration when the legacy tree is dirty", async () => {
    await assertGitWorktreeCapability();
    const root = await fixtureRoot();
    await initGit(root);
    const engine = await createLegacyRun(root, "legacy-dirty");
    await writeFile(path.join(root, "dirty.txt"), "nope\n", "utf8");

    await expect(engine.migrateWorkspace("legacy-dirty")).rejects.toMatchObject({
      message: expect.stringMatching(/dirty|clean/i)});
    const workspace = migrateRunWorkspace(
      await engine.store.readJson("legacy-dirty", "workspace.json"),
      { controlRoot: root },
    );
    expect(workspace.kind).toBe("legacy-shared");
  });

  it("migrates a clean legacy run onto a registered worktree at the current HEAD", async () => {
    await assertGitWorktreeCapability();
    const root = await fixtureRoot();
    await initGit(root);
    const engine = await createLegacyRun(root, "legacy-clean");
    const head = (await runGit(root, "rev-parse", "HEAD")).trim();
    const controlBranch = (await runGit(root, "branch", "--show-current")).trim();

    const result = await engine.migrateWorkspace("legacy-clean");
    expect(result.workspace.kind).toBe("git-worktree");
    expect(result.workspace.worktreePath).toBeTruthy();
    expect(result.workspace.baseSha).toBe(head);
    expect(result.workspace.branchName).toBe("harness/legacy-migrate");
    await access(result.workspace.worktreePath!);
    expect((await runGit(result.workspace.worktreePath!, "rev-parse", "HEAD")).trim()).toBe(head);
    expect((await runGit(root, "branch", "--show-current")).trim()).toBe(controlBranch);

    const events = await engine.store.readText("legacy-clean", "events.jsonl");
    expect(events).toContain("run.workspace_migrated");
  });
});

async function initGit(root: string): Promise<void> {
  await runGit(root, "init");
  await runGit(root, "config", "user.email", "harness@example.com");
  await runGit(root, "config", "user.name", "Harness Test");
  await writeFile(path.join(root, ".gitignore"), ".agent-harness/\n", "utf8");
  await writeFile(path.join(root, "README.md"), "# fixture\n", "utf8");
  await runGit(root, "add", "--all");
  await runGit(root, "commit", "-m", "initial");
  await runGit(root, "branch", "-M", "main");
}
