import { afterEach, describe, expect, it } from "vitest";
import { resolveHarnessPaths } from "../../src/application/paths.js";
import { GitService } from "../../src/git.js";
import {
  createProjectFixture,
  type ProjectFixture,
} from "../testkit/project-fixture.js";

describe("GitService.workspaceEvidence", () => {
  let fixture: ProjectFixture | undefined;

  afterEach(async () => {
    if (fixture) {
      await fixture.cleanup();
      fixture = undefined;
    }
  });

  it("computes structured evidence with a versioned fingerprint", async () => {
    fixture = await createProjectFixture({
      config: { git: { enabled: true, baseBranch: "main" } },
    });
    await fixture.initGit({ branch: "main" });
    const git = new GitService(fixture.config, resolveHarnessPaths(fixture.config));
    const head = (await fixture.git("rev-parse", "HEAD")).trim();

    const evidence = await git.workspaceEvidence();
    expect(evidence.headSha).toBe(head);
    expect(evidence.indexTreeSha).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.statusDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.changedPaths).toEqual([]);
    expect(evidence.fingerprint.startsWith("v1:")).toBe(true);
    expect(await git.treeFingerprint()).toBe(evidence.fingerprint);
  });

  it("detects working-file, index, and HEAD mutations as distinct evidence changes", async () => {
    fixture = await createProjectFixture({
      config: { git: { enabled: true, baseBranch: "main" } },
    });
    await fixture.initGit({ branch: "main" });
    const git = new GitService(fixture.config, resolveHarnessPaths(fixture.config));
    const baseline = await git.workspaceEvidence();

    await fixture.write("external.txt", "dirty\n");
    const afterEdit = await git.workspaceEvidence();
    expect(afterEdit.headSha).toBe(baseline.headSha);
    expect(afterEdit.indexTreeSha).toBe(baseline.indexTreeSha);
    expect(afterEdit.statusDigest).not.toBe(baseline.statusDigest);
    expect(afterEdit.changedPaths).toContain("external.txt");

    await fixture.git("add", "--", "external.txt");
    const afterStage = await git.workspaceEvidence();
    expect(afterStage.headSha).toBe(baseline.headSha);
    expect(afterStage.indexTreeSha).not.toBe(baseline.indexTreeSha);
    expect(afterStage.statusDigest).not.toBe(baseline.statusDigest);

    await fixture.git("commit", "-m", "external");
    const afterCommit = await git.workspaceEvidence();
    expect(afterCommit.headSha).not.toBe(baseline.headSha);
    expect(afterCommit.changedPaths).toEqual([]);
  });
});
