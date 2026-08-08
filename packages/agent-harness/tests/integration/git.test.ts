import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createFakeBackend } from "../../src/agent.js";
import { CONFIG_VERSION } from "../../src/config.js";
import { createRunState, type BuildTask, type RunState } from "../../src/domain.js";
import { HarnessEngine } from "../../src/engine.js";
import { GitService } from "../../src/git.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

const exec = promisify(execFile);

describe("harness-owned git", () => {
  it("creates the run branch, commits only reported paths, and writes the task trailer", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);

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

  it("currentBranch reports the checked-out branch, and undefined when git is disabled", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);

    const enabled = new GitService(fixtureConfig(root, { git: { enabled: true } as never }));
    expect(await enabled.currentBranch()).toBe("main");

    const disabled = new GitService(fixtureConfig(root, { git: { enabled: false } as never }));
    expect(await disabled.currentBranch()).toBeUndefined();
  });
});

describe("working-tree divergence guard", () => {
  it("blocks with blockedKind workspace when the tree is mutated between advance calls", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);
    const config = fixtureConfig(root, {
      workflow: { ...fixtureConfig(root).workflow, maxStepsPerRun: 1, tdd: false },
      commands: { test: 'node -e "process.exit(0)"', gates: [] },
      git: { enabled: true } as never,
    });
    const backend = createFakeBackend({
      implementer: () => ({ summary: "built", changedFiles: ["src/a.ts"] }),
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "message-writer": () => ({ subject: "feat: a", body: "" }),
    });
    const engine = new HarnessEngine(config, { backend });
    let state = await seedExecutingRun(engine, config, "diverge-block", [
      pendingTask("t1", "Ship one"),
    ]);

    state = await engine.advance(state.runId, 1);
    expect(state.phase).toBe("executing");
    expect(state.treeFingerprint).toBeTruthy();

    await writeFile(path.join(root, "external-edit.txt"), "mutated outside the harness\n", "utf8");

    state = await engine.advance(state.runId, 1);
    expect(state.phase).toBe("blocked");
    expect(state.blockedKind).toBe("workspace");
    expect(state.blockedRetriable).toBe(true);
    expect(state.failure).toMatch(/diverg/i);
    expect(state.failure).toContain("external-edit.txt");
  });

  it("acceptTree re-stamps the fingerprint and lets the run continue", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);
    const config = fixtureConfig(root, {
      workflow: { ...fixtureConfig(root).workflow, maxStepsPerRun: 1, tdd: false },
      commands: { test: 'node -e "process.exit(0)"', gates: [] },
      git: { enabled: true } as never,
    });
    const backend = createFakeBackend({
      implementer: () => ({ summary: "built", changedFiles: ["src/a.ts"] }),
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "message-writer": () => ({ subject: "feat: a", body: "" }),
    });
    const engine = new HarnessEngine(config, { backend });
    let state = await seedExecutingRun(engine, config, "accept-tree", [
      pendingTask("t1", "Ship one"),
    ]);

    state = await engine.advance(state.runId, 1);
    const previousFingerprint = state.treeFingerprint;
    expect(previousFingerprint).toBeTruthy();

    await writeFile(path.join(root, "external-edit.txt"), "mutated outside the harness\n", "utf8");
    state = await engine.advance(state.runId, 1);
    expect(state.phase).toBe("blocked");
    expect(state.blockedKind).toBe("workspace");

    state = await engine.acceptTree(state.runId);
    expect(state.phase).toBe("executing");
    expect(state.blockedKind).toBeUndefined();
    expect(state.failure).toBeUndefined();
    expect(state.treeFingerprint).toBeTruthy();
    expect(state.treeFingerprint).not.toBe(previousFingerprint);

    const events = (await engine.store.readText(state.runId, "events.jsonl"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string; detail: Record<string, unknown> });
    const accepted = events.find((event) => event.type === "run.tree_accepted");
    expect(accepted).toBeTruthy();
    expect(accepted!.detail.previousFingerprint).toBe(previousFingerprint);
    expect(accepted!.detail.treeFingerprint).toBe(state.treeFingerprint);
    expect(accepted!.detail.divergingPaths).toEqual(expect.arrayContaining(["external-edit.txt"]));

    state = await engine.advance(state.runId, 1);
    expect(state.phase).not.toBe("blocked");
  });

  it("never blocks on tree divergence when git.enabled is false", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { ...fixtureConfig(root).workflow, maxStepsPerRun: 1, tdd: false },
      commands: { test: 'node -e "process.exit(0)"', gates: [] },
      git: { enabled: false } as never,
    });
    const backend = createFakeBackend({
      implementer: () => ({ summary: "built", changedFiles: ["src/a.ts"] }),
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "message-writer": () => ({ subject: "feat: a", body: "" }),
    });
    const engine = new HarnessEngine(config, { backend });
    let state = await seedExecutingRun(engine, config, "git-off", [
      pendingTask("t1", "Ship one"),
    ]);

    state = await engine.advance(state.runId, 1);
    expect(state.phase).toBe("executing");
    expect(state.treeFingerprint).toBeUndefined();

    await writeFile(path.join(root, "external-edit.txt"), "mutated\n", "utf8");
    state = await engine.advance(state.runId, 1);
    expect(state.phase).not.toBe("blocked");
    expect(state.blockedKind).toBeUndefined();
  });
});

async function initGitRepo(root: string): Promise<void> {
  await git(root, "init");
  await git(root, "config", "user.email", "harness@example.com");
  await git(root, "config", "user.name", "Harness Test");
  await writeFile(path.join(root, ".gitignore"), ".agent-harness/\n", "utf8");
  await git(root, "add", "--all");
  await git(root, "commit", "-m", "initial");
  await git(root, "branch", "-M", "main");
}

function pendingTask(id: string, title: string): BuildTask {
  return {
    id,
    title,
    description: title,
    acceptanceCriteria: ["works"],
    affectedPaths: [],
    blockedBy: [],
    tdd: false,
    testCommand: 'node -e "process.exit(0)"',
    status: "pending",
    step: "pending",
    attempts: { tests: 0, implementation: 0, review: 0 },
    evidence: [],
    testPaths: [],
    changedFiles: [],
  };
}

async function seedExecutingRun(
  engine: HarnessEngine,
  config: ReturnType<typeof fixtureConfig>,
  runId: string,
  tasks: BuildTask[],
): Promise<RunState> {
  let state: RunState = {
    ...createRunState(runId, "idea", new Date().toISOString(), "hash", CONFIG_VERSION),
    phase: "executing",
    tasks,
    reflectBrief: { draft: "d", confirmed: "confirmed", confirmedAt: new Date().toISOString() },
  };
  await engine.store.initialize();
  await engine.store.create(state);
  state = {
    ...state,
    configurationHash: createHash("sha256").update(JSON.stringify(config)).digest("hex"),
  };
  await engine.store.writeJson(state.runId, "state.json", state);
  await engine.store.writeJson(state.runId, "config.json", {
    ...config,
    configVersion: CONFIG_VERSION,
  });
  return state;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await exec("git", args, { cwd, windowsHide: true });
  return result.stdout;
}
