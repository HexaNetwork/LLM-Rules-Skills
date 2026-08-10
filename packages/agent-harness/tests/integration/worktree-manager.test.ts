import path from "node:path";
import { access } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { resolveHarnessPaths } from "../../src/application/paths.js";
import { canonicalizeWorkspacePath, sanitizeWorktreeRunId } from "../../src/domain/workspace.js";
import { assertGitWorktreeCapability } from "../../src/git/capabilities.js";
import { WorktreeManager } from "../../src/git/worktree-manager.js";
import { RunStore } from "../../src/store.js";
import {
  createProjectFixture,
  type ProjectFixture,
} from "../testkit/project-fixture.js";

describe("WorktreeManager", () => {
  let fixture: ProjectFixture | undefined;

  afterEach(async () => {
    if (fixture) {
      await fixture.cleanup();
      fixture = undefined;
    }
  });

  it("creates a detached worktree at baseSha under stateRoot/worktrees", async () => {
    await assertGitWorktreeCapability();
    fixture = await createProjectFixture({
      config: { git: { enabled: true, baseBranch: "main" } },
    });
    await fixture.initGit({ branch: "main" });
    await fixture.git("checkout", "-b", "operator");
    await fixture.write("operator-only.txt", "operator\n");
    await fixture.git("add", "--all");
    await fixture.git("commit", "-m", "operator branch tip");

    const baseSha = (await fixture.git("rev-parse", "main")).trim();
    const controlBranch = (await fixture.git("branch", "--show-current")).trim();
    expect(controlBranch).toBe("operator");

    const paths = resolveHarnessPaths(fixture.config);
    const store = new RunStore(fixture.config, paths.stateRoot);
    await store.initialize();
    const manager = new WorktreeManager({
      controlRoot: paths.controlRoot,
      stateRoot: paths.stateRoot,
      store,
    });

    const workspace = await manager.create({
      runId: "Slice Two Run",
      baseBranch: "main",
    });

    expect(workspace.kind).toBe("git-worktree");
    expect(workspace.baseBranch).toBe("main");
    expect(workspace.baseSha).toBe(baseSha);
    expect(workspace.branchName).toBeUndefined();
    expect(workspace.worktreePath).toBe(
      canonicalizeWorkspacePath(
        path.join(paths.stateRoot, "worktrees", sanitizeWorktreeRunId("Slice Two Run")),
      ),
    );

    const inspection = await manager.inspect(workspace);
    expect(inspection.registered).toBe(true);
    expect(inspection.detached).toBe(true);
    expect(inspection.headSha).toBe(baseSha);
    expect(canonicalizeWorkspacePath(inspection.toplevel)).toBe(workspace.worktreePath);

    const opened = await manager.open(workspace);
    expect(opened.worktreePath).toBe(workspace.worktreePath);

    // Control checkout unchanged: still on operator with its tip file.
    expect((await fixture.git("branch", "--show-current")).trim()).toBe("operator");
    expect((await fixture.git("rev-parse", "HEAD")).trim()).toBe(
      (await fixture.git("rev-parse", "operator")).trim(),
    );
    expect(await fixture.read("operator-only.txt")).toBe("operator\n");

    // Worktree is at main tip — no operator-only file, no delivery branch.
    await expect(access(path.join(workspace.worktreePath!, "operator-only.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const branches = await fixture.git("branch", "--list", "harness/*");
    expect(branches.trim()).toBe("");
  });

  it("open fails with a recoverable workspace error when the worktree is missing", async () => {
    await assertGitWorktreeCapability();
    fixture = await createProjectFixture({
      config: { git: { enabled: true, baseBranch: "main" } },
    });
    await fixture.initGit({ branch: "main" });
    const paths = resolveHarnessPaths(fixture.config);
    const store = new RunStore(fixture.config, paths.stateRoot);
    await store.initialize();
    const manager = new WorktreeManager({
      controlRoot: paths.controlRoot,
      stateRoot: paths.stateRoot,
      store,
    });
    const workspace = await manager.create({
      runId: "missing-later",
      baseBranch: "main",
    });
    await fixture.removeWorktree(workspace.worktreePath!, { force: true });

    await expect(manager.open(workspace)).rejects.toThrow(/worktree|missing|moved|registered/i);
  });
});
