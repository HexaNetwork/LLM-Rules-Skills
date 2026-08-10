import { access, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeBackend } from "../../src/agent.js";
import { loadExternalProjectConfig } from "../../src/application/external-config.js";
import { resolveHarnessHome } from "../../src/application/harness-home.js";
import { harnessPathsFromProject } from "../../src/application/paths.js";
import { ProjectRegistry } from "../../src/application/project-registry.js";
import { reportProjectStorage } from "../../src/application/storage-report.js";
import { HarnessConfigSchema } from "../../src/config.js";
import { HarnessEngine } from "../../src/engine.js";
import { assertGitWorktreeCapability } from "../../src/git/capabilities.js";
import { git } from "../testkit/git.js";
import { passingCommandRunner } from "../helpers.js";
import { runCli } from "./helpers.js";

const tempRoots: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      const { rm } = await import("node:fs/promises");
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
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

async function writingImplementer(request: { cwd: string }) {
  await mkdir(path.join(request.cwd, "src"), { recursive: true });
  await writeFile(path.join(request.cwd, "src", "feature.ts"), "export const ok = true;\n", "utf8");
  return { summary: "built", changedFiles: ["src/feature.ts"] };
}

const REFLECT = {
  proposedTitle: "Ship a feature",
  summary: "Restated feature",
  restatement: "Ship the requested feature.",
  goal: "Deliver the feature",
  users: ["operators"],
  inScope: ["core change"],
  outOfScope: ["extras"],
  assumptions: ["base branch is correct"],
  unknowns: [] as string[],
};

