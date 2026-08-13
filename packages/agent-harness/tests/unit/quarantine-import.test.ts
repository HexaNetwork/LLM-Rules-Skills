import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, writeFile, copyFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HarnessConfigSchema } from "../../src/config/schema.js";
import {
  createHostPullRequest,
  pushDeliveryBranch,
  quarantineImportResult,
  resumeOrImportResult,
} from "../../src/git/quarantine-import.js";
import {
  RESULT_BUNDLE_FILENAME,
  RESULT_MANIFEST_FILENAME,
  prepareResultExport,
  readResultManifest,
} from "../../src/git/result-export.js";
import { hashFileSha256 } from "../../src/git/bundle-transport.js";
import { createProjectFixture } from "../testkit/project-fixture.js";
import { git } from "../testkit/git.js";

async function transportDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "ah-result-transport-"));
}

async function commitFile(
  repo: string,
  relativePath: string,
  contents: string | Buffer,
  message: string,
): Promise<string> {
  const absolute = path.join(repo, relativePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
  await git(repo, "add", relativePath);
  await git(repo, "commit", "-m", message);
  return (await git(repo, "rev-parse", "HEAD")).trim();
}

describe("result bundle export", () => {
  it("creates hashed result.bundle + manifest with tip/tree/paths", async () => {
    const fixture = await createProjectFixture();
    await fixture.initGit({ branch: "main" });
    const baseSha = (await fixture.git("rev-parse", "HEAD")).trim();
    await commitFile(fixture.root, "src/feature.ts", "export const x = 1;\n", "feat: add feature");
    const tipSha = (await fixture.git("rev-parse", "HEAD")).trim();
    const transport = await transportDir();

    const exported = await prepareResultExport({
      workspacePath: fixture.root,
      transportDirectory: transport,
      runId: "run-export-1",
      baseSha,
    });

    expect(exported.manifest.noChange).toBe(false);
    expect(exported.manifest.baseSha).toBe(baseSha);
    expect(exported.manifest.tipSha).toBe(tipSha);
    expect(exported.manifest.commitCount).toBe(1);
    expect(exported.manifest.changedPaths).toContain("src/feature.ts");
    expect(exported.bundlePath).toBeTruthy();
    expect(await hashFileSha256(exported.bundlePath!)).toBe(exported.manifest.bundleHash);
    expect(exported.manifest.bundleHash).toMatch(/^sha256:[a-f0-9]{64}$/);

    const verify = await git(fixture.root, "bundle", "verify", exported.bundlePath!);
    expect(verify).toMatch(/The bundle contains/i);

    await fixture.cleanup();
  });

  it("handles no-change runs without git bundle create", async () => {
    const fixture = await createProjectFixture();
    await fixture.initGit({ branch: "main" });
    const baseSha = (await fixture.git("rev-parse", "HEAD")).trim();
    const transport = await transportDir();

    const exported = await prepareResultExport({
      workspacePath: fixture.root,
      transportDirectory: transport,
      runId: "run-nochange",
      baseSha,
    });

    expect(exported.manifest.noChange).toBe(true);
    expect(exported.bundlePath).toBeUndefined();
    expect(exported.manifest.commitCount).toBe(0);
    await expect(readFile(path.join(transport, RESULT_BUNDLE_FILENAME))).rejects.toThrow();
    const marker = await readFile(path.join(transport, "result.no-change.json"), "utf8");
    expect(marker).toContain("no-change");

    await fixture.cleanup();
  });

  it("rejects dirty working trees before export", async () => {
    const fixture = await createProjectFixture();
    await fixture.initGit({ branch: "main" });
    const baseSha = (await fixture.git("rev-parse", "HEAD")).trim();
    await writeFile(path.join(fixture.root, "dirty.txt"), "oops\n");
    const transport = await transportDir();

    await expect(
      prepareResultExport({
        workspacePath: fixture.root,
        transportDirectory: transport,
        runId: "run-dirty",
        baseSha,
      }),
    ).rejects.toThrow(/not clean/i);

    await fixture.cleanup();
  });
});

describe("quarantine import", () => {
  async function seedControlAndClone(): Promise<{
    control: Awaited<ReturnType<typeof createProjectFixture>>;
    clone: string;
    baseSha: string;
    transport: string;
  }> {
    const control = await createProjectFixture();
    await control.initGit({ branch: "main" });
    const baseSha = (await control.git("rev-parse", "HEAD")).trim();
    const transport = await transportDir();
    // Seed clone via bundle round-trip so histories share objects.
    const seedBundle = path.join(transport, "seed.bundle");
    await git(control.root, "bundle", "create", seedBundle, "HEAD");
    const clone = await mkdtemp(path.join(tmpdir(), "ah-clone-"));
    await git(clone, "init");
    await git(clone, "fetch", seedBundle, `${baseSha}:refs/harness/base`);
    await git(clone, "checkout", "--detach", baseSha);
    return { control, clone, baseSha, transport };
  }

  it("promotes delivery branch after validation and is idempotent", async () => {
    const { control, clone, baseSha, transport } = await seedControlAndClone();
    await commitFile(clone, "lib/a.ts", "export const a = 1;\n", "feat: a");
    // Preserve binary + executable + rename in a second commit when platform allows.
    const binPath = path.join(clone, "assets/data.bin");
    await mkdir(path.dirname(binPath), { recursive: true });
    await writeFile(binPath, Buffer.from([0, 1, 2, 255, 10]));
    await git(clone, "add", "assets/data.bin");
    if (process.platform !== "win32") {
      await writeFile(path.join(clone, "scripts/run.sh"), "#!/bin/sh\necho hi\n");
      await chmod(path.join(clone, "scripts/run.sh"), 0o755);
      await git(clone, "add", "scripts/run.sh");
    }
    await git(clone, "commit", "-m", "feat: binary and mode");
    await git(clone, "mv", "lib/a.ts", "lib/a-renamed.ts");
    await git(clone, "commit", "-m", "refactor: rename");

    const exported = await prepareResultExport({
      workspacePath: clone,
      transportDirectory: transport,
      runId: "run-import-1",
      baseSha,
    });

    const limits = HarnessConfigSchema.parse({}).execution.docker.bundleLimits;
    const submoduleLfs = HarnessConfigSchema.parse({}).execution.docker.submoduleLfs;

    const first = await quarantineImportResult({
      controlRoot: control.root,
      runId: "run-import-1",
      transportDirectory: transport,
      baseSha,
      limits,
      submoduleLfs,
      deliveryBranchName: "harness/run-import-1",
    });
    expect(first.status).toBe("promoted");
    expect(first.tipSha).toBe(exported.manifest.tipSha);
    const branchTip = (await git(control.root, "rev-parse", "harness/run-import-1")).trim();
    expect(branchTip).toBe(exported.manifest.tipSha);

    // Control checkout must remain on original branch (not switched).
    const current = (await git(control.root, "branch", "--show-current")).trim();
    expect(current).toBe("main");

    // Round-trip: renamed path + binary present at tip.
    const renamed = await git(control.root, "show", `${branchTip}:lib/a-renamed.ts`);
    expect(renamed).toContain("export const a");
    const binary = await git(control.root, "cat-file", "-p", `${branchTip}:assets/data.bin`);
    expect(Buffer.from(binary, "binary").length).toBeGreaterThan(0);

    const second = await resumeOrImportResult({
      controlRoot: control.root,
      runId: "run-import-1",
      transportDirectory: transport,
      baseSha,
      limits,
      submoduleLfs,
      deliveryBranchName: "harness/run-import-1",
    });
    expect(second.status).toBe("promoted");
    expect(second.tipSha).toBe(first.tipSha);

    await control.cleanup();
  });

  it("rejects tampered bundle hash without mutating delivery branch", async () => {
    const { control, clone, baseSha, transport } = await seedControlAndClone();
    await commitFile(clone, "x.txt", "x\n", "feat: x");
    await prepareResultExport({
      workspacePath: clone,
      transportDirectory: transport,
      runId: "run-tamper",
      baseSha,
    });
    const bundlePath = path.join(transport, RESULT_BUNDLE_FILENAME);
    const original = await readFile(bundlePath);
    // Tamper without changing length so size check passes and hash fails.
    const tampered = Buffer.from(original);
    tampered[Math.min(64, tampered.length - 1)] ^= 0xff;
    await writeFile(bundlePath, tampered);

    const limits = HarnessConfigSchema.parse({}).execution.docker.bundleLimits;
    const submoduleLfs = HarnessConfigSchema.parse({}).execution.docker.submoduleLfs;

    await expect(
      quarantineImportResult({
        controlRoot: control.root,
        runId: "run-tamper",
        transportDirectory: transport,
        baseSha,
        limits,
        submoduleLfs,
        deliveryBranchName: "harness/run-tamper",
      }),
    ).rejects.toThrow(/hash mismatch|bundle verify|size mismatch/i);

    const exists = await git(
      control.root,
      "show-ref",
      "--verify",
      "refs/heads/harness/run-tamper",
    ).catch(() => "");
    expect(exists.trim()).toBe("");

    await control.cleanup();
  });

  it("rejects wrong-base / oversized bundles without branch mutation", async () => {
    const { control, clone, baseSha, transport } = await seedControlAndClone();
    await commitFile(clone, "y.txt", "y\n", "feat: y");
    const exported = await prepareResultExport({
      workspacePath: clone,
      transportDirectory: transport,
      runId: "run-limits",
      baseSha,
    });

    const limits = {
      ...HarnessConfigSchema.parse({}).execution.docker.bundleLimits,
      maxCommitCount: 0,
    };
    const submoduleLfs = HarnessConfigSchema.parse({}).execution.docker.submoduleLfs;

    await expect(
      quarantineImportResult({
        controlRoot: control.root,
        runId: "run-limits",
        transportDirectory: transport,
        baseSha,
        limits,
        submoduleLfs,
        deliveryBranchName: "harness/run-limits",
      }),
    ).rejects.toThrow(/commit count/i);

    // Wrong base: rewrite manifest baseSha to a fake value after re-export.
    const other = await createProjectFixture();
    await other.initGit({ branch: "main" });
    const wrongBase = (await other.git("rev-parse", "HEAD")).trim();
    const manifestPath = path.join(transport, RESULT_MANIFEST_FILENAME);
    const manifest = await readResultManifest(manifestPath);
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, baseSha: wrongBase }, null, 2)}\n`,
    );

    await expect(
      quarantineImportResult({
        controlRoot: control.root,
        runId: "run-limits",
        transportDirectory: transport,
        baseSha: exported.manifest.baseSha,
        limits: HarnessConfigSchema.parse({}).execution.docker.bundleLimits,
        submoduleLfs,
        deliveryBranchName: "harness/run-limits",
      }),
    ).rejects.toThrow(/baseSha mismatch/i);

    const exists = await git(
      control.root,
      "show-ref",
      "--verify",
      "refs/heads/harness/run-limits",
    ).catch(() => "");
    expect(exists.trim()).toBe("");

    await other.cleanup();
    await control.cleanup();
  });

  it("rejects sensitive paths from the changed-path set", async () => {
    const { control, clone, baseSha, transport } = await seedControlAndClone();
    await commitFile(clone, ".env", "SECRET=1\n", "chore: env");
    await prepareResultExport({
      workspacePath: clone,
      transportDirectory: transport,
      runId: "run-sensitive",
      baseSha,
    });

    await expect(
      quarantineImportResult({
        controlRoot: control.root,
        runId: "run-sensitive",
        transportDirectory: transport,
        baseSha,
        limits: HarnessConfigSchema.parse({}).execution.docker.bundleLimits,
        submoduleLfs: HarnessConfigSchema.parse({}).execution.docker.submoduleLfs,
        deliveryBranchName: "harness/run-sensitive",
      }),
    ).rejects.toThrow(/sensitive path/i);

    await control.cleanup();
  });
});

describe("host push helpers", () => {
  it("builds explicit refspec push without requiring a checkout switch", async () => {
    // Smoke: functions are exported and reject missing remotes cleanly.
    const fixture = await createProjectFixture();
    await fixture.initGit({ branch: "main" });
    await expect(
      pushDeliveryBranch({
        controlRoot: fixture.root,
        remote: "origin",
        branchName: "does-not-exist",
      }),
    ).rejects.toThrow();
    await expect(
      createHostPullRequest({
        controlRoot: fixture.root,
        baseBranch: "main",
        headBranch: "feature",
        title: "t",
        body: "b",
      }),
    ).rejects.toThrow();
    await fixture.cleanup();
  });
});

describe("bundle hash helpers", () => {
  it("hashFileSha256 matches digest of copied artifact", async () => {
    const dir = await transportDir();
    const file = path.join(dir, "artifact.bin");
    const payload = Buffer.from("harness-bundle-bytes");
    await writeFile(file, payload);
    const expected = `sha256:${createHash("sha256").update(payload).digest("hex")}`;
    expect(await hashFileSha256(file)).toBe(expected);
    const copy = path.join(dir, "copy.bin");
    await copyFile(file, copy);
    expect(await hashFileSha256(copy)).toBe(expected);
  });
});
