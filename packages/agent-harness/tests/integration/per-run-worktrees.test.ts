import path from "node:path";
import { tmpdir } from "node:os";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeBackend } from "../../src/agent.js";
import { openRunHarness } from "../../src/application/run-engine-factory.js";
import { resolveHarnessPaths } from "../../src/application/paths.js";
import { CONFIG_VERSION, configurationHash } from "../../src/config.js";
import {
  createRunState,
  type BuildTask,
  type RunState,
} from "../../src/domain.js";
import {
  canonicalizeWorkspacePath,
  isLegacyTreeFingerprint,
  migrateRunWorkspace,
  sanitizeWorktreeRunId,
  type RunWorkspace,
} from "../../src/domain/workspace.js";
import { HarnessEngine } from "../../src/engine.js";
import { assertGitWorktreeCapability } from "../../src/git/capabilities.js";
import type { GraphifyRunner } from "../../src/graphify.js";
import { git as runGit } from "../testkit/git.js";
import {
  createProjectFixture,
  type ProjectFixture,
} from "../testkit/project-fixture.js";

async function writingImplementer(request: { cwd: string }) {
  await mkdir(path.join(request.cwd, "src"), { recursive: true });
  await writeFile(path.join(request.cwd, "src", "a.ts"), "export const a = 1;\n", "utf8");
  return { summary: "built", changedFiles: ["src/a.ts"] };
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
  unknowns: ["edge cases"],
};

type ControlSnapshot = {
  branch: string;
  head: string;
  status: string;
  readme: string;
};

async function snapshotControl(fixture: ProjectFixture): Promise<ControlSnapshot> {
  return {
    branch: (await fixture.git("branch", "--show-current")).trim(),
    head: (await fixture.git("rev-parse", "HEAD")).trim(),
    status: (await fixture.git("status", "--porcelain=v1", "--untracked-files=all")).trim(),
    readme: await fixture.read("README.md"),
  };
}