describe("external harness home E2E matrix", () => {
  it("register → configure → start → advance → publish → cleanup → remove", async () => {
    await assertGitWorktreeCapability();

    const homeRoot = await tempDir("ah-e2e-home-");
    const repo = await tempDir("ah-e2e-repo-");
    await initRepo(repo);
    const beforeNames = (await readdir(repo)).filter((name) => name !== ".git").sort();

    // Unregistered repository should fail with an actionable command.
    const unregistered = await runCli([
      "start",
      "--idea",
      "should fail",
      "--repository",
      repo,
      "--home",
      homeRoot,
      "--no-advance",
    ]);
    expect(unregistered.code).not.toBe(0);
    const unregisteredText = [
      ...unregistered.stderr,
      ...unregistered.stdout,
      unregistered.error instanceof Error ? unregistered.error.message : String(unregistered.error ?? ""),
    ].join("\n");
    expect(unregisteredText).toMatch(/agent-harness project add --repository/);

    // Register via CLI (zero-footprint).
    const added = await runCli([
      "project",
      "add",
      "--repository",
      repo,
      "--name",
      "E2E Demo",
      "--home",
      homeRoot,
    ]);
    expect(added.code).toBe(0);
    expect(added.stdout.join("\n")).toMatch(/Registered project/);
    expect(added.stdout.join("\n")).toMatch(/worktreeRoot:/);

    const listed = await runCli(["project", "list", "--home", homeRoot]);
    expect(listed.code).toBe(0);
    expect(listed.stdout.join("\n").replace(/\\/g, "/")).toContain(repo.replace(/\\/g, "/"));

    // Configure + start/advance/publish through the engine (scripted agents; no API keys).
    const home = resolveHarnessHome({ homeRoot });
    const loaded = await loadExternalProjectConfig({
      repository: repo,
      home,
      allowLegacy: false,
      overrides: {
        git: {
          enabled: true,
          baseBranch: "main",
          branchPrefix: "harness",
          push: false,
          openPullRequest: false,
          remote: "origin",
          autoCommitPreflight: false,
        },
        workflow: { tdd: false, generateCommitMessages: true },
        knowledge: {
          sources: [{ path: "README.md", scope: "project", visibility: "private" }],
          graphify: { enabled: false },
          guidance: { enabled: false, maxResults: 0, maxCharacters: 1 },
        },
        commands: { test: 'node -e "process.exit(0)"', gates: [] },
        agent: { provider: "cursor", promptBuilder: false, schemaRepairAttempts: 0, timeoutMs: 10_000 },
      },
    });
    const config = HarnessConfigSchema.parse(loaded.config);
    const lookup = loaded.lookup!;
    const runId = "e2e-ext-home-1";
    const observedCwds: string[] = [];

    const backend = createFakeBackend({
      reflector: (request) => {
        observedCwds.push(request.cwd);
        return REFLECT;
      },
      griller: () => ({
        status: "ready_to_plan",
        summary: "No open questions",
        resolutions: [],
      }),
      planner: () => ({
        summary: "One task",
        tasks: [
          {
            id: "t1",
            title: "Ship feature",
            description: "Add feature.ts",
            acceptanceCriteria: ["file exists"],
            blockedBy: [],
            tdd: false,
            testCommand: 'node -e "process.exit(0)"',
          },
        ],
      }),
      implementer: async (request) => {
        observedCwds.push(request.cwd);
        return writingImplementer(request);
      },
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "message-writer": () => ({ subject: "feat: ship feature", body: "Ready." }),
    });

    const engine = new HarnessEngine(config, {
      backend,
      commands: passingCommandRunner(),
      projectContext: { home, paths: lookup.paths },
      paths: harnessPathsFromProject(lookup.paths),
    });

    let state = await engine.start("Ship a tiny feature", runId, false, false);
    expect(state.phase === "blocked" ? state.failure : undefined).toBeUndefined();
    state = await engine.advance(runId);
    expect(state.phase).toBe("awaiting_input");
    const reflectId = state.activeQuestionId!;
    state = await engine.answer(runId, reflectId, "Confirmed brief.");
    state = await engine.advance(runId);

    if (state.grillReady) {
      state = await engine.confirmGrill(runId);
      state = await engine.advance(runId);
    }
    if (state.verificationReady) {
      state = await engine.confirmVerification(runId, {
        patch: state.verificationReady.proposedPatch,
      });
      state = await engine.advance(runId);
    }
    for (let i = 0; i < 20 && state.phase !== "completed" && state.phase !== "blocked"; i += 1) {
      if (state.phase === "awaiting_input" && state.activeQuestionId) {
        state = await engine.answer(runId, state.activeQuestionId, "ok");
      }
      if (state.grillReady) {
        state = await engine.confirmGrill(runId);
      }
      if (state.verificationReady) {
        state = await engine.confirmVerification(runId, {
          patch: state.verificationReady.proposedPatch,
        });
      }
      state = await engine.advance(runId);
    }
    expect(state.phase).toBe("completed");
    expect(state.branchName).toMatch(/^harness\//);

    // Agents must operate in the sibling worktree, never the harness home.
    expect(observedCwds.length).toBeGreaterThan(0);
    for (const cwd of observedCwds) {
      expect(path.resolve(cwd)).toContain(`${path.basename(repo)}-worktrees`);
      expect(path.resolve(cwd).startsWith(path.resolve(homeRoot))).toBe(false);
      expect(path.resolve(cwd)).not.toBe(path.resolve(repo));
    }

    // Storage report covers external categories + worktree location.
    const storage = await reportProjectStorage(lookup.paths);
    expect(storage.totalBytes).toBeGreaterThan(0);
    expect(storage.worktreeRoot).toContain(`${path.basename(repo)}-worktrees`);
    const storageCli = await runCli([
      "storage",
      "--repository",
      repo,
      "--home",
      homeRoot,
    ]);
    expect(storageCli.code).toBe(0);
    expect(storageCli.stdout.join("\n")).toMatch(/worktreeRoot:|total:/);

    // Target repo remains zero-footprint aside from Git worktree admin metadata.
    const afterNames = (await readdir(repo)).filter((name) => name !== ".git").sort();
    expect(afterNames).toEqual(beforeNames);
    await expect(access(path.join(repo, ".agent-harness"))).rejects.toBeTruthy();
    await expect(access(path.join(repo, "agent-harness.config.yaml"))).rejects.toBeTruthy();

    // Cleanup settled run worktree.
    const cleaned = await engine.cleanup(runId);
    expect(cleaned.removed || cleaned.reason === "already-removed").toBeTruthy();

    // Project removal never deletes the target repository.
    const removed = await runCli([
      "project",
      "remove",
      "--project",
      lookup.registration.projectKey,
      "--force",
      "--home",
      homeRoot,
    ]);
    expect(removed.code).toBe(0);
    expect(removed.stdout.join("\n")).toMatch(/Target repository left untouched/);
    await access(path.join(repo, "README.md"));
    expect(await new ProjectRegistry(home).list()).toEqual([]);
  }, 120_000);
});
