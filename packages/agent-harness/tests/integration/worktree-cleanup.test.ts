import path from "node:path";
import { access, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeBackend } from "../../src/infrastructure/agents/fake-backend.js";
import { migrateRunWorkspace } from "../../src/domain/workspace.js";
import { HarnessEngine } from "../../src/application/harness-engine.js";
import { HarnessFailure } from "../../src/errors.js";
import { assertGitWorktreeCapability } from "../../src/git/capabilities.js";
import { git as runGit } from "../testkit/git.js";
import {
  createProjectFixture,
  type ProjectFixture} from "../testkit/project-fixture.js";

describe("worktree cleanup (Slice 7)", () => {
  let fixture: ProjectFixture | undefined;

  afterEach(async () => {
    if (fixture) {
      await fixture.cleanup();
      fixture = undefined;
    }
  });

  async function startSettledRun(runId: string, phase: "completed" | "cancelled" = "completed") {
    await assertGitWorktreeCapability();
    fixture = await createProjectFixture({
      config: {
        git: { enabled: true, baseBranch: "main", branchPrefix: "harness" },
        knowledge: {
          sources: [{ path: "README.md" }],
          repositoryIntelligence: { enabled: false },
          guidance: { enabled: false, maxResults: 0, maxCharacters: 1 }}}});
    await fixture.initGit({ branch: "main" });
    const engine = new HarnessEngine(fixture.config, { backend: createFakeBackend({}) });
    await engine.start("Cleanup target", runId, false, false);
    const state = await engine.store.load(runId);
    await engine.store.writeJson(runId, "state.json", { ...state, phase });
    return engine;
  }

  it("refuses cleanup while the run is non-terminal", async () => {
    await assertGitWorktreeCapability();
    fixture = await createProjectFixture({
      config: {
        git: { enabled: true, baseBranch: "main" },
        knowledge: { repositoryIntelligence: { enabled: false }, guidance: { enabled: false, maxResults: 0, maxCharacters: 1 } }}});
    await fixture.initGit({ branch: "main" });
    const engine = new HarnessEngine(fixture.config, { backend: createFakeBackend({}) });
    await engine.start("Active run", "cleanup-active", false, false);

    await expect(engine.cleanup("cleanup-active")).rejects.toMatchObject({
      message: expect.stringMatching(/settled|completed|cancelled|active/i)});
  });

  it("refuses dirty worktrees and unpublished detached history without discard", async () => {
    const engine = await startSettledRun("cleanup-dirty", "cancelled");
    const workspace = migrateRunWorkspace(
      await engine.store.readJson("cleanup-dirty", "workspace.json"),
      { controlRoot: fixture!.root },
    );
    await writeFile(path.join(workspace.worktreePath!, "orphan.txt"), "dirty\n", "utf8");

    await expect(engine.cleanup("cleanup-dirty")).rejects.toBeInstanceOf(HarnessFailure);
    await expect(engine.cleanup("cleanup-dirty")).rejects.toMatchObject({
      message: expect.stringMatching(/dirty/i)});

    // Clean but unpublished detached commits require discard.
    await runGit(workspace.worktreePath!, "checkout", "--", "orphan.txt").catch(async () => {
      await runGit(workspace.worktreePath!, "clean", "-fd");
    });
    await writeFile(path.join(workspace.worktreePath!, "src-extra.txt"), "committed\n", "utf8");
    await runGit(workspace.worktreePath!, "add", "src-extra.txt");
    await runGit(workspace.worktreePath!, "commit", "-m", "orphan commit");

    await expect(engine.cleanup("cleanup-dirty")).rejects.toMatchObject({
      message: expect.stringMatching(/discard|unpublished|retained/i)});

    const result = await engine.cleanup("cleanup-dirty", { discard: true });
    expect(result.removed).toBe(true);
    const after = migrateRunWorkspace(
      await engine.store.readJson("cleanup-dirty", "workspace.json"),
      { controlRoot: fixture!.root },
    );
    expect(after.removedAt).toMatch(/T/);
    await expect(access(workspace.worktreePath!)).rejects.toThrow();
    const events = await engine.store.readText("cleanup-dirty", "events.jsonl");
    expect(events).toContain("run.worktree_removed");
  });

  it("removes a completed published worktree while retaining branch and state", async () => {
    const engine = await startSettledRun("cleanup-published", "completed");
    const workspace = migrateRunWorkspace(
      await engine.store.readJson("cleanup-published", "workspace.json"),
      { controlRoot: fixture!.root },
    );
    const branch = "harness/cleanup-published";
    await runGit(workspace.worktreePath!, "checkout", "-b", branch);
    await writeFile(path.join(workspace.worktreePath!, "shipped.txt"), "ok\n", "utf8");
    await runGit(workspace.worktreePath!, "add", "shipped.txt");
    await runGit(workspace.worktreePath!, "commit", "-m", "feat: ship");
    await engine.store.writeJson("cleanup-published", "workspace.json", {
      ...workspace,
      branchName: branch});
    const state = await engine.store.load("cleanup-published");
    await engine.store.writeJson("cleanup-published", "state.json", {
      ...state,
      phase: "completed",
      branchName: branch});

    const result = await engine.cleanup("cleanup-published");
    expect(result.removed).toBe(true);
    expect(result.retainedBranch).toBe(branch);

    const after = migrateRunWorkspace(
      await engine.store.readJson("cleanup-published", "workspace.json"),
      { controlRoot: fixture!.root },
    );
    expect(after.removedAt).toBeTruthy();
    expect(after.branchName).toBe(branch);
    expect((await fixture!.git("branch", "--list", branch)).trim()).toContain(branch);
    await expect(access(workspace.worktreePath!)).rejects.toThrow();
    await expect(access(path.join(fixture!.root, ".agent-harness", "runs", "cleanup-published", "state.json"))).resolves.toBeUndefined();
  });
});