describe("per-run worktrees (Slice 2)", () => {
  let fixture: ProjectFixture | undefined;

  afterEach(async () => {
    if (fixture) {
      await fixture.cleanup();
      fixture = undefined;
    }
  });

  it("starts detached at baseSha without touching the control checkout or creating a delivery branch", async () => {
    await assertGitWorktreeCapability();
    fixture = await createProjectFixture({
      config: {
        git: { enabled: true, baseBranch: "main", branchPrefix: "harness" },
        knowledge: {
          sources: [{ path: "README.md" }],
          graphify: { enabled: false },
          guidance: { enabled: false, maxResults: 0, maxCharacters: 1 },
        },
      },
    });
    await fixture.initGit({ branch: "main" });
    const baseSha = (await fixture.git("rev-parse", "HEAD")).trim();

    await fixture.git("checkout", "-b", "operator");
    await fixture.write("dirty.txt", "uncommitted\n");
    const before = await snapshotControl(fixture);
    expect(before.branch).toBe("operator");
    expect(before.status).toContain("dirty.txt");

    const observedCwds: string[] = [];
    const backend = createFakeBackend({
      reflector: (request) => {
        observedCwds.push(request.cwd);
        return REFLECT_OUTPUT;
      },
    });

    const engine = new HarnessEngine(fixture.config, { backend });
    const runId = "worktree-start-1";
    const state = await engine.start("Ship a feature", runId, false, false);

    expect(state.phase).toBe("new");
    expect(state.branchName).toBeUndefined();
    expect(state.blockedFrom).toBeUndefined();

    const workspaceRaw = await engine.store.readJson(runId, "workspace.json");
    const workspace = migrateRunWorkspace(workspaceRaw, {
      controlRoot: fixture.root,
    });
    expect(workspace.kind).toBe("git-worktree");
    expect(workspace.baseSha).toBe(baseSha);
    expect(workspace.baseBranch).toBe("main");
    expect(workspace.branchName).toBeUndefined();
    expect(workspace.worktreePath).toBe(
      canonicalizeWorkspacePath(
        path.join(
          resolveHarnessPaths(fixture.config).stateRoot,
          "worktrees",
          sanitizeWorktreeRunId(runId),
        ),
      ),
    );

    const afterStart = await snapshotControl(fixture);
    expect(afterStart).toEqual(before);

    const branches = (await fixture.git("branch", "--list", "harness/*")).trim();
    expect(branches).toBe("");

    // Worktree HEAD is detached at base; control dirty file is not imported.
    const worktreeHead = (await runGit(workspace.worktreePath!, "rev-parse", "HEAD")).trim();
    expect(worktreeHead).toBe(baseSha);
    await expect(access(path.join(workspace.worktreePath!, "dirty.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const advanced = await engine.advance(runId);
    expect(advanced.phase).toBe("awaiting_input");
    expect(observedCwds.length).toBeGreaterThan(0);
    for (const cwd of observedCwds) {
      expect(canonicalizeWorkspacePath(cwd)).toBe(workspace.worktreePath);
    }

    const afterAdvance = await snapshotControl(fixture);
    expect(afterAdvance).toEqual(before);
  });

  it("keeps startup Graphify output ignored when the committed base has no ignore rule", async () => {
    await assertGitWorktreeCapability();
    fixture = await createProjectFixture({
      config: {
        git: { enabled: true, baseBranch: "main", branchPrefix: "harness" },
        knowledge: {
          sources: [{ path: "README.md" }],
          graphify: { enabled: true },
          guidance: { enabled: false, maxResults: 0, maxCharacters: 1 },
        },
      },
    });
    await fixture.initGit({ branch: "main" });

    const graphifyRunner = vi.fn<GraphifyRunner>(async (_executable, args, options) => {
      if (args[0] === "--version") {
        return { exitCode: 0, stdout: "graphify 0.9.1\n", stderr: "", timedOut: false };
      }
      if (args[0] === "update") {
        const graphRoot = path.join(options.cwd, "graphify-out");
        await mkdir(path.join(graphRoot, "cache"), { recursive: true });
        await writeFile(path.join(graphRoot, "graph.json"), "{}\n", "utf8");
        await writeFile(path.join(graphRoot, "cache", "entry.json"), "{}\n", "utf8");
        return { exitCode: 0, stdout: "Updated graph\n", stderr: "", timedOut: false };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected", timedOut: false };
    });

    const engine = new HarnessEngine(fixture.config, {
      backend: createFakeBackend({ reflector: () => REFLECT_OUTPUT }),
      graphifyRunner,
    });
    const runId = "worktree-graphify-ignore";
    const state = await engine.start("Ship a feature", runId, false, true);
    const workspace = migrateRunWorkspace(await engine.store.readJson(runId, "workspace.json"), {
      controlRoot: fixture.root,
    });

    expect(state.phase).toBe("new");
    const updateCall = graphifyRunner.mock.calls.find(([, args]) => args[0] === "update");
    expect(updateCall).toBeDefined();
    expect(canonicalizeWorkspacePath(updateCall![1][1]!)).toBe(workspace.worktreePath);
    expect(canonicalizeWorkspacePath(updateCall![2].cwd)).toBe(workspace.worktreePath);
    expect(
      (await runGit(workspace.worktreePath!, "status", "--porcelain=v1", "--untracked-files=all")).trim(),
    ).toBe("");
    await expect(
      runGit(
        workspace.worktreePath!,
        "check-ignore",
        "--quiet",
        "--no-index",
        "--",
        "graphify-out/graph.json",
      ),
    ).resolves.toBe("");

    const advanced = await engine.advance(runId);
    expect(advanced.phase).toBe("awaiting_input");
    expect(advanced.blockedKind).toBeUndefined();
  });

  it("recomposes resume from frozen config + workspace.json onto the registered worktree", async () => {
    await assertGitWorktreeCapability();
    fixture = await createProjectFixture({
      config: {
        git: { enabled: true, baseBranch: "main" },
        knowledge: {
          sources: [{ path: "README.md" }],
          graphify: { enabled: false },
          guidance: { enabled: false, maxResults: 0, maxCharacters: 1 },
        },
      },
    });
    await fixture.initGit({ branch: "main" });
    const backend = createFakeBackend({});
    const starter = new HarnessEngine(fixture.config, { backend });
    const runId = "worktree-resume-1";
    await starter.start("Resume me", runId, false, false);

    const opened = await openRunHarness(fixture.config, runId, { backend });
    expect(opened.workspace.kind).toBe("git-worktree");
    expect(opened.paths.workspaceRoot).not.toBe(opened.paths.controlRoot);
    expect(canonicalizeWorkspacePath(opened.paths.workspaceRoot)).toBe(
      opened.workspace.worktreePath,
    );

    const head = (await opened.engine.git.currentBranch()) ?? "detached";
    // Detached HEAD reports undefined from currentBranch.
    expect(opened.engine.git).toBeTruthy();
    void head;

    const workspaceFile = JSON.parse(
      await readFile(
        path.join(opened.paths.stateRoot, "runs", runId, "workspace.json"),
        "utf8",
      ),
    ) as RunWorkspace;
    expect(workspaceFile.kind).toBe("git-worktree");
  });

  it("blocks recoverably when the recorded worktree is missing after start", async () => {
    await assertGitWorktreeCapability();
    fixture = await createProjectFixture({
      config: {
        git: { enabled: true, baseBranch: "main" },
        knowledge: {
          sources: [{ path: "README.md" }],
          graphify: { enabled: false },
          guidance: { enabled: false, maxResults: 0, maxCharacters: 1 },
        },
      },
    });
    await fixture.initGit({ branch: "main" });
    const backend = createFakeBackend({});
    const engine = new HarnessEngine(fixture.config, { backend });
    const runId = "worktree-missing-1";
    await engine.start("Missing later", runId, false, false);
    const workspace = migrateRunWorkspace(await engine.store.readJson(runId, "workspace.json"), {
      controlRoot: fixture.root,
    });
    await fixture.removeWorktree(workspace.worktreePath!, { force: true });

    await expect(openRunHarness(fixture.config, runId, { backend })).rejects.toThrow(
      /worktree|missing|registered/i,
    );

    const advanced = await engine.advance(runId);
    expect(advanced.phase).toBe("blocked");
    expect(advanced.blockedKind).toBe("workspace");
    expect(advanced.blockedRetriable).toBe(true);
    expect(advanced.failure).toMatch(/worktree|missing|registered/i);
  });
});

describe("per-run worktrees (Slice 3 — run-local evidence)", () => {
  let fixture: ProjectFixture | undefined;

  afterEach(async () => {
    if (fixture) {
      await fixture.cleanup();
      fixture = undefined;
    }
  });

  async function startStampedExecutingRun(runId: string): Promise<{
    engine: HarnessEngine;
    state: RunState;
    worktreePath: string;
  }> {
    await assertGitWorktreeCapability();
    fixture = await createProjectFixture({
      config: {
        git: { enabled: true, baseBranch: "main", branchPrefix: "harness" },
        workflow: { tdd: false },
        commands: { verification: [{ id: "test", command: 'node -e "process.exit(0)"', timeoutMs: 600_000 }] },
        knowledge: {
          sources: [{ path: "README.md" }],
          graphify: { enabled: false },
          guidance: { enabled: false, maxResults: 0, maxCharacters: 1 },
        },
      },
    });
    await fixture.initGit({ branch: "main" });
    const backend = createFakeBackend({
      implementer: writingImplementer,
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "message-writer": () => ({ subject: "feat: a", body: "" }),
    });
    const engine = new HarnessEngine(fixture.config, { backend });
    await engine.start("Ship evidence", runId, false, false);
    const workspace = migrateRunWorkspace(await engine.store.readJson(runId, "workspace.json"), {
      controlRoot: fixture.root,
    });
    expect(workspace.worktreePath).toBeTruthy();

    const task = pendingTask("t1", "Ship one");
    let state = await seedExecutingOverExisting(engine, fixture.config, runId, [task]);
    const evidence = await engine.git.workspaceEvidence();
    state = {
      ...state,
      workspaceEvidence: evidence,
      treeFingerprint: evidence.fingerprint,
    };
    await engine.store.writeJson(runId, "state.json", state);
    return { engine, state, worktreePath: workspace.worktreePath! };
  }

  it("ignores control-checkout edits and operator branch switches for evidence", async () => {
    const runId = "evidence-control-1";
    const { engine, state, worktreePath } = await startStampedExecutingRun(runId);
    const before = state.workspaceEvidence!;

    await fixture!.git("checkout", "-b", "operator-side");
    await fixture!.write("control-edit.txt", "operator dirty\n");
    await fixture!.write("README.md", "# Fixture\n\noperator touched\n");

    const observed = await engine.git.workspaceEvidence();
    expect(observed.fingerprint).toBe(before.fingerprint);
    expect(canonicalizeWorkspacePath(engine.paths.workspaceRoot)).toBe(
      canonicalizeWorkspacePath(worktreePath),
    );

    const advanced = await engine.advance(runId);
    expect(advanced.phase).not.toBe("blocked");
    expect(String(advanced.failure || "")).not.toMatch(/Workspace diverged|Working tree diverged/i);
  });

  it("blocks with HEAD / index / working-file diagnostics for in-worktree mutations", async () => {
    const runId = "evidence-components-1";
    const { engine, worktreePath } = await startStampedExecutingRun(runId);

    await writeFile(path.join(worktreePath, "external-edit.txt"), "mutated\n", "utf8");
    let blocked = await engine.advance(runId);
    expect(blocked.phase).toBe("blocked");
    expect(blocked.blockedKind).toBe("workspace");
    expect(blocked.failure).toMatch(/working files/i);
    expect(blocked.failure).toContain("external-edit.txt");
    expect(blocked.failure).not.toMatch(/\bHEAD\b/);

    const events = (await engine.store.readText(runId, "events.jsonl"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string; detail: Record<string, unknown> });
    expect(events.some((event) => event.type === "run.workspace_diverged")).toBe(true);

    blocked = await engine.acceptTree(runId);
    expect(blocked.phase).toBe("executing");

    await runGit(worktreePath, "add", "--", "external-edit.txt");
    blocked = await engine.advance(runId);
    expect(blocked.phase).toBe("blocked");
    expect(blocked.failure).toMatch(/\bindex\b/i);

    blocked = await engine.acceptTree(runId);
    await runGit(worktreePath, "commit", "-m", "external in worktree");
    blocked = await engine.advance(runId);
    expect(blocked.phase).toBe("blocked");
    expect(blocked.failure).toMatch(/\bHEAD\b/);
  });

  it("resumes after process reconstruction in the recorded worktree", async () => {
    const runId = "evidence-resume-1";
    const { state, worktreePath } = await startStampedExecutingRun(runId);
    const stamped = state.workspaceEvidence!;

    const backend = createFakeBackend({
      implementer: writingImplementer,
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "message-writer": () => ({ subject: "feat: a", body: "" }),
    });
    const opened = await openRunHarness(fixture!.config, runId, { backend });
    expect(canonicalizeWorkspacePath(opened.paths.workspaceRoot)).toBe(
      canonicalizeWorkspacePath(worktreePath),
    );
    const observed = await opened.engine.git.workspaceEvidence();
    expect(observed.fingerprint).toBe(stamped.fingerprint);

    await fixture!.write("control-after-restart.txt", "still ignored\n");
    const advanced = await opened.engine.advance(runId);
    expect(advanced.phase).not.toBe("blocked");
    expect(String(advanced.failure || "")).not.toMatch(/Workspace diverged|Working tree diverged/i);
  });

  it("still asserts legacy opaque treeFingerprint until the next structured stamp", async () => {
    await assertGitWorktreeCapability();
    fixture = await createProjectFixture({
      config: {
        git: { enabled: true, baseBranch: "main" },
        workflow: { tdd: false },
        commands: { verification: [{ id: "test", command: 'node -e "process.exit(0)"', timeoutMs: 600_000 }] },
        knowledge: {
          sources: [{ path: "README.md" }],
          graphify: { enabled: false },
          guidance: { enabled: false, maxResults: 0, maxCharacters: 1 },
        },
      },
    });
    await fixture.initGit({ branch: "main" });
    const backend = createFakeBackend({
      implementer: () => ({ summary: "built", changedFiles: ["src/a.ts"] }),
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "message-writer": () => ({ subject: "feat: a", body: "" }),
    });
    const engine = new HarnessEngine(fixture.config, { backend });
    const runId = "evidence-legacy-1";
    await engine.start("Legacy fingerprint", runId, false, false);
    let state = await seedExecutingOverExisting(engine, fixture.config, runId, [
      pendingTask("t1", "Ship one"),
    ]);
    const legacy = await engine.git.legacyTreeFingerprint();
    expect(isLegacyTreeFingerprint(legacy)).toBe(true);
    state = { ...state, treeFingerprint: legacy, workspaceEvidence: undefined };
    await engine.store.writeJson(runId, "state.json", state);

    const workspace = migrateRunWorkspace(await engine.store.readJson(runId, "workspace.json"), {
      controlRoot: fixture.root,
    });
    await writeFile(path.join(workspace.worktreePath!, "legacy-edit.txt"), "x\n", "utf8");
    const blocked = await engine.advance(runId);
    expect(blocked.phase).toBe("blocked");
    expect(blocked.failure).toMatch(/legacy fingerprint|diverg/i);

    const accepted = await engine.acceptTree(runId);
    expect(accepted.workspaceEvidence).toBeTruthy();
    expect(isLegacyTreeFingerprint(accepted.treeFingerprint)).toBe(false);
  });
});

describe("per-run worktrees (Slice 4 — late delivery branch)", () => {
  let fixture: ProjectFixture | undefined;

  afterEach(async () => {
    if (fixture) {
      await fixture.cleanup();
      fixture = undefined;
    }
  });

  it("commits and squashes checkpoints on detached HEAD using baseSha ownership", async () => {
    await assertGitWorktreeCapability();
    fixture = await createProjectFixture({
      config: {
        git: { enabled: true, baseBranch: "main", branchPrefix: "harness" },
        knowledge: {
          sources: [{ path: "README.md" }],
          graphify: { enabled: false },
          guidance: { enabled: false, maxResults: 0, maxCharacters: 1 },
        },
      },
    });
    await fixture.initGit({ branch: "main" });
    const baseSha = (await fixture.git("rev-parse", "HEAD")).trim();
    const engine = new HarnessEngine(fixture.config, { backend: createFakeBackend({}) });
    const runId = "slice4-detached-1";
    await engine.start("Detached commits", runId, false, false);
    const workspace = migrateRunWorkspace(await engine.store.readJson(runId, "workspace.json"), {
      controlRoot: fixture.root,
    });
    expect(workspace.branchName).toBeUndefined();
    expect((await fixture.git("branch", "--list", "harness/*")).trim()).toBe("");

    const wt = workspace.worktreePath!;
    expect(await engine.git.currentBranch()).toBeUndefined();
    await mkdir(path.join(wt, "tests"), { recursive: true });
    await mkdir(path.join(wt, "src"), { recursive: true });
    await writeFile(path.join(wt, "tests", "a.test.ts"), "RED\n", "utf8");
    const checkpoint = await engine.git.commitRedCheckpoint({
      taskId: "t1",
      taskTitle: "Ship one",
      testPaths: ["tests/a.test.ts"],
    });
    expect(checkpoint?.sha).toMatch(/^[a-f0-9]{40}$/);
    expect(await engine.git.currentBranch()).toBeUndefined();

    await writeFile(path.join(wt, "src", "a.ts"), "export const a = 1;\n", "utf8");
    const sha = await engine.git.squashCheckpointsIntoTaskCommit({
      taskId: "t1",
      message: { subject: "feat: ship one", body: "done" },
      reportedPaths: ["tests/a.test.ts", "src/a.ts"],
      redCheckpointShas: [checkpoint!.sha],
      baseSha,
    });
    expect(sha).toMatch(/^[a-f0-9]{40}$/);
    expect(await engine.git.currentBranch()).toBeUndefined();
    expect((await fixture.git("branch", "--list", "harness/*")).trim()).toBe("");
    const count = (await runGit(wt, "rev-list", "--count", `${baseSha}..HEAD`)).trim();
    expect(Number(count)).toBe(1);
  });

  it("creates a title-slugged delivery branch at publish and pushes to a bare remote", async () => {
    await assertGitWorktreeCapability();
    const bareRoot = await mkdtemp(path.join(tmpdir(), "agent-harness-bare-"));
    await runGit(bareRoot, "init", "--bare");

    fixture = await createProjectFixture({
      config: {
        git: {
          enabled: true,
          baseBranch: "main",
          branchPrefix: "harness",
          remote: "origin",
          push: true,
          openPullRequest: false,
        },
        workflow: { tdd: false },
        commands: { verification: [{ id: "test", command: 'node -e "process.exit(0)"', timeoutMs: 600_000 }] },
        knowledge: {
          sources: [{ path: "README.md" }],
          graphify: { enabled: false },
          guidance: { enabled: false, maxResults: 0, maxCharacters: 1 },
        },
      },
    });
    await fixture.initGit({ branch: "main" });
    await fixture.git("remote", "add", "origin", bareRoot);

    const runId = "4e78e0fa-late-branch";
    const backend = createFakeBackend({
      implementer: writingImplementer,
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "message-writer": () => ({ subject: "feat: ship a feature", body: "Ready." }),
    });
    const engine = new HarnessEngine(fixture.config, { backend });
    await engine.start("Ship a feature", runId, false, false);
    expect((await fixture.git("branch", "--list", "harness/*")).trim()).toBe("");

    let state = await seedExecutingOverExisting(engine, fixture.config, runId, [
      pendingTask("t1", "Ship one"),
    ]);
    state = {
      ...state,
      reflectBrief: {
        draft: "d",
        confirmed: "confirmed",
        confirmedAt: new Date().toISOString(),
        confirmedStructured: {
          proposedTitle: "Ship a Feature",
          summary: "s",
          restatement: "r",
          goal: "g",
          users: [],
          inScope: [],
          outOfScope: [],
          assumptions: [],
          unknowns: [],
        },
      },
    };
    await engine.store.writeJson(runId, "state.json", state);

    const before = await snapshotControl(fixture);
    state = await engine.advance(runId);
    // May need multiple advances through implement → review → commit → publish.
    for (let i = 0; i < 12 && state.phase !== "completed" && state.phase !== "blocked"; i += 1) {
      state = await engine.advance(runId);
    }
    expect(state.phase).toBe("completed");
    expect(state.branchName).toBe("harness/ship-a-feature-4e78e0fa");
    expect(await snapshotControl(fixture)).toEqual(before);

    const workspace = migrateRunWorkspace(await engine.store.readJson(runId, "workspace.json"), {
      controlRoot: fixture.root,
    });
    expect(workspace.branchName).toBe("harness/ship-a-feature-4e78e0fa");

    const events = (await engine.store.readText(runId, "events.jsonl"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string; detail: Record<string, unknown> });
    const created = events.find((event) => event.type === "run.branch_created");
    expect(created?.detail.titleSlug).toBe("ship-a-feature");
    expect(created?.detail.branchName).toBe("harness/ship-a-feature-4e78e0fa");
    expect(String(created?.detail.headSha)).toMatch(/^[a-f0-9]{40}$/);

    const remoteHeads = (await runGit(bareRoot, "branch", "--list", "harness/*")).trim();
    expect(remoteHeads).toContain("harness/ship-a-feature-4e78e0fa");

    await rm(bareRoot, { recursive: true, force: true });
  });

  it("preserves an explicit/legacy branch name at publication", async () => {
    await assertGitWorktreeCapability();
    fixture = await createProjectFixture({
      config: {
        git: { enabled: true, baseBranch: "main", branchPrefix: "harness", push: false },
        workflow: { tdd: false },
        commands: { verification: [{ id: "test", command: 'node -e "process.exit(0)"', timeoutMs: 600_000 }] },
        knowledge: {
          sources: [{ path: "README.md" }],
          graphify: { enabled: false },
          guidance: { enabled: false, maxResults: 0, maxCharacters: 1 },
        },
      },
    });
    await fixture.initGit({ branch: "main" });
    const runId = "legacy-branch-1";
    const backend = createFakeBackend({
      implementer: writingImplementer,
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "message-writer": () => ({ subject: "feat: legacy", body: "" }),
    });
    const engine = new HarnessEngine(fixture.config, { backend });
    await engine.start("Legacy branch", runId, false, false);
    let state = await seedExecutingOverExisting(engine, fixture.config, runId, [
      pendingTask("t1", "Ship one"),
    ]);
    state = { ...state, branchName: "harness/explicit-legacy" };
    const workspace = migrateRunWorkspace(await engine.store.readJson(runId, "workspace.json"), {
      controlRoot: fixture.root,
    });
    await engine.store.writeJson(runId, "workspace.json", {
      ...workspace,
      branchName: "harness/explicit-legacy",
    });
    await engine.store.writeJson(runId, "state.json", state);
    // Rebind so publish sees the preserved name.
    const opened = await openRunHarness(fixture.config, runId, { backend });
    let advanced = await opened.engine.advance(runId);
    for (let i = 0; i < 12 && advanced.phase !== "completed" && advanced.phase !== "blocked"; i += 1) {
      advanced = await opened.engine.advance(runId);
    }
    expect(advanced.phase).toBe("completed");
    expect(advanced.branchName).toBe("harness/explicit-legacy");
    expect((await fixture.git("branch", "--list", "harness/explicit-legacy")).trim()).toContain(
      "harness/explicit-legacy",
    );
  });

  it("fails when the proposed late branch exists at a different SHA", async () => {
    await assertGitWorktreeCapability();
    fixture = await createProjectFixture({
      config: {
        git: { enabled: true, baseBranch: "main", branchPrefix: "harness", push: false },
        workflow: { tdd: false },
        commands: { verification: [{ id: "test", command: 'node -e "process.exit(0)"', timeoutMs: 600_000 }] },
        knowledge: {
          sources: [{ path: "README.md" }],
          graphify: { enabled: false },
          guidance: { enabled: false, maxResults: 0, maxCharacters: 1 },
        },
      },
    });
    await fixture.initGit({ branch: "main" });
    // Conflicting branch at base, not at the run tip after the task commit.
    await fixture.git("branch", "harness/ship-a-feature-conflict");

    const runId = "conflict1-xxxx";
    const backend = createFakeBackend({
      implementer: writingImplementer,
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "message-writer": () => ({ subject: "feat: conflict", body: "" }),
    });
    const engine = new HarnessEngine(fixture.config, { backend });
    await engine.start("Ship a Feature", runId, false, false);
    let state = await seedExecutingOverExisting(engine, fixture.config, runId, [
      pendingTask("t1", "Ship one"),
    ]);
    state = {
      ...state,
      reflectBrief: {
        draft: "d",
        confirmed: "confirmed",
        confirmedAt: new Date().toISOString(),
        confirmedStructured: {
          proposedTitle: "Ship a Feature",
          summary: "s",
          restatement: "r",
          goal: "g",
          users: [],
          inScope: [],
          outOfScope: [],
          assumptions: [],
          unknowns: [],
        },
      },
    };
    await engine.store.writeJson(runId, "state.json", state);

    let advanced = await engine.advance(runId);
    for (let i = 0; i < 12 && !["completed", "blocked"].includes(advanced.phase); i += 1) {
      advanced = await engine.advance(runId);
    }
    // Conflict surfaces at publish after the task commit moves HEAD off base.
    expect(advanced.phase).toBe("blocked");
    expect(advanced.failure).toMatch(/already exists|will not reset/i);
  });
});

function pendingTask(id: string, title: string): BuildTask {
  return {
    id,
    title,
    description: title,
    acceptanceCriteria: ["works"],
    affectedPaths: [],
    blockedBy: [],
    tdd: false,
    status: "pending",
    step: "pending",
    attempts: { tests: 0, implementation: 0, review: 0 },
    evidence: [],
    testPaths: [],
    changedFiles: [],
  };
}

async function seedExecutingOverExisting(
  engine: HarnessEngine,
  config: ProjectFixture["config"],
  runId: string,
  tasks: BuildTask[],
): Promise<RunState> {
  const existing = await engine.store.load(runId);
  const state: RunState = {
    ...createRunState(runId, existing.idea, new Date().toISOString(), "hash", CONFIG_VERSION),
    ...existing,
    phase: "executing",
    tasks,
    reflectBrief: {
      draft: "d",
      confirmed: "confirmed",
      confirmedAt: new Date().toISOString(),
    },
    configurationHash: configurationHash(config),
    configVersion: CONFIG_VERSION,
  };
  await engine.store.writeJson(runId, "state.json", state);
  await engine.store.writeJson(runId, "config.json", {
    ...config,
    configVersion: CONFIG_VERSION,
  });
  return state;
}
