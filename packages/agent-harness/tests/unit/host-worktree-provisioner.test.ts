import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitService } from "../../src/git.js";
import { HostWorktreeProvisioner } from "../../src/workspace/host-worktree-provisioner.js";
import { createProjectFixture } from "../testkit/project-fixture.js";
import { git } from "../testkit/git.js";

describe("HostWorktreeProvisioner", () => {
  it("creates a host worktree that survives as the commit surface", async () => {
    const fixture = await createProjectFixture({
      config: { git: { enabled: true } },
    });
    await fixture.initGit({ branch: "main" });
    const baseSha = (await fixture.git("rev-parse", "HEAD")).trim();
    const stateRoot = await mkdtemp(path.join(tmpdir(), "ah-wt-state-"));
    const store = {
      withWorkspaceAdminLock: async <T>(_h: unknown, work: () => Promise<T>) => work(),
    };
    const provisioner = new HostWorktreeProvisioner({
      paths: {
        controlRoot: fixture.root,
        stateRoot,
        workspaceRoot: fixture.root,
      },
      store: store as never,
    });

    const workspace = await provisioner.create({
      runId: "run-wt-1",
      baseBranch: "main",
    });
    expect(workspace.kind).toBe("host-worktree");
    if (workspace.kind !== "host-worktree") throw new Error("expected host-worktree");
    expect(workspace.baseSha).toBe(baseSha);
    expect((await git(workspace.worktreePath, "rev-parse", "HEAD")).trim()).toBe(baseSha);

    const opened = await provisioner.open(workspace);
    expect(opened.kind).toBe("host-worktree");

    await writeFile(path.join(workspace.worktreePath, "hello.txt"), "from-host\n");
    const hostGit = new GitService(fixture.config, {
      controlRoot: fixture.root,
      stateRoot,
      workspaceRoot: workspace.worktreePath,
    });
    const commitSha = await hostGit.commitTask(
      "task-host-1",
      { subject: "feat: host-owned commit", body: "Accepted on the host" },
      ["hello.txt"],
    );
    expect(commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await fixture.git("status", "--porcelain=v1")).toBe("");
    await fixture.cleanup();
  });
});
