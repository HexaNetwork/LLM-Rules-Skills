import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createFakeBackend } from "../../src/agent.js";
import { CONFIG_VERSION, configurationHash } from "../../src/config.js";
import { createRunState, type BuildTask, type RunState } from "../../src/domain.js";
import { HarnessEngine } from "../../src/engine.js";
import { GitService } from "../../src/git.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

const exec = promisify(execFile);

describe("diffForPaths", () => {
  it("includes a new untracked file in the diff via intent-to-add", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);
    const service = new GitService(fixtureConfig(root, { git: { enabled: true } as never }));

    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "new-file.ts"), "export const added = 1;\n", "utf8");

    const result = await service.diffForPaths(["src/new-file.ts"], 20_000);
    expect(result.diff).toContain("diff --git");
    expect(result.diff).toContain("src/new-file.ts");
    expect(result.diff).toContain("export const added = 1;");
    expect(result.omittedFiles).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("drops whole files when over budget and reports them in omittedFiles", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);
    const service = new GitService(fixtureConfig(root, { git: { enabled: true } as never }));

    await mkdir(path.join(root, "src"), { recursive: true });
    // Names chosen so git's alphabetical section order keeps the small file first.
    await writeFile(path.join(root, "src", "a-small.ts"), "export const small = 1;\n", "utf8");
    await writeFile(
      path.join(root, "src", "b-large.ts"),
      `export const large = "${"x".repeat(2_000)}";\n`,
      "utf8",
    );

    const full = await service.diffForPaths(["src/a-small.ts", "src/b-large.ts"], 100_000);
    expect(full.diff).toContain("src/a-small.ts");
    expect(full.diff).toContain("src/b-large.ts");

    const tight = await service.diffForPaths(["src/a-small.ts", "src/b-large.ts"], 400);
    expect(tight.diff).toContain("src/a-small.ts");
    expect(tight.diff).not.toContain("src/b-large.ts");
    expect(tight.omittedFiles).toContain("src/b-large.ts");
    expect(tight.truncated).toBe(true);
    // Whole-file budget: every kept section starts at a file boundary.
    for (const section of tight.diff.split(/(?=^diff --git )/m).filter(Boolean)) {
      expect(section.startsWith("diff --git ")).toBe(true);
    }
  });

  it("omits binary file sections from the diff", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);
    const service = new GitService(fixtureConfig(root, { git: { enabled: true } as never }));

    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "text.ts"), "export const ok = true;\n", "utf8");
    await writeFile(path.join(root, "src", "blob.bin"), Buffer.from([0, 1, 2, 3, 255, 0, 10]));

    const result = await service.diffForPaths(["src/text.ts", "src/blob.bin"], 20_000);
    expect(result.diff).toContain("src/text.ts");
    expect(result.diff).not.toMatch(/Binary files|GIT binary patch/);
    expect(result.omittedFiles).toContain("src/blob.bin");
  });
});

