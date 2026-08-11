import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { GitService } from "../../src/git.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

const exec = promisify(execFile);

async function git(root: string, ...args: string[]): Promise<string> {
  const result = await exec("git", args, { cwd: root });
  return String(result.stdout);
}

async function initGitRepo(root: string): Promise<void> {
  await git(root, "init");
  await git(root, "config", "user.email", "harness@example.com");
  await git(root, "config", "user.name", "Harness Test");
  await writeFile(path.join(root, ".gitignore"), ".agent-harness/\n", "utf8");
  await git(root, "add", "--all");
  await git(root, "commit", "-m", "initial");
  await git(root, "branch", "-M", "main");
}

describe("RED checkpoint commits", () => {
  it("commits only test paths with checkpoint trailers and recovers by task id", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);
    const service = new GitService(fixtureConfig(root, { git: { enabled: true } as never }));
    await mkdir(path.join(root, "tests"), { recursive: true });
    await writeFile(path.join(root, "tests", "greet.test.ts"), "expect(false).toBe(true);\n", "utf8");
    await writeFile(path.join(root, "src-note.txt"), "not a test\n", "utf8");

    const first = await service.commitRedCheckpoint({
      taskId: "greet",
      taskTitle: "Add greeting",
      paths: ["tests/greet.test.ts"],
      round: 1,
    });
    expect(first?.sha).toMatch(/^[a-f0-9]{40}$/);
    expect(first?.paths).toEqual(["tests/greet.test.ts"]);
    const log = await git(root, "log", "-1", "--format=%B");
    expect(log).toContain("test: establish RED for Add greeting");
    expect(log).toContain("Harness-Checkpoint: red");
    expect(log).toContain("Harness-Checkpoint-Task: greet");
    expect(log).toContain("Harness-Checkpoint-Round: 1");
    expect(log).not.toContain("Harness-Task:");
    expect(await git(root, "show", "--name-only", "--format=", "HEAD")).toContain(
      "tests/greet.test.ts",
    );
    expect(await git(root, "show", "--name-only", "--format=", "HEAD")).not.toContain(
      "src-note.txt",
    );

    const recovered = await service.findRedCheckpoint("greet");
    expect(recovered?.sha).toBe(first?.sha);
    expect(recovered?.baseSha).toBe(first?.baseSha);

    // Idempotent when HEAD is already the checkpoint.
    const again = await service.commitRedCheckpoint({
      taskId: "greet",
      taskTitle: "Add greeting",
      paths: ["tests/greet.test.ts"],
    });
    expect(again?.sha).toBe(first?.sha);
  });

  it("advances when new dirty test paths appear at HEAD checkpoint", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);
    const service = new GitService(fixtureConfig(root, { git: { enabled: true } as never }));
    await mkdir(path.join(root, "tests"), { recursive: true });
    await writeFile(path.join(root, "tests", "greet.test.ts"), "expect(false).toBe(true);\n", "utf8");

    const first = await service.commitRedCheckpoint({
      taskId: "greet",
      taskTitle: "Add greeting",
      paths: ["tests/greet.test.ts"],
      round: 1,
    });
    expect(first?.paths).toEqual(["tests/greet.test.ts"]);

    await writeFile(path.join(root, "tests", "greet2.test.ts"), "expect(1).toBe(2);\n", "utf8");
    const second = await service.commitRedCheckpoint({
      taskId: "greet",
      taskTitle: "Add greeting",
      paths: ["tests/greet.test.ts", "tests/greet2.test.ts"],
      round: 2,
    });
    expect(second?.sha).not.toBe(first?.sha);
    expect(second?.paths).toEqual(["tests/greet2.test.ts"]);
    expect(await git(root, "log", "-1", "--format=%B")).toContain("Harness-Checkpoint-Round: 2");
  });

  it("restores recorded tests from the checkpoint without dropping production edits", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);
    const service = new GitService(fixtureConfig(root, { git: { enabled: true } as never }));
    await mkdir(path.join(root, "tests"), { recursive: true });
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "tests", "greet.test.ts"), "RED\n", "utf8");
    const checkpoint = await service.commitRedCheckpoint({
      taskId: "greet",
      taskTitle: "Add greeting",
      paths: ["tests/greet.test.ts"],
    });
    expect(checkpoint).toBeTruthy();

    await writeFile(path.join(root, "tests", "greet.test.ts"), "TAMPERED\n", "utf8");
    await writeFile(path.join(root, "src", "greet.ts"), "export const greet = () => 'hi';\n", "utf8");
    expect(await service.pathsChangedVersusSha(checkpoint!.sha, ["tests/greet.test.ts"])).toEqual([
      "tests/greet.test.ts",
    ]);

    await service.restorePathsFromSha(checkpoint!.sha, ["tests/greet.test.ts"]);
    const restored = await exec("git", ["show", `:${"tests/greet.test.ts"}`], { cwd: root }).catch(
      () => null,
    );
    void restored;
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(path.join(root, "tests", "greet.test.ts"), "utf8")).toMatch(/^RED\r?\n$/);
    expect(await readFile(path.join(root, "src", "greet.ts"), "utf8")).toContain("export const greet");
  });

  it("squashes checkpoint provenance into the final task commit trailer", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);
    const service = new GitService(fixtureConfig(root, { git: { enabled: true } as never }));
    await service.ensureRunBranch("squash-demo");
    await mkdir(path.join(root, "tests"), { recursive: true });
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "tests", "greet.test.ts"), "RED\n", "utf8");
    const checkpoint = await service.commitRedCheckpoint({
      taskId: "greet",
      taskTitle: "Add greeting",
      paths: ["tests/greet.test.ts"],
      round: 1,
    });
    await writeFile(path.join(root, "src", "greet.ts"), "export const greet = () => 'hi';\n", "utf8");

    const sha = await service.squashCheckpointsIntoTaskCommit({
      taskId: "greet",
      message: { subject: "feat: greeting", body: "Done." },
      reportedPaths: ["tests/greet.test.ts", "src/greet.ts"],
      redCheckpointShas: [checkpoint!.sha],
      expectedBranch: "harness/squash-demo",
    });
    expect(sha).toMatch(/^[a-f0-9]{40}$/);
    const log = await git(root, "log", "-1", "--format=%B");
    expect(log).toContain("Harness-Task: greet");
    expect(log).toContain(`Harness-Red-Checkpoints: ${checkpoint!.sha}`);
    const count = (await git(root, "rev-list", "--count", "main..HEAD")).trim();
    expect(Number(count)).toBe(1);
  });

  it("records round trailers, preserves oldest redBaseSha, keeps dirty production, and squashes three rounds", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);
    const service = new GitService(fixtureConfig(root, { git: { enabled: true } as never }));
    await service.ensureRunBranch("three-round");
    await mkdir(path.join(root, "tests"), { recursive: true });
    await mkdir(path.join(root, "src"), { recursive: true });

    await writeFile(path.join(root, "tests", "round-1.test.ts"), "ROUND1\n", "utf8");
    const first = await service.commitRedCheckpoint({
      taskId: "multi",
      taskTitle: "Multi round",
      paths: ["tests/round-1.test.ts"],
      round: 1,
    });
    expect(first?.baseSha).toMatch(/^[a-f0-9]{40}$/);
    expect(await git(root, "log", "-1", "--format=%B")).toContain("Harness-Checkpoint-Round: 1");

    await writeFile(path.join(root, "src", "round-1.ts"), "export const n = 1;\n", "utf8");
    expect(await service.changedFiles()).toContain("src/round-1.ts");

    await writeFile(path.join(root, "tests", "round-2.test.ts"), "ROUND2\n", "utf8");
    const second = await service.commitRedCheckpoint({
      taskId: "multi",
      taskTitle: "Multi round",
      paths: ["tests/round-2.test.ts"],
      round: 2,
    });
    expect(second?.sha).not.toBe(first?.sha);
    expect(await git(root, "log", "-1", "--format=%B")).toContain("Harness-Checkpoint-Round: 2");
    // Production from round 1 stays dirty across a later test-only checkpoint.
    expect(await service.changedFiles()).toContain("src/round-1.ts");
    expect(await git(root, "show", "--name-only", "--format=", "HEAD")).not.toContain("src/round-1.ts");

    await writeFile(path.join(root, "src", "round-2.ts"), "export const n = 2;\n", "utf8");
    await writeFile(path.join(root, "tests", "round-3.test.ts"), "ROUND3\n", "utf8");
    const third = await service.commitRedCheckpoint({
      taskId: "multi",
      taskTitle: "Multi round",
      paths: ["tests/round-3.test.ts"],
      round: 3,
    });
    expect(await git(root, "log", "-1", "--format=%B")).toContain("Harness-Checkpoint-Round: 3");
    expect(await service.changedFiles()).toEqual(
      expect.arrayContaining(["src/round-1.ts", "src/round-2.ts"]),
    );

    const recovered = await service.findRedCheckpoint("multi");
    expect(recovered?.sha).toBe(third?.sha);
    expect(recovered?.baseSha).toBe(first?.baseSha);
    expect(recovered?.round).toBe(3);
    expect(recovered?.paths).toEqual(["tests/round-3.test.ts"]);

    await writeFile(path.join(root, "src", "round-3.ts"), "export const n = 3;\n", "utf8");
    const reportedPaths = [
      "tests/round-1.test.ts",
      "tests/round-2.test.ts",
      "tests/round-3.test.ts",
      "src/round-1.ts",
      "src/round-2.ts",
      "src/round-3.ts",
    ];
    const sha = await service.squashCheckpointsIntoTaskCommit({
      taskId: "multi",
      message: { subject: "feat: multi round", body: "All rounds." },
      reportedPaths,
      redCheckpointShas: [first!.sha, second!.sha, third!.sha],
      expectedBranch: "harness/three-round",
    });
    expect(sha).toMatch(/^[a-f0-9]{40}$/);
    const log = await git(root, "log", "-1", "--format=%B");
    expect(log).toContain("Harness-Task: multi");
    expect(log).toContain(
      `Harness-Red-Checkpoints: ${[first!.sha, second!.sha, third!.sha].join(",")}`,
    );
    const count = (await git(root, "rev-list", "--count", "main..HEAD")).trim();
    expect(Number(count)).toBe(1);
    const names = await git(root, "show", "--pretty=", "--name-only", "HEAD");
    for (const file of reportedPaths) {
      expect(names).toContain(file);
    }
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(path.join(root, "tests", "round-1.test.ts"), "utf8")).toMatch(/^ROUND1\r?\n$/);
    expect(await readFile(path.join(root, "src", "round-3.ts"), "utf8")).toContain("export const n = 3");
  });
});
