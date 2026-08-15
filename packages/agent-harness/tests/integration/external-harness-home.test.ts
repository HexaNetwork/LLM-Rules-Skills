import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeBackend } from "../../src/infrastructure/agents/fake-backend.js";
import {
  loadExternalProjectConfig,
  seedExternalGuidance} from "../../src/application/external-config.js";
import { resolveHarnessHome } from "../../src/application/harness-home.js";
import { ProjectRegistry } from "../../src/application/project-registry.js";
import { harnessPathsFromProject } from "../../src/application/paths.js";
import { HarnessConfigSchema } from "../../src/config/schema.js";
import { defaultConfigYaml } from "../../src/config/defaults.js";
import { WorkerHarnessRuntime } from "../../src/application/harness-engine.js";
import { git } from "../testkit/git.js";
import { passingCommandRunner } from "../helpers.js";

const tempRoots: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function initRepo(root: string): Promise<void> {
  await git(root, "init");
  await git(root, "checkout", "-b", "main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  await writeFile(path.join(root, "README.md"), "# demo\n", "utf8");
  await git(root, "add", "README.md");
  await git(root, "commit", "-m", "init");
}

const REFLECT_OUTPUT = {
  proposedTitle: "Ship a feature",
  summary: "Restated feature",
  restatement: "Ship the requested feature.",
  goal: "Deliver the feature",
  users: ["operators"],
  inScope: ["core change"],
  outOfScope: ["extras"],
  assumptions: ["base branch is correct"],
  unknowns: ["edge cases"]};

describe("external harness home", () => {
  it("adds newly packaged guidance to an existing home without overwriting operator files", async () => {
    const homeRoot = await tempDir("ah-guidance-upgrade-home-");
    const home = resolveHarnessHome({ homeRoot });
    const existingSkill = path.join(
      home.sharedGuidanceRoot,
      "General",
      "skills",
      "tdd",
      "SKILL.md",
    );
    await mkdir(path.dirname(existingSkill), { recursive: true });
    await writeFile(existingSkill, "operator-customized guidance\n", "utf8");

    const result = await seedExternalGuidance(home);

    expect(result.copied).toBe(true);
    expect(await readFile(existingSkill, "utf8")).toBe("operator-customized guidance\n");
    await expect(
      access(
        path.join(
          home.sharedGuidanceRoot,
          "General",
          "skills",
          "harness-run",
          "SKILL.md",
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it("deep-merges sparse home and project policy without masking home defaults", async () => {
    const homeRoot = await tempDir("ah-layer-home-");
    const repo = await tempDir("ah-layer-repo-");
    await initRepo(repo);
    const home = resolveHarnessHome({ homeRoot });
    await mkdir(home.homeRoot, { recursive: true });
    await writeFile(
      path.join(home.homeRoot, "config.yaml"),
      [
        "version: 2",
        "workflow:",
        "  maxGrillQuestionsPerEpisode: 9",
        "commands:",
        "  verification:",
        "    - id: home-test",
        "      command: home verify",
        "      timeoutMs: 1234",
        ""].join("\n"),
      "utf8",
    );
    const lookup = await new ProjectRegistry(home).add({ repository: repo, home });
    await writeFile(
      lookup.paths.projectConfigPath,
      "version: 2\nworkflow:\n  staleAnswerMinutes: 77\n",
      "utf8",
    );

    const loaded = await loadExternalProjectConfig({
      projectKey: lookup.registration.projectKey,
      home});

    expect(loaded.config.workflow.maxGrillQuestionsPerEpisode).toBe(9);
    expect(loaded.config.workflow.staleAnswerMinutes).toBe(77);
    expect(loaded.config.commands.verification).toEqual([
      { id: "home-test", command: "home verify", timeoutMs: 1234 }]);
  });

});