describe("reviewTask packet", () => {
  it("passes diff and diffOmittedFiles to the reviewer", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "feature.ts"), "export const feature = true;\n", "utf8");

    let reviewerPrompt = "";
    const config = fixtureConfig(root, {
      agent: { promptBuilder: false } as never,
      workflow: { ...fixtureConfig(root).workflow, maxStepsPerRun: 1, tdd: false },
      commands: { test: 'node -e "process.exit(0)"', gates: [] },
      git: { enabled: true } as never,
      knowledge: {
        ...fixtureConfig(root).knowledge,
        guidance: { enabled: false, maxResults: 0, maxCharacters: 1 },
        graphify: { ...fixtureConfig(root).knowledge.graphify, enabled: false },
      },
    });
    const backend = createFakeBackend({
      reviewer: (request) => {
        reviewerPrompt = request.prompt;
        return { approved: true, summary: "ok", findings: [] };
      },
    });
    const engine = new HarnessEngine(config, { backend });
    const task = pendingTask("t1", "Ship feature");
    task.status = "active";
    task.step = "reviewing";
    task.changedFiles = ["src/feature.ts"];
    let state = await seedExecutingRun(engine, config, "review-diff", [task]);

    state = await engine.advance(state.runId, 1);
    expect(state.phase).not.toBe("blocked");

    const packetFiles = await engine.store.listFiles(state.runId, "packets");
    const reviewerPacketPath = packetFiles.find(
      (name) => name.endsWith(".json") && !name.includes(".guidance.") && !name.includes(".retrieval."),
    );
    expect(reviewerPacketPath).toBeTruthy();
    const packet = (await engine.store.readJson(state.runId, reviewerPacketPath!)) as {
      role: string;
      input: { diff?: string; diffOmittedFiles?: string[]; changedFiles?: string[] };
    };
    expect(packet.role).toBe("reviewer");
    expect(packet.input.diff).toContain("src/feature.ts");
    expect(packet.input.diff).toContain("export const feature = true;");
    expect(packet.input.diffOmittedFiles).toEqual([]);
    expect(reviewerPrompt).toContain(
      "The diff is the primary evidence. Read the listed omitted files from disk before commenting on them.",
    );
  });

  it("re-stamps treeFingerprint after intent-to-add so the next advance does not false-block", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "new-file.ts"), "export const added = 1;\n", "utf8");

    const config = fixtureConfig(root, {
      agent: { promptBuilder: false } as never,
      workflow: { ...fixtureConfig(root).workflow, maxStepsPerRun: 1, tdd: false },
      commands: { test: 'node -e "process.exit(0)"', gates: [] },
      git: { enabled: true } as never,
      knowledge: {
        ...fixtureConfig(root).knowledge,
        guidance: { enabled: false, maxResults: 0, maxCharacters: 1 },
        graphify: { ...fixtureConfig(root).knowledge.graphify, enabled: false },
      },
    });
    const backend = createFakeBackend({
      reviewer: () => ({
        approved: false,
        summary: "needs work",
        findings: [{ severity: "blocking" as const, message: "tighten the edge case" }],
      }),
      implementer: () => ({ summary: "repaired", changedFiles: ["src/new-file.ts"] }),
    });
    const engine = new HarnessEngine(config, { backend });
    const gitService = new GitService(config);

    const task = pendingTask("t1", "Ship new file");
    task.status = "active";
    task.step = "reviewing";
    task.changedFiles = ["src/new-file.ts"];
    let state = await seedExecutingRun(engine, config, "review-intent-fingerprint", [task]);

    // Stamp a fingerprint that matches the tree *before* review's intent-to-add.
    const beforeReview = await gitService.treeFingerprint();
    state = { ...state, treeFingerprint: beforeReview };
    await engine.store.writeJson(state.runId, "state.json", state);

    state = await engine.advance(state.runId, 1);
    expect(state.phase).not.toBe("blocked");
    expect(state.blockedKind).not.toBe("workspace");
    expect(state.tasks[0]?.step).toBe("implementing");
    // Porcelain changed (?? → A ); fingerprint must reflect the post-intent-to-add tree.
    const afterReview = await gitService.treeFingerprint();
    expect(afterReview).not.toBe(beforeReview);
    expect(state.treeFingerprint).toBe(afterReview);

    // Next advance must not false-block solely because review intent-to-add'd the new file.
    state = await engine.advance(state.runId, 1);
    expect(state.phase).not.toBe("blocked");
    expect(state.blockedKind).not.toBe("workspace");
  });
});

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

  it("commitTask ignores dirty artifact paths covered by ignoredArtifactPatterns", async () => {
    const root = await fixtureRoot();
    await initGitRepo(root);

    const config = fixtureConfig(root, {
      git: {
        enabled: true,
        ignoredArtifactPatterns: ["**/obj/", "*.pdb", "**/*.cache"],
      } as never,
    });
    const service = new GitService(config);
    await service.ensureRunBranch("artifacts");

    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "Source", "App", "obj", "Debug"), { recursive: true });
    await writeFile(path.join(root, "src", "feature.ts"), "export const feature = true;\n", "utf8");
    await writeFile(
      path.join(root, "Source", "App", "obj", "Debug", "App.assets.cache"),
      "cache\n",
      "utf8",
    );
    await writeFile(path.join(root, "Source", "App", "App.pdb"), "pdb\n", "utf8");

    expect(await service.changedFiles()).toEqual(["src/feature.ts"]);
    const sha = await service.commitTask(
      "feature-artifacts",
      { subject: "feat: add feature", body: "Source only." },
      ["src/feature.ts"],
    );
    expect(sha).toMatch(/^[a-f0-9]{40}$/);
    const files = await git(root, "show", "--pretty=", "--name-only", "HEAD");
    expect(files).toContain("src/feature.ts");
    expect(files).not.toContain("obj");
    expect(files).not.toContain(".pdb");
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
    configurationHash: configurationHash(config),
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
