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
import { HarnessEngine } from "../../src/application/harness-engine.js";
import { assertGitWorktreeCapability } from "../../src/git/capabilities.js";
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

  it("starts a run with no harness-owned files under the control root", async () => {
    await assertGitWorktreeCapability();
    const homeRoot = await tempDir("ah-ext-home-");
    const repo = await tempDir("ah-ext-repo-");
    await initRepo(repo);
    const home = resolveHarnessHome({ homeRoot });
    const registry = new ProjectRegistry(home);
    const lookup = await registry.add({ repository: repo, home });
    const loaded = await loadExternalProjectConfig({
      projectKey: lookup.registration.projectKey,
      home});
    const config = HarnessConfigSchema.parse({
      ...loaded.config,
      git: {
        ...loaded.config.git,
        enabled: true,
        baseBranch: "main",
        createPullRequest: false},
      knowledge: {
        ...loaded.config.knowledge,
        repositoryIntelligence: { enabled: false },
        sources: [{ path: "README.md", scope: "project", visibility: "private" }],
        guidance: { enabled: false, maxResults: 0, maxCharacters: 1 }},
      workflow: { ...loaded.config.workflow }});

    const paths = harnessPathsFromProject(lookup.paths);
    const engine = new HarnessEngine(config, {
      backend: createFakeBackend({
        reflector: () => REFLECT_OUTPUT}),
      commands: passingCommandRunner(),
      projectContext: { home, paths: lookup.paths },
      paths});

    const before = await readdir(repo);
    const state = await engine.start("ship a tiny feature", "run-ext-1", false, false);
    expect(state.runId).toBe("run-ext-1");
    expect(state.phase === "blocked" ? state.failure : undefined).toBeUndefined();

    const after = await readdir(repo);
    expect(after.filter((name) => name !== ".git").sort()).toEqual(
      before.filter((name) => name !== ".git").sort(),
    );
    await expect(access(path.join(repo, ".agent-harness"))).rejects.toBeTruthy();
    await expect(access(path.join(repo, "agent-harness.config.yaml"))).rejects.toBeTruthy();

    const workspace = JSON.parse(
      await readFile(path.join(lookup.paths.runsRoot, "run-ext-1", "workspace.json"), "utf8"),
    ) as { worktreePath?: string; kind?: string };
    expect(workspace.kind).toBe("git-worktree");
    expect(workspace.worktreePath).toBeTruthy();
    expect(path.resolve(workspace.worktreePath!)).toContain(`${path.basename(repo)}-worktrees`);
  });
});
