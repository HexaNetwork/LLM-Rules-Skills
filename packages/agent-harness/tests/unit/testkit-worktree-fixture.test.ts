import path from "node:path";
import { access } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { assertGitWorktreeCapability } from "../../src/git/capabilities.js";
import { sanitizeWorktreeRunId } from "../../src/domain/workspace.js";
import {
  createProjectFixture,
  type LinkedWorktreeInfo,
  type ProjectFixture,
} from "../testkit/project-fixture.js";

describe("ProjectFixture linked worktrees", () => {
  let fixture: ProjectFixture | undefined;
  const worktrees: LinkedWorktreeInfo[] = [];

  afterEach(async () => {
    for (const wt of worktrees.splice(0).reverse()) {
      try {
        await fixture?.removeWorktree(wt.path, { force: true });
      } catch {
        // best-effort before root cleanup
      }
    }
    if (fixture) {
      await fixture.cleanup();
      fixture = undefined;
    }
  });

  it("creates, inspects, reopens, and safely removes a detached worktree", async () => {
    await assertGitWorktreeCapability();
    fixture = await createProjectFixture();
    await fixture.initGit({ branch: "main" });
    const baseSha = (await fixture.git("rev-parse", "HEAD")).trim();
    const controlBranch = (await fixture.git("branch", "--show-current")).trim();

    const created = await fixture.addDetachedWorktree("Feature/Run 1", { baseSha });
    worktrees.push(created);

    expect(created.runId).toBe(sanitizeWorktreeRunId("Feature/Run 1"));
    expect(created.headSha).toBe(baseSha);
    expect(created.detached).toBe(true);
    expect(path.resolve(created.path).startsWith(path.resolve(fixture.root))).toBe(true);
    expect(await created.read("README.md")).toContain("Fixture");

    // Control checkout must remain on its original branch.
    expect((await fixture.git("branch", "--show-current")).trim()).toBe(controlBranch);

    const inspected = await fixture.inspectWorktree(created.path);
    expect(inspected.registered).toBe(true);
    expect(inspected.headSha).toBe(baseSha);
    expect(inspected.gitCommonDir).toBe(created.gitCommonDir);

    const reopened = await fixture.reopenWorktree(created.path);
    expect(reopened.path).toBe(created.path);
    expect(reopened.headSha).toBe(baseSha);
    expect((await reopened.git("rev-parse", "--is-inside-work-tree")).trim()).toBe("true");

    await fixture.removeWorktree(created.path);
    worktrees.pop();
    await expect(access(created.path)).rejects.toMatchObject({ code: "ENOENT" });
    const listed = await fixture.listWorktrees();
    expect(listed.some((entry) => path.resolve(entry.path) === path.resolve(created.path))).toBe(
      false,
    );
  });

  it("refuses to remove a path that is not a registered fixture worktree", async () => {
    await assertGitWorktreeCapability();
    fixture = await createProjectFixture();
    await fixture.initGit({ branch: "main" });

    await expect(fixture.removeWorktree(fixture.root)).rejects.toThrow(/registered worktree|refusing/i);
    await expect(
      fixture.removeWorktree(path.join(fixture.root, ".agent-harness", "worktrees", "missing")),
    ).rejects.toThrow(/registered worktree|not found|refusing/i);
  });

  it("keeps reserved-name run ids filesystem-safe under the worktree parent", async () => {
    await assertGitWorktreeCapability();
    fixture = await createProjectFixture();
    await fixture.initGit({ branch: "main" });

    const created = await fixture.addDetachedWorktree("CON");
    worktrees.push(created);
    expect(path.basename(created.path)).toBe(sanitizeWorktreeRunId("CON"));
    expect(path.basename(created.path)).not.toBe("CON");
    expect(path.basename(created.path)).not.toBe("con");
  });
});

describe("assertGitWorktreeCapability", () => {
  it("succeeds on a modern Git that supports worktrees", async () => {
    const caps = await assertGitWorktreeCapability();
    expect(caps.worktreesSupported).toBe(true);
    expect(caps.major).toBeGreaterThanOrEqual(2);
    expect(caps.version).toMatch(/^\d+\.\d+/);
  });
});
