import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveHarnessHome } from "../../src/application/harness-home.js";
import { ProjectRegistry } from "../../src/application/project-registry.js";
import { git } from "../testkit/git.js";

const tempRoots: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

async function initRepo(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await git(root, "init");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  await writeFile(path.join(root, "README.md"), "# demo\n", "utf8");
  await git(root, "add", "README.md");
  await git(root, "commit", "-m", "init");
}

describe("ProjectRegistry", () => {
  it("registers, lists, and rediscovers by repository path and cwd", async () => {
    const homeRoot = await tempDir("ah-home-");
    const repo = await tempDir("ah-repo-");
    await initRepo(repo);
    const home = resolveHarnessHome({ homeRoot });
    const registry = new ProjectRegistry(home);

    const added = await registry.add({ repository: repo, name: "Demo", home });
    expect(added.registration.displayName).toBe("Demo");
    expect(added.paths.controlRoot).toBe(path.resolve(repo));

    const listed = await registry.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.projectKey).toBe(added.registration.projectKey);

    const byKey = await registry.discover({ projectKey: added.registration.projectKey });
    expect(byKey.registration.projectKey).toBe(added.registration.projectKey);

    const byRepo = await registry.discover({ repository: repo });
    expect(byRepo.registration.projectKey).toBe(added.registration.projectKey);

    const byCwd = await registry.discover({ cwd: path.join(repo, ".") });
    expect(byCwd.registration.projectKey).toBe(added.registration.projectKey);
  });

  it("refuses duplicate roots and gives an actionable error for unregistered repos", async () => {
    const homeRoot = await tempDir("ah-home-");
    const repo = await tempDir("ah-repo-");
    await initRepo(repo);
    const home = resolveHarnessHome({ homeRoot });
    const registry = new ProjectRegistry(home);
    await registry.add({ repository: repo, home });

    await expect(registry.add({ repository: repo, home })).rejects.toThrow(/already registered/);

    const other = await tempDir("ah-other-");
    await initRepo(other);
    await expect(registry.discover({ repository: other })).rejects.toThrow(
      /agent-harness project add --repository/,
    );
  });

  it("relinks a moved repository path", async () => {
    const homeRoot = await tempDir("ah-home-");
    const original = await tempDir("ah-repo-a-");
    await initRepo(original);
    const home = resolveHarnessHome({ homeRoot });
    const registry = new ProjectRegistry(home);
    const added = await registry.add({ repository: original, home });

    const moved = await tempDir("ah-repo-b-");
    // Simulate move by re-init with same remote fingerprint optional; for path-only relink
    // copy git dir via re-init is enough when identity checks allow missing remote.
    await initRepo(moved);

    const relinked = await registry.relink({
      projectKey: added.registration.projectKey,
      repository: moved,
      home});
    expect(path.resolve(relinked.registration.controlRoot)).toBe(path.resolve(moved));

    const discovered = await registry.discover({ repository: moved });
    expect(discovered.registration.projectKey).toBe(added.registration.projectKey);
  });

  it("allows two registered repositories with the same directory basename", async () => {
    const homeRoot = await tempDir("ah-home-");
    const parentA = await tempDir("ah-parent-a-");
    const parentB = await tempDir("ah-parent-b-");
    const repoA = path.join(parentA, "same-name");
    const repoB = path.join(parentB, "same-name");
    await initRepo(repoA);
    await initRepo(repoB);
    const home = resolveHarnessHome({ homeRoot });
    const registry = new ProjectRegistry(home);

    const a = await registry.add({ repository: repoA, home });
    const b = await registry.add({ repository: repoB, home });
    expect(a.registration.projectKey).not.toBe(b.registration.projectKey);
    expect(path.basename(a.paths.controlRoot)).toBe("same-name");
    expect(path.basename(b.paths.controlRoot)).toBe("same-name");
  });
});
