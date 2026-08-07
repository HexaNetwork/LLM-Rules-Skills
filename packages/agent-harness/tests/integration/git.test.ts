import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { GitService } from "../../src/git.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

const exec = promisify(execFile);

describe("harness-owned git", () => {
  it("creates the run branch, commits only reported paths, and writes the task trailer", async () => {
    const root = await fixtureRoot();
    await git(root, "init");
    await git(root, "config", "user.email", "harness@example.com");
    await git(root, "config", "user.name", "Harness Test");
    await writeFile(path.join(root, ".gitignore"), ".agent-harness/\n", "utf8");
    await git(root, "add", "--all");
    await git(root, "commit", "-m", "initial");
    await git(root, "branch", "-M", "main");

    const config = fixtureConfig(root, { git: { enabled: true } as never });
    const service = new GitService(config);
    expect(await service.ensureRunBranch("feature-one")).toBe("harness/feature-one");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "feature.ts"), "export const feature = true;\n", "utf8");

    const sha = await service.commitTask(
      "feature",
      { subject: "feat: add feature", body: "Adds verified behavior." },
      ["src/feature.ts"],
    );
    expect(sha).toMatch(/^[a-f0-9]{40}$/);
    const log = await git(root, "log", "-1", "--format=%B");
    expect(log).toContain("feat: add feature");
    expect(log).toContain("Harness-Task: feature");

    await writeFile(path.join(root, "surprise.txt"), "not reported\n", "utf8");
    await expect(
      service.commitTask(
        "second",
        { subject: "feat: second", body: "" },
        ["src/allowed.ts"],
      ),
    ).rejects.toThrow("unreported paths");
  });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await exec("git", args, { cwd, windowsHide: true });
  return result.stdout;
}
