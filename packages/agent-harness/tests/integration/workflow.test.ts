import path from "node:path";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createFakeBackend,
  type AgentBackend,
  type AgentRequest,
} from "../../src/agent.js";
import {
  CONFIG_VERSION,
  configurationHash,
  loadRunConfig,
  writeProjectSettings,
} from "../../src/config.js";
import { HarnessEngine } from "../../src/engine.js";
import { GitService } from "../../src/git.js";
import {
  evidenceFingerprint,
  failingTestIdsFromEvidence,
  failureCategoryFromEvidence,
} from "../../src/application/evidence-fingerprint.js";
import { createRunState, type RunState } from "../../src/domain.js";
import { migrateRunWorkspace } from "../../src/domain/workspace.js";
import {
  confirmGrillAndAdvance,
  createPlannerPrdSequence,
  createProjectFixture,
  fixtureConfig,
  fixtureRoot,
  git as runGit,
  HIGH_LEVEL_PLAN,
  PRD_OUTPUT,
  SLICER_ONE_TASK
} from "../helpers.js";

const REFLECT_OUTPUT = {
  proposedTitle: "Add greeting tone",
  summary: "Restated greeting feature",
  restatement: "Add a greeting feature with a chosen tone.",
  goal: "Ship a greeting users understand",
  users: ["end users"],
  inScope: ["tone choice", "greeting copy"],
  outOfScope: ["localization"],
  assumptions: ["English only"],
  unknowns: ["formal vs casual"],
};

const FIRST_GRILL_QUESTION = {
  prompt: "Should the greeting be formal or casual?",
  context: "The choice sets the voice users encounter throughout the feature.",
  options: [
    { id: "formal", label: "Formal", description: "Polished and reserved." },
    { id: "casual", label: "Casual", description: "Warm and direct." },
  ],
  recommendedOptionId: "casual",
  recommendation: "Use casual for a lightweight greeting.",
};

describe("durable idea-to-feature workflow", () => {
  it("attributes only paths introduced by a test writer, not an approved dirty config baseline", async () => {
    const fixture = await createProjectFixture();
    await fixture.initGit();
    const config = fixtureConfig(fixture.root, {
      git: { enabled: true, baseBranch: "main" } as never,
      commands: { verification: [{ id: "test", command: 'node -e "process.exit(1)"', timeoutMs: 600_000 }] } as never,
    });
    const backend = createFakeBackend({
      "red-writer": async (request) => {
        await mkdir(path.join(request.cwd, "tests"), { recursive: true });
        await writeFile(
          path.join(request.cwd, "tests", "new-behavior.test.ts"),
          "export {};\n",
          "utf8",
        );
        return {
          status: "continue",
          summary: "Added a failing test.",
          changedFiles: ["tests/new-behavior.test.ts"],
          behaviorsAdded: ["new behavior is covered"],
          edgeCasesAdded: [],
        };
      },
    });
    const engine = new HarnessEngine(config, { backend });
    const started = await engine.start("Preserve an approved setup change");

    // This models a persisted project-default repair. It is intentionally dirty
    // in the run worktree, but known before the next red-writer invocation begins.
    await writeFile(
      path.join(engine.paths.workspaceRoot, "agent-harness.config.yaml"),
      "workflow:\n  testPathPatterns:\n    - tests/**\n",
      "utf8",
    );
    const state = await engine.store.load(started.runId);
    await engine.store.writeJson(started.runId, "state.json", {
      ...state,
      phase: "executing",
      treeFingerprint: await new GitService(config, engine.paths).treeFingerprint(),
      tasks: [{
        id: "test-path-baseline",
        title: "Write a failing test",
        description: "Add coverage.",
        acceptanceCriteria: ["A failing test exists."],
        affectedPaths: [],
        blockedBy: [],
        tdd: true,
        status: "active",
        step: "writing_tests",
        attempts: { tests: 0, implementation: 0, review: 0 },
        evidence: [],
        testPaths: [],
        changedFiles: ["agent-harness.config.yaml"],
      }],
    });

    const advanced = await engine.advance(started.runId);
    expect(advanced.tasks[0]?.testPaths).toEqual(["tests/new-behavior.test.ts"]);
    // Without an implementer the run blocks after the red→implementing handoff.
    expect(advanced.tasks[0]?.status).toBe("active");
  });

  it("reflects, pauses for editable confirm, grills, then plans and finishes", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { tdd: false, maxGrillQuestionsPerEpisode: 5 } as never,
    });
    const requests: AgentRequest[] = [];
    const backend = createFakeBackend({
      reflector: (request) => {
        requests.push(request);
        return REFLECT_OUTPUT;
      },
      griller: (request) => {
        requests.push(request);
        if (String(request.prompt).includes("Casual") || String(request.continuationPrompt ?? "").includes("Casual")) {
          return {
            status: "ready_to_plan",
            summary: "Tone decided",
            resolutions: [
              {
                id: "tone",
                question: FIRST_GRILL_QUESTION.prompt,
                answer: "Casual",
                summary: "Use a casual greeting",
              },
            ],
          };
        }
        return {
          status: "needs_input",
          summary: "Need tone",
          questions: [FIRST_GRILL_QUESTION],
        };
      },
      ...(() => {
        const seq = createPlannerPrdSequence();
        return {
          planner: (request) => {
            requests.push(request);
            const text = `${request.prompt}\n${request.continuationPrompt ?? ""}`;
            expect(text).toMatch(/Confirmed|approved high-level plan|PRD/i);
            return seq.planner(request);
          },
          "issue-slicer": () => ({
            summary: "One task",
        tasks: [
          {
            id: "greet",
            title: "Ship greeting",
            description: "Render the casual greeting.",
            acceptanceCriteria: ["Greeting is casual"],
            blockedBy: [],
            tdd: false,
          },
        ],
        proposedInstalls: [],
          }),
        };
      })(),
      implementer: () => ({ summary: "Built", changedFiles: ["src/greet.ts"] }),
      reviewer: () => ({ approved: true, summary: "Looks good", findings: [] }),
      "message-writer": () => ({ subject: "feat: add greeting", body: "Verified." }),
    });

    const engine = new HarnessEngine(config, { backend });
    let state = await engine.start("Add a greeting feature");
    state = await engine.advance(state.runId);
    expect(state.phase).toBe("awaiting_input");
    const reflectQuestion = state.questions.find((item) => item.id === state.activeQuestionId);
    expect(reflectQuestion?.purpose).toBe("reflect");
    expect(reflectQuestion?.draftAnswer).toContain("Add a greeting feature");

    state = await engine.answer(
      state.runId,
      reflectQuestion!.id,
      "Confirmed brief: casual greeting feature.",
    );
    expect(state.phase).toBe("grilling");
    expect(state.reflectBrief?.confirmed).toContain("Confirmed brief");

    state = await engine.advance(state.runId);
    expect(state.phase).toBe("awaiting_input");
    const grillQuestion = state.questions.find((item) => item.id === state.activeQuestionId);
    expect(grillQuestion?.purpose).toBe("grill");
    expect(grillQuestion?.prompt).toContain("formal or casual");

    state = await engine.answer(state.runId, grillQuestion!.id, "Casual");
    state = await engine.advance(state.runId);
    expect(state.phase).toBe("awaiting_input");
    expect(state.grillReady?.summary).toBeTruthy();
    state = await confirmGrillAndAdvance(engine, state.runId);
    expect(state.phase).toBe("completed");
    expect(state.grillResolutions.length).toBeGreaterThan(0);
    expect(state.tasks[0]?.status).toBe("done");

    const brief = await readFile(
      path.join(root, ".agent-harness", "runs", state.runId, "brief.md"),
      "utf8",
    );
    expect(brief).toContain("Confirmed brief");
  });

  it("reopens grilling from the grillReady gate when feedback is provided", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { tdd: false, maxGrillQuestionsPerEpisode: 5 } as never,
    });
    let grillCalls = 0;
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
      griller: () => {
        grillCalls += 1;
        if (grillCalls === 1) {
          return {
            status: "ready_to_plan",
            summary: "Seemed ready",
            resolutions: [],
            openUnknowns: [],
          };
        }
        return {
          status: "needs_input",
          summary: "Need more after feedback",
          questions: [FIRST_GRILL_QUESTION],
          openUnknowns: [],
        };
      },
      planner: createPlannerPrdSequence().planner,
      "issue-slicer": () => ({
        summary: "One task",
        tasks: [
          {
            id: "greet",
            title: "Ship greeting",
            description: "Render the casual greeting.",
            acceptanceCriteria: ["Greeting is casual"],
            blockedBy: [],
            tdd: false,
          },
        ],
        proposedInstalls: [],
      }),
      implementer: () => ({ summary: "Built", changedFiles: ["src/greet.ts"] }),
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "message-writer": () => ({ subject: "feat: greet", body: "ok" }),
    });

    const engine = new HarnessEngine(config, { backend });
    let state = await engine.start("Greeting with reopen");
    state = await engine.advance(state.runId);
    state = await engine.answer(state.runId, state.activeQuestionId!, "Confirmed brief");
    state = await engine.advance(state.runId);
    expect(state.phase).toBe("awaiting_input");
    expect(state.grillReady?.summary).toBe("Seemed ready");

    state = await engine.confirmGrill(state.runId, {
      feedback: "Please also decide the greeting length",
    });
    expect(state.phase).toBe("grilling");
    expect(state.grillReady).toBeUndefined();
    expect(state.operatorNotes.some((note) => note.text.includes("greeting length"))).toBe(true);
    expect(
      state.openUnknowns.some(
        (unknown) => unknown.status === "fog" && unknown.title.includes("greeting length"),
      ),
    ).toBe(true);

    const events = await readFile(
      path.join(root, ".agent-harness", "runs", state.runId, "events.jsonl"),
      "utf8",
    );
    expect(events).toContain("grill.ready");
    expect(events).toContain("grill.reopened");
    expect(events).not.toContain("grill.completed");

    state = await engine.advance(state.runId);
    expect(state.phase).toBe("awaiting_input");
    expect(state.activeQuestionId).toBeTruthy();
    expect(grillCalls).toBe(2);
  });

  it("rolls the grill episode after the configured question block", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { tdd: false, maxGrillQuestionsPerEpisode: 1 } as never,
    });
    const requests: AgentRequest[] = [];
    let grillCalls = 0;
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
      griller: (request) => {
        requests.push(request);
        grillCalls += 1;
        if (grillCalls === 1) {
          return { status: "needs_input", summary: "Q1", questions: [FIRST_GRILL_QUESTION] };
        }
        if (grillCalls === 2) {
          return {
            status: "needs_input",
            summary: "Q2",
            questions: [
              {
                ...FIRST_GRILL_QUESTION,
                prompt: "Should copy be short or long?",
                recommendedOptionId: "formal",
                recommendation: "Keep it short.",
              },
            ],
          };
        }
        return {
          status: "ready_to_plan",
          summary: "Done grilling",
          resolutions: [],
        };
      },
      planner: createPlannerPrdSequence().planner,
      "issue-slicer": () => ({
        summary: "One task",
        tasks: [
          {
            id: "greet",
            title: "Ship greeting",
            description: "Render the casual greeting.",
            acceptanceCriteria: ["Greeting is casual"],
            blockedBy: [],
            tdd: false,
          },
        ],
        proposedInstalls: [],
      }),
      implementer: () => ({ summary: "Built", changedFiles: ["src/greet.ts"] }),
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "message-writer": () => ({ subject: "feat: greet", body: "ok" }),
    });

    const engine = new HarnessEngine(config, { backend });
    let state = await engine.start("Greeting");
    state = await engine.advance(state.runId);
    const reflectId = state.activeQuestionId!;
    state = await engine.answer(state.runId, reflectId, "Confirmed brief");
    state = await engine.advance(state.runId);
    const firstGrillId = state.activeQuestionId!;
    state = await engine.answer(state.runId, firstGrillId, "Casual");
    state = await engine.advance(state.runId);
    expect(state.phase).toBe("awaiting_input");
    expect(state.grillEpisode?.number).toBeGreaterThanOrEqual(1);

    const secondGrillId = state.activeQuestionId!;
    state = await engine.answer(state.runId, secondGrillId, "Short");
    state = await engine.advance(state.runId);

    const events = await readFile(
      path.join(root, ".agent-harness", "runs", state.runId, "events.jsonl"),
      "utf8",
    );
    expect(events).toContain("grill.episode_rolled");
  });

  it("cold-starts the griller when an answer is older than the stale threshold", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { tdd: false, staleAnswerMinutes: 30, maxGrillQuestionsPerEpisode: 5 } as never,
    });
    const requests: AgentRequest[] = [];
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
      griller: (request) => {
        requests.push(request);
        if (request.providerSessionId) {
          return {
            status: "needs_input",
            summary: "first",
            questions: [FIRST_GRILL_QUESTION],
          };
        }
        if (String(request.prompt).includes("stale_answer") || String(request.prompt).includes("Casual")) {
          expect(request.providerSessionId).toBeUndefined();
          return {
            status: "ready_to_plan",
            summary: "Recovered from stale answer",
            resolutions: [],
          };
        }
        return {
          status: "needs_input",
          summary: "first",
          questions: [FIRST_GRILL_QUESTION],
        };
      },
      planner: createPlannerPrdSequence().planner,
      "issue-slicer": () => ({
        summary: "One task",
        tasks: [
          {
            id: "greet",
            title: "Ship greeting",
            description: "Render the casual greeting.",
            acceptanceCriteria: ["Greeting is casual"],
            blockedBy: [],
            tdd: false,
          },
        ],
        proposedInstalls: [],
      }),
      implementer: () => ({ summary: "Built", changedFiles: ["src/greet.ts"] }),
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "message-writer": () => ({ subject: "feat: greet", body: "ok" }),
    });

    const engine = new HarnessEngine(config, { backend });
    let state = await engine.start("Greeting");
    state = await engine.advance(state.runId);
    state = await engine.answer(state.runId, state.activeQuestionId!, "Confirmed brief");
    state = await engine.advance(state.runId);

    const questionId = state.activeQuestionId!;
    const askedAt = new Date(Date.now() - 31 * 60_000).toISOString();
    state = {
      ...state,
      questions: state.questions.map((item) =>
        item.id === questionId ? { ...item, askedAt } : item,
      ),
    };
    await engine.store.writeJson(state.runId, "state.json", state);

    state = await engine.answer(state.runId, questionId, "Casual");
    const events = await readFile(
      path.join(root, ".agent-harness", "runs", state.runId, "events.jsonl"),
      "utf8",
    );
    expect(events).toContain("grill.episode_stale_reset");
    state = await engine.advance(state.runId);
    expect(state.grillReady?.summary).toBeTruthy();
    state = await confirmGrillAndAdvance(engine, state.runId);
    expect(["planning", "executing", "publishing", "completed"]).toContain(state.phase);
  });

  it("blocks a hung reflector and retries from the persisted phase", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      agent: { timeoutMs: 20 } as never,
      workflow: { maxProviderRetries: 0 } as never,
    });
    const backend = createFakeBackend({
      reflector: () => new Promise(() => undefined),
    });
    const engine = new HarnessEngine(config, { backend, sleep: async () => undefined });
    let state = await engine.start("Hang");
    state = await engine.advance(state.runId);
    expect(state.phase).toBe("blocked");
    expect(state.blockedFrom).toBe("reflecting");
    expect(state.blockedKind).toBe("provider");
  });

  it("continues with frozen testPathPatterns after a project settings change", async () => {
    const root = await fixtureRoot();
    const configPath = path.join(root, "agent-harness.config.yaml");
    await writeFile(
      configPath,
      [
        "version: 2",
        "repositoryRoot: .",
        "commands:",
        "  verification:",
        "    - id: test",
        '      command: node -e "process.exit(0)"',
        "      timeoutMs: 600000",
        "workflow:",
        "  testPathPatterns:",
        "    - tests/**",
        "",
      ].join("\n"),
      "utf8",
    );
    const config = fixtureConfig(root, {
      workflow: { tdd: false, testPathPatterns: ["tests/**"] } as never,
      commands: { verification: [{ id: "test", command: 'node -e "process.exit(0)"', timeoutMs: 600_000 }] },
    });
    const backend = createFakeBackend({ reflector: () => REFLECT_OUTPUT });
    const engine = new HarnessEngine(config, { backend });
    let state = await engine.start("mid-run test paths");
    const stamped = state.configurationHash;

    await writeProjectSettings(configPath, {
      workflow: { testPathPatterns: ["modules/**/src/test/**"] },
    });
    const project = fixtureConfig(root, {
      workflow: { tdd: false, testPathPatterns: ["modules/**/src/test/**"] } as never,
      commands: { verification: [{ id: "test", command: 'node -e "process.exit(0)"', timeoutMs: 600_000 }] },
    });
    const runConfig = await loadRunConfig(project, state.runId);
    expect(configurationHash(runConfig)).toBe(stamped);
    expect(runConfig.workflow.testPathPatterns).toEqual(["tests/**"]);

    const resumed = new HarnessEngine(runConfig, { backend });
    state = await resumed.advance(state.runId);
    expect(state.blockedKind).not.toBe("config");
    expect(state.phase).toBe("awaiting_input");
    expect(resumed.config.workflow.testPathPatterns).toEqual(["tests/**"]);
  });

  it("continues after mid-run verification change via frozen snapshot isolation", async () => {
    const root = await fixtureRoot();
    const configPath = path.join(root, "agent-harness.config.yaml");
    const originalTest = 'node -e "process.exit(0)"';
    await writeFile(
      configPath,
      [
        "version: 2",
        "repositoryRoot: .",
        "commands:",
        "  verification:",
        "    - id: test",
        `      command: ${originalTest}`,
        "      timeoutMs: 600000",
        "workflow:",
        "  testPathPatterns:",
        "    - tests/**",
        "",
      ].join("\n"),
      "utf8",
    );
    const config = fixtureConfig(root, {
      workflow: { tdd: false, testPathPatterns: ["tests/**"] } as never,
      commands: { verification: [{ id: "test", command: originalTest, timeoutMs: 600_000 }] },
    });
    const backend = createFakeBackend({ reflector: () => REFLECT_OUTPUT });
    const engine = new HarnessEngine(config, { backend });
    let state = await engine.start("mid-run hashed command");
    const stamped = state.configurationHash;

    await writeProjectSettings(configPath, {
      commands: { verification: [{ id: "test", command: "./gradlew test", timeoutMs: 600_000 }] },
    });
    const driftedProject = fixtureConfig(root, {
      workflow: { tdd: false, testPathPatterns: ["tests/**"] } as never,
      commands: { verification: [{ id: "test", command: "./gradlew test", timeoutMs: 600_000 }] },
    });
    expect(configurationHash(driftedProject)).not.toBe(stamped);

    const runConfig = await loadRunConfig(driftedProject, state.runId);
    expect(configurationHash(runConfig)).toBe(stamped);
    expect(runConfig.commands.verification[0]?.command).toBe(originalTest);

    const resumed = new HarnessEngine(runConfig, { backend });
    state = await resumed.advance(state.runId);
    expect(state.blockedKind).not.toBe("config");
    expect(state.phase).toBe("awaiting_input");
    expect(resumed.config.commands.verification[0]?.command).toBe(originalTest);
  });

  it("migrates older configVersion runs and refuses same-version hash mismatches", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root);
    const {
      maxGrillQuestionsPerEpisode: _q,
      staleAnswerMinutes: _s,
      ...legacyWorkflow
    } = config.workflow;
    const legacyConfig = { ...config, workflow: legacyWorkflow };
    const hash = createHash("sha256").update(JSON.stringify(legacyConfig)).digest("hex");

    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
    });
    const engine = new HarnessEngine(config, { backend });
    let state = await engine.start("legacy");
    state = { ...state, configurationHash: hash, configVersion: 0 };
    await engine.store.writeJson(state.runId, "state.json", state);
    await engine.store.writeJson(state.runId, "config.json", {
      ...legacyConfig,
      configVersion: 0,
    });

    state = await engine.advance(state.runId);
    expect(state.phase).toBe("awaiting_input");
    expect(state.configVersion).toBe(CONFIG_VERSION);
    expect(state.configurationHash).toBe(configurationHash(config));
    const events = await readFile(
      path.join(root, ".agent-harness", "runs", state.runId, "events.jsonl"),
      "utf8",
    );
    expect(events).toContain("run.config_migrated");

    engine.config.commands.verification = [{ id: "test", command: "./gradlew test", timeoutMs: 600_000 }];
    state = { ...state, configurationHash: "not-the-current-hash", configVersion: CONFIG_VERSION };
    await engine.store.writeJson(state.runId, "state.json", state);
    state = await engine.advance(state.runId);
    expect(state.phase).toBe("blocked");
    expect(state.failure).toMatch(/configuration changed/i);
    expect(state.blockedKind).toBe("config");
    expect(state.blockedRetriable).toBe(false);
  });

  it("hashes policy only so repositoryRoot moves migrate and resume cleanly", async () => {
    const rootA = await fixtureRoot();
    const rootB = await fixtureRoot();
    const configA = fixtureConfig(rootA, {
      workflow: { tdd: false } as never,
      knowledge: {
        ...fixtureConfig(rootA).knowledge,
        sharedIndexDirectory: path.join(rootA, "shared-a"),
      },
      stateDirectory: ".agent-harness-a",
    });
    const configB = fixtureConfig(rootB, {
      workflow: { tdd: false } as never,
      knowledge: {
        ...fixtureConfig(rootB).knowledge,
        sharedIndexDirectory: path.join(rootB, "shared-b"),
      },
      stateDirectory: ".agent-harness-b",
    });
    expect(configA.repositoryRoot).not.toBe(configB.repositoryRoot);
    expect(configA.stateDirectory).not.toBe(configB.stateDirectory);
    expect(configA.knowledge.sharedIndexDirectory).not.toBe(configB.knowledge.sharedIndexDirectory);

    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
    });
    const engineA = new HarnessEngine(configA, { backend });
    const engineB = new HarnessEngine(configB, { backend });
    let stateA = await engineA.start("moved-repo");
    const stateB = await engineB.start("fresh-at-b");
    expect(stateA.configurationHash).toBe(stateB.configurationHash);

    const fromRun = path.join(rootA, configA.stateDirectory, "runs", stateA.runId);
    const toRun = path.join(rootB, configB.stateDirectory, "runs", stateA.runId);
    await mkdir(path.dirname(toRun), { recursive: true });
    await cp(fromRun, toRun, { recursive: true });

    // Simulate a pre-canonicalisation run that needs CONFIG_VERSION migration after the move.
    stateA = {
      ...stateA,
      configVersion: 0,
      configurationHash: "legacy-pre-canonical-hash",
    };
    await engineB.store.writeJson(stateA.runId, "state.json", stateA);

    const advanced = await engineB.advance(stateA.runId);
    expect(advanced.configVersion).toBe(CONFIG_VERSION);
    expect(advanced.configurationHash).toBe(stateB.configurationHash);
    expect(advanced.phase).toBe("awaiting_input");
    expect(advanced.blockedKind).not.toBe("config");
    const events = await readFile(path.join(toRun, "events.jsonl"), "utf8");
    expect(events).toContain("run.config_migrated");
  });

  it("repairs invalid grill JSON on the same provider session", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      agent: { schemaRepairAttempts: 1, promptBuilder: false } as never,
      workflow: { tdd: false } as never,
    });
    let grillAttempts = 0;
    const backend: ReturnType<typeof createFakeBackend> = {
      async run(request) {
        if (request.role === "reflector") {
          return {
            output: REFLECT_OUTPUT,
            providerSessionId: "grill-agent",
            providerRunId: "run-1",
            providerSessionReused: false,
            submittedPrompt: request.prompt,
          };
        }
        if (request.role === "griller") {
          grillAttempts += 1;
          if (grillAttempts === 1) {
            return {
              output: "not-json",
              providerSessionId: "grill-agent",
              providerRunId: "run-bad",
              providerSessionReused: Boolean(request.providerSessionId),
              submittedPrompt: request.continuationPrompt ?? request.prompt,
            };
          }
          return {
            output: {
              status: "needs_input",
              summary: "Recovered",
              questions: [FIRST_GRILL_QUESTION],
            },
            providerSessionId: "grill-agent",
            providerRunId: "run-good",
            providerSessionReused: true,
            submittedPrompt: request.continuationPrompt ?? request.prompt,
          };
        }
        throw new Error(`Unexpected role ${request.role}`);
      },
      async release() {},
    };

    const engine = new HarnessEngine(config, { backend });
    let state = await engine.start("Repair");
    state = await engine.advance(state.runId);
    state = await engine.answer(state.runId, state.activeQuestionId!, "Confirmed brief");
    state = await engine.advance(state.runId);
    expect(state.phase).toBe("awaiting_input");
    expect(grillAttempts).toBe(2);

    const sessions = await readdir(
      path.join(root, ".agent-harness", "runs", state.runId, "sessions"),
    );
    const records = await Promise.all(
      sessions.map(async (file) =>
        JSON.parse(
          await readFile(
            path.join(root, ".agent-harness", "runs", state.runId, "sessions", file),
            "utf8",
          ),
        ),
      ),
    );
    const failed = records.find((item) => item.status === "failed");
    const repaired = records.find(
      (item) => item.status === "completed" && item.role === "griller",
    );
    expect(failed?.providerSessionId).toBe("grill-agent");
    expect(repaired?.providerSessionId).toBe("grill-agent");
  });

  it("skips retrieval for message-writer and uses deterministic commit subjects by default", async () => {
    const root = await fixtureRoot();
    await writeFile(path.join(root, "docs", "guide.md"), "# Guide\nSettlementWindow refunds\n", "utf8");
    const config = fixtureConfig(root, {
      workflow: {
        ...fixtureConfig(root).workflow,
        tdd: false,
        generateCommitMessages: false,
      },
    });
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
      griller: () => ({
        status: "ready_to_plan",
        summary: "Ready",
        resolutions: [
          {
            id: "tone",
            question: FIRST_GRILL_QUESTION.prompt,
            answer: "Casual",
            summary: "Casual",
          },
        ],
      }),
      planner: createPlannerPrdSequence().planner,
      "issue-slicer": () => ({
        summary: "One task",
        tasks: [
          {
            id: "greet",
            title: "Ship greeting",
            description: "Render the casual greeting.",
            acceptanceCriteria: ["Greeting is casual"],
            blockedBy: [],
            tdd: false,
          },
        ],
        proposedInstalls: [],
      }),
      implementer: () => ({ summary: "Built", changedFiles: ["src/greet.ts"] }),
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "message-writer": () => ({ subject: "should-not-be-used", body: "nope" }),
    });
    const engine = new HarnessEngine(config, { backend });
    let state = await engine.start("Add greeting");
    state = await engine.advance(state.runId);
    state = await engine.answer(state.runId, state.activeQuestionId!, "Confirmed brief");
    state = await engine.advance(state.runId);
    expect(state.grillReady?.summary).toBeTruthy();
    state = await confirmGrillAndAdvance(engine, state.runId);
    expect(state.phase).toBe("completed");

    const packetFiles = await readdir(
      path.join(root, ".agent-harness", "runs", state.runId, "packets"),
    );
    const messagePackets = [];
    for (const file of packetFiles) {
      if (!file.endsWith(".json") || file.includes(".retrieval.") || file.includes(".guidance.")) {
        continue;
      }
      const packet = JSON.parse(
        await readFile(
          path.join(root, ".agent-harness", "runs", state.runId, "packets", file),
          "utf8",
        ),
      ) as { role?: string; guidance?: unknown[]; context?: unknown[] };
      if (packet.role === "message-writer") messagePackets.push(packet);
    }
    // Commit messages are deterministic by default, so only the PR body uses message-writer.
    expect(messagePackets.length).toBeGreaterThanOrEqual(1);
    for (const packet of messagePackets) {
      expect(packet.guidance).toEqual([]);
      expect(packet.context).toEqual([]);
    }
  });

  it("prepares Graphify on start and blocks with a readable failure", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      knowledge: {
        ...fixtureConfig(root).knowledge,
        graphify: { ...fixtureConfig(root).knowledge.graphify, enabled: true },
      },
    });
    const runner = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "graphify missing",
      timedOut: false,
    });
    const engine = new HarnessEngine(config, {
      backend: createFakeBackend({}),
      graphifyRunner: runner,
    });
    const state = await engine.start("Needs graph");
    expect(state.phase).toBe("blocked");
    expect(state.failure).toMatch(/Graphify|graphifyy/i);
  });

  it("routes implementers that touch recorded test files back to repair", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: {
        ...fixtureConfig(root).workflow,
        tdd: true,
        maxImplementationAttempts: 1,
        generateCommitMessages: false,
      },
      commands: {
        verification: [{ id: "test", command: 'node -e "process.exit(process.env.HARNESS_FORCE_RED ? 1 : 0)"', timeoutMs: 600_000 }],
        passEnv: ["HARNESS_FORCE_RED"],
      },
    });
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
      griller: () => ({
        status: "ready_to_plan",
        summary: "Ready",
        resolutions: [],
      }),
      planner: createPlannerPrdSequence().planner,
      "issue-slicer": () => ({
        summary: "One task",
            tasks: [
              {
                id: "greet",
                title: "Ship greeting",
                description: "Render the casual greeting.",
                acceptanceCriteria: ["Greeting is casual"],
                blockedBy: [],
              },
            ],
        proposedInstalls: [],
      }),
      "red-writer": () => {
        process.env.HARNESS_FORCE_RED = "1";
        return {
          status: "continue",
          summary: "wrote test",
          changedFiles: ["tests/greet.test.ts"],
          behaviorsAdded: ["greeting fails until implemented"],
          edgeCasesAdded: [],
        };
      },
      implementer: () => {
        delete process.env.HARNESS_FORCE_RED;
        return {
          status: "green",
          summary: "weakened test",
          changedFiles: ["src/greet.ts", "tests/greet.test.ts"],
        };
      },
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "message-writer": () => ({ subject: "feat: greet", body: "ok" }),
    });
    const engine = new HarnessEngine(config, { backend });
    let state = await engine.start("Add greeting");
    state = await engine.advance(state.runId);
    state = await engine.answer(state.runId, state.activeQuestionId!, "Confirmed brief");
    state = await engine.advance(state.runId);
    expect(state.grillReady?.summary).toBeTruthy();
    state = await confirmGrillAndAdvance(engine, state.runId);
    expect(state.phase).toBe("blocked");
    expect(state.tasks[0]?.failure).toMatch(/test files/i);
    const events = await readFile(
      path.join(root, ".agent-harness", "runs", state.runId, "events.jsonl"),
      "utf8",
    );
    expect(events).toContain("task.implementation_test_tamper");
  });

  it("guards test-path tamper even when targeted tests fail", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: {
        ...fixtureConfig(root).workflow,
        tdd: true,
        maxImplementationAttempts: 3,
        generateCommitMessages: false,
      },
      commands: {
        verification: [{ id: "test", command: 'node -e "process.exit(process.env.HARNESS_FORCE_RED ? 1 : 0)"', timeoutMs: 600_000 }],
        passEnv: ["HARNESS_FORCE_RED"],
      },
    });
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
      griller: () => ({
        status: "ready_to_plan",
        summary: "Ready",
        resolutions: [],
      }),
      planner: createPlannerPrdSequence().planner,
      "issue-slicer": () => ({
        summary: "One task",
            tasks: [
              {
                id: "greet",
                title: "Ship greeting",
                description: "Render the casual greeting.",
                acceptanceCriteria: ["Greeting is casual"],
                blockedBy: [],
              },
            ],
        proposedInstalls: [],
      }),
      "red-writer": () => {
        process.env.HARNESS_FORCE_RED = "1";
        return {
          status: "continue",
          summary: "wrote test",
          changedFiles: ["tests/greet.test.ts"],
          behaviorsAdded: ["greeting fails until implemented"],
          edgeCasesAdded: [],
        };
      },
      implementer: () => ({
        status: "green",
        summary: "touched test while still red",
        changedFiles: ["src/greet.ts", "tests/greet.test.ts"],
      }),
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "message-writer": () => ({ subject: "feat: greet", body: "ok" }),
    });
    const engine = new HarnessEngine(config, { backend });
    let state = await engine.start("Add greeting");
    state = await engine.advance(state.runId);
    state = await engine.answer(state.runId, state.activeQuestionId!, "Confirmed brief");
    // grill → grillReady gate, then plan + writeTests + first implement.
    state = await engine.advance(state.runId);
    expect(state.grillReady?.summary).toBeTruthy();
    state = await engine.confirmGrill(state.runId);
    state = await engine.advance(state.runId);
    expect(state.verificationReady?.summary).toBeTruthy();
    state = await engine.confirmVerification(state.runId, {
      patch: state.verificationReady!.proposedPatch,
    });
    state = await engine.advance(state.runId);
    expect(state.planReady?.summary).toBeTruthy();
    state = await engine.confirmPlan(state.runId);
    state = await engine.advance(state.runId);
    const task = state.tasks[0];
    expect(task?.evidence.some((entry) => entry.purpose === "guard:test-tamper")).toBe(true);
    expect(
      task?.reviewSummary ?? task?.failure ?? "",
    ).toMatch(/tests\/greet\.test\.ts/);
    delete process.env.HARNESS_FORCE_RED;
  });

  it("resolves a batch of independent questions in a single griller invocation", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { tdd: false, grillQuestionsPerBatch: 3 } as never,
    });
    let grillCalls = 0;
    const batchQuestions = [
      { ...FIRST_GRILL_QUESTION, prompt: "Q1: formal or casual?", unknownId: "tone" },
      {
        ...FIRST_GRILL_QUESTION,
        prompt: "Q2: short or long?",
        unknownId: "length",
      },
      {
        ...FIRST_GRILL_QUESTION,
        prompt: "Q3: emoji or plain?",
        unknownId: "emoji",
      },
    ];
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
      griller: (request) => {
        grillCalls += 1;
        if (grillCalls === 1) {
          return {
            status: "needs_input",
            summary: "Batching independent decisions",
            questions: batchQuestions,
            openUnknowns: [
              { id: "tone", title: "Tone", impact: "shaping" },
              { id: "length", title: "Length", impact: "shaping" },
              { id: "emoji", title: "Emoji", impact: "minor" },
            ],
          };
        }
        const fullFallbackPrompt = String(request.prompt);
        const continuationPrompt = String(request.continuationPrompt);
        expect(request.providerSessionId).toBeTruthy();
        expect(continuationPrompt).toContain("Formal");
        expect(continuationPrompt).toContain("Short");
        expect(continuationPrompt).toContain("Plain");
        expect(continuationPrompt).not.toContain("Confirmed brief");
        expect(continuationPrompt).not.toContain('"resolutions"');
        expect(continuationPrompt).not.toContain('"openUnknowns"');
        expect(fullFallbackPrompt).toContain("Confirmed brief");
        expect(fullFallbackPrompt).toContain('"resolutions"');
        expect(fullFallbackPrompt).toContain('"openUnknowns"');
        return { status: "ready_to_plan", summary: "All set", resolutions: [], openUnknowns: [] };
      },
      planner: createPlannerPrdSequence().planner,
      "issue-slicer": () => ({
        summary: "One task",
        tasks: [
          {
            id: "greet",
            title: "Ship greeting",
            description: "Render the casual greeting.",
            acceptanceCriteria: ["Greeting is casual"],
            blockedBy: [],
            tdd: false,
          },
        ],
        proposedInstalls: [],
      }),
      implementer: () => ({ summary: "Built", changedFiles: ["src/greet.ts"] }),
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "message-writer": () => ({ subject: "feat: greet", body: "ok" }),
    });

    const engine = new HarnessEngine(config, { backend });
    let state = await engine.start("Greeting");
    state = await engine.advance(state.runId);
    state = await engine.answer(state.runId, state.activeQuestionId!, "Confirmed brief");
    state = await engine.advance(state.runId);
    expect(state.phase).toBe("awaiting_input");
    const batchIds = state.questions.filter((q) => q.purpose === "grill").map((q) => q.id);
    expect(batchIds).toHaveLength(3);
    const batchId = state.questions.find((q) => q.id === batchIds[0])?.batchId;
    expect(state.questions.every((q) => q.purpose !== "grill" || q.batchId === batchId)).toBe(true);

    state = await engine.answerMany(state.runId, [
      { questionId: batchIds[0]!, answer: "Formal" },
      { questionId: batchIds[1]!, answer: "Short" },
      { questionId: batchIds[2]!, answer: "Plain" },
    ]);
    state = await engine.advance(state.runId);
    expect(state.grillReady?.summary).toBeTruthy();
    state = await confirmGrillAndAdvance(engine, state.runId);

    expect(state.phase).toBe("completed");
    expect(grillCalls).toBe(2);
    expect(state.grillResolutions).toHaveLength(3);
    expect(state.grillEpisode?.questionsAnswered).toBe(3);
  });

  it("parks a skipped question without producing a resolution, keeping its unknown parked", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { tdd: false, grillQuestionsPerBatch: 3 } as never,
    });
    let grillCalls = 0;
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
      griller: (request) => {
        grillCalls += 1;
        if (grillCalls === 1) {
          return {
            status: "needs_input",
            summary: "Two decisions",
            questions: [
              { ...FIRST_GRILL_QUESTION, prompt: "Keep: formal or casual?", unknownId: "keep" },
              { ...FIRST_GRILL_QUESTION, prompt: "Skip: formal or casual?", unknownId: "skip" },
            ],
            openUnknowns: [
              { id: "keep", title: "Keep decision", impact: "shaping" },
              { id: "skip", title: "Skip decision", impact: "minor" },
            ],
          };
        }
        const prompt = String(request.prompt);
        expect(prompt).toContain("Kept answer");
        return {
          status: "ready_to_plan",
          summary: "Done, skip left for later",
          resolutions: [],
          // The griller still lists the skipped unknown; it was not re-asked.
          openUnknowns: [{ id: "skip", title: "Skip decision", impact: "minor" }],
        };
      },
      planner: createPlannerPrdSequence().planner,
      "issue-slicer": () => ({
        summary: "One task",
        tasks: [
          {
            id: "greet",
            title: "Ship greeting",
            description: "Render the casual greeting.",
            acceptanceCriteria: ["Greeting is casual"],
            blockedBy: [],
            tdd: false,
          },
        ],
        proposedInstalls: [],
      }),
      implementer: () => ({ summary: "Built", changedFiles: ["src/greet.ts"] }),
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "message-writer": () => ({ subject: "feat: greet", body: "ok" }),
    });

    const engine = new HarnessEngine(config, { backend });
    let state = await engine.start("Greeting");
    state = await engine.advance(state.runId);
    state = await engine.answer(state.runId, state.activeQuestionId!, "Confirmed brief");
    state = await engine.advance(state.runId);
    const keepId = state.questions.find((q) => q.prompt.startsWith("Keep"))!.id;
    const skipId = state.questions.find((q) => q.prompt.startsWith("Skip"))!.id;

    state = await engine.answerMany(state.runId, [{ questionId: keepId, answer: "Kept answer" }], [
      skipId,
    ]);
    expect(state.questions.find((q) => q.id === skipId)?.status).toBe("parked");
    state = await engine.advance(state.runId);
    expect(state.grillReady?.summary).toBeTruthy();
    state = await confirmGrillAndAdvance(engine, state.runId);

    expect(state.phase).toBe("completed");
    expect(state.grillResolutions).toHaveLength(1);
    expect(state.grillResolutions[0]?.id).toBe(keepId);
    expect(state.openUnknowns.find((u) => u.id === "skip")?.status).toBe("parked");
  });

  it("parks a clarified question and seeds an operator note without a resolution", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { tdd: false, grillQuestionsPerBatch: 3 } as never,
    });
    let grillCalls = 0;
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
      griller: (request) => {
        grillCalls += 1;
        if (grillCalls === 1) {
          return {
            status: "needs_input",
            summary: "Two decisions",
            questions: [
              { ...FIRST_GRILL_QUESTION, prompt: "Keep: formal or casual?", unknownId: "keep" },
              { ...FIRST_GRILL_QUESTION, prompt: "Clarify: formal or casual?", unknownId: "clarify" },
            ],
            openUnknowns: [
              { id: "keep", title: "Keep decision", impact: "shaping" },
              { id: "clarify", title: "Clarify decision", impact: "minor" },
            ],
          };
        }
        const prompt = String(request.prompt);
        expect(prompt).toContain("Clarification requested on grill question");
        expect(prompt).toContain("What does formal mean for onboarding copy?");
        return {
          status: "ready_to_plan",
          summary: "Done after clarification",
          resolutions: [],
          openUnknowns: [{ id: "clarify", title: "Clarify decision", impact: "minor" }],
        };
      },
      planner: createPlannerPrdSequence().planner,
      "issue-slicer": () => ({
        summary: "One task",
        tasks: [
          {
            id: "greet",
            title: "Ship greeting",
            description: "Render the casual greeting.",
            acceptanceCriteria: ["Greeting is casual"],
            blockedBy: [],
            tdd: false,
          },
        ],
        proposedInstalls: [],
      }),
      implementer: () => ({ summary: "Built", changedFiles: ["src/greet.ts"] }),
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "message-writer": () => ({ subject: "feat: greet", body: "ok" }),
    });

    const engine = new HarnessEngine(config, { backend });
    let state = await engine.start("Greeting");
    state = await engine.advance(state.runId);
    state = await engine.answer(state.runId, state.activeQuestionId!, "Confirmed brief");
    state = await engine.advance(state.runId);
    const keepId = state.questions.find((q) => q.prompt.startsWith("Keep"))!.id;
    const clarifyId = state.questions.find((q) => q.prompt.startsWith("Clarify"))!.id;

    state = await engine.answerMany(
      state.runId,
      [{ questionId: keepId, answer: "Kept answer" }],
      [],
      [{ questionId: clarifyId, text: "What does formal mean for onboarding copy?" }],
    );
    expect(state.questions.find((q) => q.id === clarifyId)?.status).toBe("parked");
    expect(state.operatorNotes.some((note) => note.text.includes("Clarification requested"))).toBe(
      true,
    );
    expect(
      state.openUnknowns.some((unknown) =>
        unknown.title.includes("What does formal mean for onboarding copy?"),
      ),
    ).toBe(true);

    state = await engine.advance(state.runId);
    expect(state.grillReady?.summary).toBeTruthy();
    state = await confirmGrillAndAdvance(engine, state.runId);
    expect(state.phase).toBe("completed");
    expect(state.grillResolutions).toHaveLength(1);
    expect(state.grillResolutions[0]?.id).toBe(keepId);
  });

  it("computes staleness once per batch and cold-starts the next griller turn", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { tdd: false, staleAnswerMinutes: 30, grillQuestionsPerBatch: 3 } as never,
    });
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
      griller: (request) => {
        const prompt = String(request.prompt);
        if (prompt.includes("\"answer\":\"One\"")) {
          expect(request.providerSessionId).toBeUndefined();
          return { status: "ready_to_plan", summary: "Recovered from stale batch", resolutions: [] };
        }
        return {
          status: "needs_input",
          summary: "first",
          questions: [
            { ...FIRST_GRILL_QUESTION, prompt: "One: formal or casual?" },
            { ...FIRST_GRILL_QUESTION, prompt: "Two: formal or casual?" },
          ],
        };
      },
      planner: createPlannerPrdSequence().planner,
      "issue-slicer": () => ({
        summary: "One task",
        tasks: [
          {
            id: "greet",
            title: "Ship greeting",
            description: "Render the casual greeting.",
            acceptanceCriteria: ["Greeting is casual"],
            blockedBy: [],
            tdd: false,
          },
        ],
        proposedInstalls: [],
      }),
      implementer: () => ({ summary: "Built", changedFiles: ["src/greet.ts"] }),
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "message-writer": () => ({ subject: "feat: greet", body: "ok" }),
    });

    const engine = new HarnessEngine(config, { backend });
    let state = await engine.start("Greeting");
    state = await engine.advance(state.runId);
    state = await engine.answer(state.runId, state.activeQuestionId!, "Confirmed brief");
    state = await engine.advance(state.runId);

    const grillIds = state.questions.filter((q) => q.purpose === "grill").map((q) => q.id);
    expect(grillIds).toHaveLength(2);
    const askedAt = new Date(Date.now() - 31 * 60_000).toISOString();
    state = {
      ...state,
      questions: state.questions.map((item) =>
        grillIds.includes(item.id) ? { ...item, askedAt } : item,
      ),
    };
    await engine.store.writeJson(state.runId, "state.json", state);

    state = await engine.answerMany(state.runId, [
      { questionId: grillIds[0]!, answer: "One" },
      { questionId: grillIds[1]!, answer: "Two" },
    ]);
    const events = await readFile(
      path.join(root, ".agent-harness", "runs", state.runId, "events.jsonl"),
      "utf8",
    );
    // One stale-reset event for the whole batch, not one per question.
    expect(events.match(/grill\.episode_stale_reset/g)?.length).toBe(1);
    state = await engine.advance(state.runId);
    expect(state.grillReady?.summary).toBeTruthy();
    state = await confirmGrillAndAdvance(engine, state.runId);
    expect(["planning", "executing", "publishing", "completed"]).toContain(state.phase);
  });

  it("stamps each grillResolution with its own resolutionSummaries entry", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { tdd: false, grillQuestionsPerBatch: 3 } as never,
    });
    let grillCalls = 0;
    let resolutionSummaries: Array<{ questionId: string; summary: string }> = [];
    const batchQuestions = [
      { ...FIRST_GRILL_QUESTION, prompt: "Q1: formal or casual?", unknownId: "tone" },
      { ...FIRST_GRILL_QUESTION, prompt: "Q2: short or long?", unknownId: "length" },
      { ...FIRST_GRILL_QUESTION, prompt: "Q3: emoji or plain?", unknownId: "emoji" },
    ];
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
      griller: () => {
        grillCalls += 1;
        if (grillCalls === 1) {
          return {
            status: "needs_input",
            summary: "Batching independent decisions",
            questions: batchQuestions,
            openUnknowns: [
              { id: "tone", title: "Tone", impact: "shaping" },
              { id: "length", title: "Length", impact: "shaping" },
              { id: "emoji", title: "Emoji", impact: "minor" },
            ],
          };
        }
        return {
          status: "ready_to_plan",
          summary: "Turn-level wrap-up of the batch",
          resolutionSummaries,
          resolutions: [],
          openUnknowns: [],
        };
      },
      planner: createPlannerPrdSequence().planner,
      "issue-slicer": () => ({
        summary: "One task",
        tasks: [
          {
            id: "greet",
            title: "Ship greeting",
            description: "Render the casual greeting.",
            acceptanceCriteria: ["Greeting is casual"],
            blockedBy: [],
            tdd: false,
          },
        ],
        proposedInstalls: [],
      }),
      implementer: () => ({ summary: "Built", changedFiles: ["src/greet.ts"] }),
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "message-writer": () => ({ subject: "feat: greet", body: "ok" }),
    });

    const engine = new HarnessEngine(config, { backend });
    let state = await engine.start("Greeting");
    state = await engine.advance(state.runId);
    state = await engine.answer(state.runId, state.activeQuestionId!, "Confirmed brief");
    state = await engine.advance(state.runId);
    const ids = state.questions.filter((q) => q.purpose === "grill").map((q) => q.id);
    expect(ids).toHaveLength(3);

    resolutionSummaries = [
      { questionId: ids[0]!, summary: "Settled on formal tone" },
      { questionId: ids[1]!, summary: "Settled on short copy" },
      { questionId: ids[2]!, summary: "Settled on plain text without emoji" },
    ];
    state = await engine.answerMany(state.runId, [
      { questionId: ids[0]!, answer: "Formal" },
      { questionId: ids[1]!, answer: "Short" },
      { questionId: ids[2]!, answer: "Plain" },
    ]);
    state = await engine.advance(state.runId);

    expect(state.grillResolutions).toHaveLength(3);
    const byId = new Map(state.grillResolutions.map((item) => [item.id, item.summary]));
    expect(byId.get(ids[0]!)).toBe("Settled on formal tone");
    expect(byId.get(ids[1]!)).toBe("Settled on short copy");
    expect(byId.get(ids[2]!)).toBe("Settled on plain text without emoji");
    expect(new Set(byId.values()).size).toBe(3);
  });

  it("falls back to the turn summary when resolutionSummaries is omitted", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { tdd: false, grillQuestionsPerBatch: 3 } as never,
    });
    let grillCalls = 0;
    const batchQuestions = [
      { ...FIRST_GRILL_QUESTION, prompt: "Q1: formal or casual?", unknownId: "tone" },
      { ...FIRST_GRILL_QUESTION, prompt: "Q2: short or long?", unknownId: "length" },
      { ...FIRST_GRILL_QUESTION, prompt: "Q3: emoji or plain?", unknownId: "emoji" },
    ];
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
      griller: () => {
        grillCalls += 1;
        if (grillCalls === 1) {
          return {
            status: "needs_input",
            summary: "Batching independent decisions",
            questions: batchQuestions,
            openUnknowns: [
              { id: "tone", title: "Tone", impact: "shaping" },
              { id: "length", title: "Length", impact: "shaping" },
              { id: "emoji", title: "Emoji", impact: "minor" },
            ],
          };
        }
        // Intentionally omit resolutionSummaries — weaker models may do this.
        return {
          status: "ready_to_plan",
          summary: "Shared turn summary for the whole batch",
          resolutions: [],
          openUnknowns: [],
        };
      },
      planner: createPlannerPrdSequence().planner,
      "issue-slicer": () => ({
        summary: "One task",
        tasks: [
          {
            id: "greet",
            title: "Ship greeting",
            description: "Render the casual greeting.",
            acceptanceCriteria: ["Greeting is casual"],
            blockedBy: [],
            tdd: false,
          },
        ],
        proposedInstalls: [],
      }),
      implementer: () => ({ summary: "Built", changedFiles: ["src/greet.ts"] }),
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "message-writer": () => ({ subject: "feat: greet", body: "ok" }),
    });

    const engine = new HarnessEngine(config, { backend });
    let state = await engine.start("Greeting");
    state = await engine.advance(state.runId);
    state = await engine.answer(state.runId, state.activeQuestionId!, "Confirmed brief");
    state = await engine.advance(state.runId);
    const ids = state.questions.filter((q) => q.purpose === "grill").map((q) => q.id);
    state = await engine.answerMany(state.runId, [
      { questionId: ids[0]!, answer: "Formal" },
      { questionId: ids[1]!, answer: "Short" },
      { questionId: ids[2]!, answer: "Plain" },
    ]);
    state = await engine.advance(state.runId);

    expect(state.grillResolutions).toHaveLength(3);
    expect(state.grillResolutions.map((item) => item.summary)).toEqual([
      "Shared turn summary for the whole batch",
      "Shared turn summary for the whole batch",
      "Shared turn summary for the whole batch",
    ]);
  });

  it("reuses the implementer session across one review repair with continuation findings", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: {
        ...fixtureConfig(root).workflow,
        tdd: false,
        maxReviewAttempts: 2,
        maxImplementationAttempts: 3,
        generateCommitMessages: false,
      },
      agent: { ...fixtureConfig(root).agent, promptBuilder: false },
    });
    const implementerRequests: AgentRequest[] = [];
    const reviewerSessionIds: string[] = [];
    const implementerSessionIds: string[] = [];
    const released: string[] = [];
    let reviewCalls = 0;
    const inner = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
      griller: () => ({
        status: "ready_to_plan",
        summary: "Ready",
        resolutions: [],
      }),
      planner: createPlannerPrdSequence().planner,
      "issue-slicer": () => ({
        summary: "One task",
        tasks: [
          {
            id: "greet",
            title: "Ship greeting",
            description: "Render the casual greeting.",
            acceptanceCriteria: ["Greeting is casual"],
            blockedBy: [],
            tdd: false,
          },
        ],
        proposedInstalls: [],
      }),
      implementer: (request) => {
        implementerRequests.push(request);
        return { summary: "Built", changedFiles: ["src/greet.ts"] };
      },
      reviewer: () => {
        reviewCalls += 1;
        if (reviewCalls === 1) {
          return {
            approved: false,
            summary: "Needs a null check",
            findings: [
              {
                severity: "blocking",
                kind: "production",
                message: "Handle null input",
              },
            ],
          };
        }
        return { approved: true, summary: "ok", findings: [] };
      },
      "message-writer": () => ({ subject: "feat: greet", body: "ok" }),
    });
    const backend: AgentBackend = {
      async run(request) {
        const result = await inner.run(request);
        if (request.role === "implementer" && result.providerSessionId) {
          implementerSessionIds.push(result.providerSessionId);
        }
        if (request.role === "reviewer" && result.providerSessionId) {
          reviewerSessionIds.push(result.providerSessionId);
        }
        return result;
      },
      async release(providerSessionId) {
        released.push(providerSessionId);
        await inner.release?.(providerSessionId);
      },
    };

    const engine = new HarnessEngine(config, { backend });
    let state = await engine.start("Add greeting");
    state = await engine.advance(state.runId);
    state = await engine.answer(state.runId, state.activeQuestionId!, "Confirmed brief");
    state = await engine.advance(state.runId);
    expect(state.grillReady?.summary).toBeTruthy();
    state = await confirmGrillAndAdvance(engine, state.runId);

    expect(state.phase).toBe("completed");
    expect(implementerRequests).toHaveLength(2);
    expect(implementerRequests[0]?.mode).toBe("agent");
    expect(implementerRequests[1]?.mode).toBe("agent");
    expect(implementerRequests[0]?.providerSessionId).toBeUndefined();
    expect(implementerRequests[1]?.providerSessionId).toBe(implementerSessionIds[0]);
    expect(implementerRequests[1]?.continuationPrompt).toContain("Handle null input");
    expect(implementerRequests[1]?.continuationPrompt).toContain(
      "The only new authoritative input since the previous turn is:",
    );

    for (const reviewerId of reviewerSessionIds) {
      expect(reviewerId).not.toBe(implementerSessionIds[0]);
    }
    expect(released).toContain(implementerSessionIds[0]);
    expect(state.tasks[0]?.tddLoop?.greenImplementerSession).toBeUndefined();
  });

  it("cold-starts the implementer when a run resumes without in-process session handles", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: {
        ...fixtureConfig(root).workflow,
        tdd: false,
        maxReviewAttempts: 2,
        maxImplementationAttempts: 3,
        generateCommitMessages: false,
      },
      agent: { ...fixtureConfig(root).agent, promptBuilder: false },
    });
    const aliveSessions = new Set<string>();
    let implementerCalls = 0;
    const implementerPrompts: Array<{ reused: boolean; prompt: string }> = [];

    const makeBackend = (): AgentBackend => ({
      async run(request) {
        if (request.role === "implementer") {
          implementerCalls += 1;
          let providerSessionId = request.providerSessionId;
          let providerSessionReused = false;
          if (providerSessionId && aliveSessions.has(providerSessionId)) {
            providerSessionReused = true;
          } else {
            providerSessionId = `impl-${implementerCalls}`;
            aliveSessions.add(providerSessionId);
            providerSessionReused = false;
          }
          const submittedPrompt = providerSessionReused
            ? request.continuationPrompt ?? request.prompt
            : request.prompt;
          implementerPrompts.push({ reused: providerSessionReused, prompt: submittedPrompt });
          return {
            output: { summary: "Built", changedFiles: ["src/greet.ts"] },
            providerSessionId,
            providerRunId: `impl-run-${implementerCalls}`,
            providerSessionReused,
            submittedPrompt,
          };
        }
        if (request.role === "reviewer") {
          return {
            output: { approved: true, summary: "ok", findings: [] },
            providerSessionId: "review-1",
            providerRunId: "rev-run-1",
            providerSessionReused: false,
            submittedPrompt: request.prompt,
          };
        }
        throw new Error(`Unexpected role ${request.role}`);
      },
      async release(providerSessionId) {
        aliveSessions.delete(providerSessionId);
      },
    });

    const hash = configurationHash(config);
    let state: RunState = {
      ...createRunState("cold-start-resume", "idea", new Date().toISOString(), hash, CONFIG_VERSION),
      phase: "executing",
      configurationHash: hash,
      reflectBrief: {
        draft: "d",
        confirmed: "Confirmed brief",
        confirmedAt: new Date().toISOString(),
      },
      tasks: [
        {
          id: "greet",
          title: "Ship greeting",
          description: "Render greeting.",
          acceptanceCriteria: ["Works"],
          affectedPaths: [],
          blockedBy: [],
          tdd: false,
          status: "active",
          step: "implementing",
          attempts: { tests: 0, implementation: 1, review: 1 },
          evidence: [],
          testPaths: [],
          changedFiles: ["src/greet.ts"],
          reviewSummary: "Needs a null check\n- Handle null input",
          tddLoop: {
            greenImplementerSession: {
              providerSessionId: "impl-stale",
              guidanceFingerprint: "fp",
              turns: 1,
            },
          },
        },
      ],
    };
    const resumed = new HarnessEngine(config, { backend: makeBackend() });
    await resumed.store.initialize();
    await resumed.store.create(state);
    await resumed.store.writeJson(state.runId, "state.json", state);
    await resumed.store.writeJson(state.runId, "config.json", {
      ...config,
      configVersion: CONFIG_VERSION,
    });

    state = await resumed.advance(state.runId);
    expect(implementerCalls).toBeGreaterThanOrEqual(1);
    expect(implementerPrompts[0]?.reused).toBe(false);
    expect(implementerPrompts[0]?.prompt).not.toContain("New authoritative input");
    expect(implementerPrompts[0]?.prompt).toContain("Ship greeting");
  });

  it("releases both task worker sessions for all tasks on cancel", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: {
        ...fixtureConfig(root).workflow,
        tdd: true,
        maxReviewAttempts: 2,
        generateCommitMessages: false,
      },
      agent: { ...fixtureConfig(root).agent, promptBuilder: false },
    });
    const released: string[] = [];
    const inner = createFakeBackend({
      implementer: () => ({ summary: "Built", changedFiles: ["src/greet.ts"] }),
    });
    const backend: AgentBackend = {
      async run(request) {
        return inner.run(request);
      },
      async release(providerSessionId) {
        released.push(providerSessionId);
        await inner.release?.(providerSessionId);
      },
    };

    const hash = configurationHash(config);
    const greenSessionId = "impl-to-release";
    const redSessionId = "red-to-release";
    let state: RunState = {
      ...createRunState("cancel-sessions", "idea", new Date().toISOString(), hash, CONFIG_VERSION),
      phase: "executing",
      configurationHash: hash,
      reflectBrief: {
        draft: "d",
        confirmed: "confirmed",
        confirmedAt: new Date().toISOString(),
      },
      tasks: [
        {
          id: "greet",
          title: "Ship greeting",
          description: "Render greeting.",
          acceptanceCriteria: ["Works"],
          affectedPaths: [],
          blockedBy: [],
          tdd: true,
          status: "active",
          step: "implementing",
          attempts: { tests: 0, implementation: 1, review: 0 },
          evidence: [],
          testPaths: [],
          changedFiles: ["src/greet.ts"],
          tddLoop: {
            redWriterSession: {
              providerSessionId: redSessionId,
              turns: 2,
            },
            greenImplementerSession: {
              providerSessionId: greenSessionId,
              turns: 1,
            },
          },
        },
      ],
    };
    const engine = new HarnessEngine(config, { backend });
    await engine.store.initialize();
    await engine.store.create(state);
    await engine.store.writeJson(state.runId, "state.json", state);
    await engine.store.writeJson(state.runId, "config.json", {
      ...config,
      configVersion: CONFIG_VERSION,
    });

    const cancelled = await engine.cancel(state.runId);
    expect(cancelled.state.phase).toBe("cancelled");
    expect(released).toContain(greenSessionId);
    expect(released).toContain(redSessionId);
    expect(cancelled.state.tasks[0]?.tddLoop?.greenImplementerSession).toBeUndefined();
    expect(cancelled.state.tasks[0]?.tddLoop?.redWriterSession).toBeUndefined();
  });

  it("rejects every non-test RED edit", async () => {
    const fixture = await createProjectFixture();
    await fixture.initGit();
    const config = fixtureConfig(fixture.root, {
      git: { enabled: true, baseBranch: "main" } as never,
      commands: { verification: [{ id: "test", command: 'node -e "process.exit(1)"', timeoutMs: 600_000 }] } as never,
    });
    const backend = createFakeBackend({
      "red-writer": async (request) => {
        await mkdir(path.join(request.cwd, "tests"), { recursive: true });
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "tests", "ok.test.ts"), "export {};\n", "utf8");
        await writeFile(path.join(request.cwd, "src", "sneaky.ts"), "export {};\n", "utf8");
        return {
          status: "continue",
          summary: "illegal production edit",
          changedFiles: ["tests/ok.test.ts", "src/sneaky.ts"],
          behaviorsAdded: ["sneaky production path"],
          edgeCasesAdded: [],
        };
      },
    });
    const engine = new HarnessEngine(config, { backend });
    const started = await engine.start("Reject non-test RED edit");
    const state = await engine.store.load(started.runId);
    await engine.store.writeJson(started.runId, "state.json", {
      ...state,
      phase: "executing",
      treeFingerprint: await new GitService(config, engine.paths).treeFingerprint(),
      tasks: [
        {
          id: "illegal-non-test",
          title: "Write RED",
          description: "Coverage",
          acceptanceCriteria: ["failing test"],
          affectedPaths: ["src/greet.ts"],
          blockedBy: [],
          tdd: true,
          status: "active",
          step: "writing_tests",
          attempts: { tests: 0, implementation: 0, review: 0 },
          evidence: [],
          testPaths: [],
          changedFiles: [],
        },
      ],
    });

    const advanced = await engine.advance(started.runId);
    expect(advanced.phase).toBe("blocked");
    expect(advanced.failure).toMatch(/non-test paths|Red writer/i);
  });

  it("invokes implementer on first implementing attempt even for missing-symbol evidence", async () => {
    const fixture = await createProjectFixture();
    await fixture.initGit();
    const config = fixtureConfig(fixture.root, {
      git: { enabled: true, baseBranch: "main" } as never,
      workflow: { tdd: true, maxImplementationAttempts: 2 } as never,
      commands: {
        verification: [{ id: "test", command: 'node -e "process.exit(1)"', timeoutMs: 600_000 }],
      } as never,
    });
    let implementerCalls = 0;
    const backend = createFakeBackend({
      implementer: async (request) => {
        implementerCalls += 1;
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(
          path.join(request.cwd, "src", "greet.ts"),
          'export const greet = () => "hi";\n',
          "utf8",
        );
        return { status: "green", summary: "implemented", changedFiles: ["src/greet.ts"] };
      },
      "red-writer": () => {
        throw new Error("red-writer must not run during implementing");
      },
    });
    const engine = new HarnessEngine(config, { backend });
    const started = await engine.start("No false repair");
    const state = await engine.store.load(started.runId);
    const missingSymbolEvidence = {
      purpose: "tdd:green",
      command: "npm test",
      exitCode: 1,
      passed: false,
      stdout: "",
      stderr: [
        "tests/GreeterTest.java:12: error: cannot find symbol",
        "  symbol:   class Greeter",
        "  location: class GreeterTest",
        "Compilation failed",
      ].join("\n"),
      durationMs: 10,
      at: new Date().toISOString(),
    };
    await engine.store.writeJson(started.runId, "state.json", {
      ...state,
      phase: "executing",
      treeFingerprint: await new GitService(config, engine.paths).treeFingerprint(),
      tasks: [
        {
          id: "no-false-repair",
          title: "Ship greeting",
          description: "Render greeting",
          acceptanceCriteria: ["greeting works"],
          affectedPaths: ["src/greet.ts"],
          blockedBy: [],
          tdd: true,
          status: "active",
          step: "implementing",
          attempts: { tests: 1, implementation: 0, review: 0 },
          evidence: [missingSymbolEvidence],
          testPaths: ["tests/greet.test.ts"],
          redCheckpointSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          redBaseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          redCheckpointPaths: ["tests/greet.test.ts"],
          changedFiles: ["tests/greet.test.ts"],
          tddLoop: {
            round: 1,
            atVerifiedGreen: false,
            pendingRound: {
              number: 1,
              mode: "feature",
              redCheckpointSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              testPathsAdded: ["tests/greet.test.ts"],
              behaviorsAdded: ["greets"],
              edgeCasesAdded: [],
              implementerAttempts: 0,
              startedAt: new Date().toISOString(),
            },
          },
        },
      ],
    });

    await engine.advance(started.runId);
    const events = await readFile(
      path.join(fixture.root, ".agent-harness", "runs", started.runId, "events.jsonl"),
      "utf8",
    );
    expect(events).not.toContain("task.test_repair_routed");
    expect(events).not.toContain("tdd:resume-check");
    // Verification always fails; per-round budget (maxImplementationAttempts: 2) drives retries.
    expect(implementerCalls).toBeGreaterThanOrEqual(1);
    expect(implementerCalls).toBeLessThanOrEqual(2);
  });

  it("never invokes red-writer when task tdd is false", async () => {
    const roles: string[] = [];
    const fixture = await createProjectFixture();
    await fixture.initGit();
    const config = fixtureConfig(fixture.root, {
      git: { enabled: true, baseBranch: "main" } as never,
      workflow: { tdd: false } as never,
      commands: { verification: [{ id: "test", command: 'node -e "process.exit(0)"', timeoutMs: 600_000 }] } as never,
    });
    const backend = createFakeBackend({
      "red-writer": () => {
        roles.push("red-writer");
        throw new Error("red-writer must not run when tdd is false");
      },
      implementer: (request) => {
        roles.push(request.role);
        return { summary: "done", changedFiles: ["src/greet.ts"] };
      },
      reviewer: (request) => {
        roles.push(request.role);
        return { approved: true, summary: "ok", findings: [] };
      },
    });
    const engine = new HarnessEngine(config, { backend });
    const started = await engine.start("No TDD path");
    const state = await engine.store.load(started.runId);
    await engine.store.writeJson(started.runId, "state.json", {
      ...state,
      phase: "executing",
      treeFingerprint: await new GitService(config, engine.paths).treeFingerprint(),
      tasks: [
        {
          id: "no-tdd",
          title: "Ship greeting",
          description: "Render greeting",
          acceptanceCriteria: ["done"],
          affectedPaths: ["src/greet.ts"],
          blockedBy: [],
          tdd: false,
          status: "pending",
          step: "pending",
          attempts: { tests: 0, implementation: 0, review: 0 },
          evidence: [],
          testPaths: [],
          changedFiles: [],
        },
      ],
    });

    const advanced = await engine.advance(started.runId);
    expect(roles).not.toContain("red-writer");
    expect(roles).toContain("implementer");
    expect(advanced.tasks[0]?.step).not.toBe("writing_tests");
  });

  it("completes three RED/GREEN rounds with exactly two provider session IDs", async () => {
    const fixture = await createProjectFixture();
    await fixture.initGit();
    const config = fixtureConfig(fixture.root, {
      git: { enabled: true, baseBranch: "main" } as never,
      workflow: {
        tdd: true,
        maxImplementationAttempts: 3,
        maxTestAttempts: 5,
        generateCommitMessages: false,
      } as never,
      commands: {
        verification: [{ id: "test", command: 'node -e "process.exit(0)"', timeoutMs: 600_000 }],
      } as never,
      agent: { promptBuilder: false } as never,
    });

    let redCalls = 0;
    let greenCalls = 0;
    let reviewCalls = 0;
    const sessionByRole = new Map<string, string>();
    const backend: AgentBackend = {
      async run(request) {
        const existing = request.providerSessionId;
        const providerSessionId = existing ?? `${request.role}-session`;
        if (!existing) sessionByRole.set(request.role, providerSessionId);
        const providerSessionReused = Boolean(existing);

        if (request.role === "red-writer") {
          redCalls += 1;
          const workspaceRoot = request.cwd;
          if (redCalls <= 3) {
            const testFile = `tests/round-${redCalls}.test.ts`;
            await mkdir(path.join(workspaceRoot, "tests"), { recursive: true });
            await writeFile(path.join(workspaceRoot, testFile), `export {};\n// round ${redCalls}\n`, "utf8");
            return {
              output: {
                status: "continue",
                summary: `RED batch ${redCalls}`,
                changedFiles: [testFile],
                behaviorsAdded: [`behavior ${redCalls}`],
                edgeCasesAdded: redCalls === 2 ? [`edge ${redCalls}`] : [],
              },
              providerSessionId,
              providerRunId: `red-run-${redCalls}`,
              providerSessionReused,
              submittedPrompt: providerSessionReused
                ? request.continuationPrompt ?? request.prompt
                : request.prompt,
            };
          }
          if (redCalls === 4) {
            return {
              output: {
                status: "done",
                summary: "Premature completion",
                changedFiles: [],
                acceptanceCoverage: [
                  {
                    criterionIndex: 0,
                    covered: true,
                    testPaths: ["tests/round-1.test.ts"],
                    rationale: "Primary behavior covered",
                  },
                  {
                    criterionIndex: 1,
                    covered: false,
                    verificationMode: "inspection",
                    testPaths: [],
                    rationale: "Still needs assessment",
                  },
                ],
                edgeCaseRationale: "Boundary cases covered in round 2",
              },
              providerSessionId,
              providerRunId: `red-run-${redCalls}`,
              providerSessionReused,
              submittedPrompt: providerSessionReused
                ? request.continuationPrompt ?? request.prompt
                : request.prompt,
            };
          }
          return {
            output: {
              status: "done",
              summary: "Coverage complete after three rounds",
              changedFiles: [],
              acceptanceCoverage: [
                {
                  criterionIndex: 0,
                  covered: true,
                  testPaths: [
                    "tests/round-1.test.ts",
                    "tests/round-2.test.ts",
                    "tests/round-3.test.ts",
                  ],
                  rationale: "All primary behaviors covered",
                },
                {
                  criterionIndex: 1,
                  covered: true,
                  verificationMode: "inspection",
                  testPaths: [],
                  rationale: "The exported surface was inspected",
                },
              ],
              edgeCaseRationale: "Boundary cases covered in round 2",
            },
            providerSessionId,
            providerRunId: `red-run-${redCalls}`,
            providerSessionReused,
            submittedPrompt: providerSessionReused
              ? request.continuationPrompt ?? request.prompt
              : request.prompt,
          };
        }

        if (request.role === "implementer") {
          greenCalls += 1;
          if (greenCalls >= 2 && !providerSessionReused) {
            throw new Error(`GREEN round ${greenCalls} must reuse the green session`);
          }
          if (greenCalls === 3) {
            return {
              output: {
                status: "already_green",
                summary: "GREEN round 3 already covered",
                changedFiles: [],
              },
              providerSessionId,
              providerRunId: `green-run-${greenCalls}`,
              providerSessionReused,
              submittedPrompt: providerSessionReused
                ? request.continuationPrompt ?? request.prompt
                : request.prompt,
            };
          }
          const srcFile = `src/round-${greenCalls}.ts`;
          await mkdir(path.join(request.cwd, "src"), { recursive: true });
          await writeFile(path.join(request.cwd, srcFile), `export const n = ${greenCalls};\n`, "utf8");
          return {
            output: {
              status: "green",
              summary: `GREEN round ${greenCalls}`,
              changedFiles: [srcFile],
            },
            providerSessionId,
            providerRunId: `green-run-${greenCalls}`,
            providerSessionReused,
            submittedPrompt: providerSessionReused
              ? request.continuationPrompt ?? request.prompt
              : request.prompt,
          };
        }

        if (request.role === "reviewer") {
          reviewCalls += 1;
          return {
            output: { approved: true, summary: "ok", findings: [] },
            providerSessionId: "reviewer-session",
            providerRunId: "review-run",
            providerSessionReused: false,
            submittedPrompt: request.prompt,
          };
        }

        throw new Error(`Unexpected role ${request.role}`);
      },
      async release() {},
    };

    const engine = new HarnessEngine(config, { backend });
    const started = await engine.start("Three-round TDD loop");
    const loaded = await engine.store.load(started.runId);
    await engine.store.writeJson(started.runId, "state.json", {
      ...loaded,
      phase: "executing",
      treeFingerprint: await new GitService(config, engine.paths).treeFingerprint(),
      reflectBrief: {
        draft: "d",
        confirmed: "Confirmed brief",
        confirmedAt: new Date().toISOString(),
      },
      tasks: [
        {
          id: "three-round",
          title: "Ship greeting",
          description: "Multi-round TDD",
          acceptanceCriteria: ["greeting works", "exported surface is present"],
          affectedPaths: ["src/greet.ts"],
          blockedBy: [],
          tdd: true,
          status: "active",
          step: "writing_tests",
          attempts: { tests: 0, implementation: 0, review: 0 },
          evidence: [],
          testPaths: [],
          changedFiles: [],
        },
      ],
    });

    const advanced = await engine.advance(started.runId);
    expect(advanced.phase).toBe("completed");
    expect(redCalls).toBe(5); // 3 continue + rejected done + corrected done
    expect(greenCalls).toBe(3);
    expect(reviewCalls).toBe(1);
    expect(advanced.tasks[0]?.tddLoop?.completedRounds).toHaveLength(3);
    expect(advanced.tasks[0]?.tddLoop?.completedRounds.map((round) => round.outcome)).toEqual([
      "implemented",
      "implemented",
      "already-covered",
    ]);
    expect(advanced.tasks[0]?.evidence.filter((item) => item.purpose === "tdd:green")).toHaveLength(
      3,
    );

    const workerSessions = [...sessionByRole.entries()]
      .filter(([role]) => role === "red-writer" || role === "implementer")
      .map(([, id]) => id);
    expect(new Set(workerSessions).size).toBe(2);
    expect(sessionByRole.get("red-writer")).toBe("red-writer-session");
    expect(sessionByRole.get("implementer")).toBe("implementer-session");

    const events = await readFile(
      path.join(fixture.root, ".agent-harness", "runs", started.runId, "events.jsonl"),
      "utf8",
    );
    expect(events).toContain("task.tdd_round_started");
    expect(events).toContain("task.tdd_round_completed");
    expect(events).toContain("task.green_already_covered");
    expect(events).toContain("task.red_done_rejected");
    expect(events).toContain("task.tdd_done_declared");

    // Phase 5 exit: one final task commit, oldest redBaseSha, cumulative paths, no lost files.
    const task = advanced.tasks[0]!;
    expect(task.redBaseSha).toMatch(/^[a-f0-9]{40}$/);
    expect(task.redCheckpointHistory).toHaveLength(3);
    expect(task.redCheckpointPaths).toEqual(
      expect.arrayContaining([
        "tests/round-1.test.ts",
        "tests/round-2.test.ts",
        "tests/round-3.test.ts",
      ]),
    );
    expect(task.redCheckpointPaths).toHaveLength(3);
    const workspace = migrateRunWorkspace(
      await engine.store.readJson(started.runId, "workspace.json"),
      { controlRoot: fixture.root },
    );
    const worktree = workspace.worktreePath!;
    const commitCount = (
      await runGit(worktree, "rev-list", "--count", `${workspace.baseSha}..HEAD`)
    ).trim();
    expect(Number(commitCount)).toBe(1);
    const log = await runGit(worktree, "log", "-1", "--format=%B");
    expect(log).toContain(`Harness-Task: ${task.id}`);
    expect(log).toContain(`Harness-Red-Checkpoints: ${task.redCheckpointHistory.join(",")}`);
    const names = await runGit(worktree, "show", "--pretty=", "--name-only", "HEAD");
    expect(names).toContain("tests/round-1.test.ts");
    expect(names).toContain("tests/round-2.test.ts");
    expect(names).toContain("tests/round-3.test.ts");
    expect(names).toContain("src/round-1.ts");
    expect(names).toContain("src/round-2.ts");
    // Oldest base stays distinct from the newest checkpoint tip.
    expect(task.redBaseSha).not.toBe(task.redCheckpointSha);
  });

  it("restores a round-one test when the implementer tampers it during round three", async () => {
    const fixture = await createProjectFixture();
    await fixture.initGit();
    const config = fixtureConfig(fixture.root, {
      git: { enabled: true, baseBranch: "main" } as never,
      workflow: {
        tdd: true,
        maxImplementationAttempts: 3,
        maxTestAttempts: 5,
        generateCommitMessages: false,
      } as never,
      commands: {
        verification: [{ id: "test", command: 'node -e "process.exit(0)"', timeoutMs: 600_000 }],
      } as never,
      agent: { promptBuilder: false } as never,
    });

    let redCalls = 0;
    let greenCalls = 0;
    const backend: AgentBackend = {
      async run(request) {
        const providerSessionId = request.providerSessionId ?? `${request.role}-session`;
        const providerSessionReused = Boolean(request.providerSessionId);

        if (request.role === "red-writer") {
          redCalls += 1;
          if (redCalls <= 3) {
            const testFile = `tests/round-${redCalls}.test.ts`;
            await mkdir(path.join(request.cwd, "tests"), { recursive: true });
            await writeFile(
              path.join(request.cwd, testFile),
              `// original round ${redCalls}\nexport {};\n`,
              "utf8",
            );
            return {
              output: {
                status: "continue",
                summary: `RED batch ${redCalls}`,
                changedFiles: [testFile],
                behaviorsAdded: [`behavior ${redCalls}`],
                edgeCasesAdded: [],
              },
              providerSessionId,
              providerRunId: `red-run-${redCalls}`,
              providerSessionReused,
              submittedPrompt: providerSessionReused
                ? request.continuationPrompt ?? request.prompt
                : request.prompt,
            };
          }
          return {
            output: {
              status: "done",
              summary: "Coverage complete",
              changedFiles: [],
              acceptanceCoverage: [
                {
                  criterionIndex: 0,
                  covered: true,
                  testPaths: [
                    "tests/round-1.test.ts",
                    "tests/round-2.test.ts",
                    "tests/round-3.test.ts",
                  ],
                  rationale: "covered",
                },
              ],
              edgeCaseRationale: "n/a",
            },
            providerSessionId,
            providerRunId: `red-run-${redCalls}`,
            providerSessionReused,
            submittedPrompt: providerSessionReused
              ? request.continuationPrompt ?? request.prompt
              : request.prompt,
          };
        }

        if (request.role === "implementer") {
          greenCalls += 1;
          await mkdir(path.join(request.cwd, "src"), { recursive: true });
          const srcFile = `src/round-${greenCalls}.ts`;
          await writeFile(path.join(request.cwd, srcFile), `export const n = ${greenCalls};\n`, "utf8");
          const changedFiles = [srcFile];
          if (greenCalls === 3) {
            // Cumulative integrity: tamper a round-one test during round three.
            await writeFile(
              path.join(request.cwd, "tests", "round-1.test.ts"),
              "// TAMPERED in round 3\nexport {};\n",
              "utf8",
            );
            changedFiles.push("tests/round-1.test.ts");
          }
          return {
            output: {
              status: "green",
              summary: `GREEN round ${greenCalls}`,
              changedFiles,
            },
            providerSessionId,
            providerRunId: `green-run-${greenCalls}`,
            providerSessionReused,
            submittedPrompt: providerSessionReused
              ? request.continuationPrompt ?? request.prompt
              : request.prompt,
          };
        }

        if (request.role === "reviewer") {
          return {
            output: { approved: true, summary: "ok", findings: [] },
            providerSessionId: "reviewer-session",
            providerRunId: "review-run",
            providerSessionReused: false,
            submittedPrompt: request.prompt,
          };
        }

        throw new Error(`Unexpected role ${request.role}`);
      },
      async release() {},
    };

    const engine = new HarnessEngine(config, { backend });
    const started = await engine.start("Cumulative integrity");
    const loaded = await engine.store.load(started.runId);
    await engine.store.writeJson(started.runId, "state.json", {
      ...loaded,
      phase: "executing",
      treeFingerprint: await new GitService(config, engine.paths).treeFingerprint(),
      reflectBrief: {
        draft: "d",
        confirmed: "Confirmed brief",
        confirmedAt: new Date().toISOString(),
      },
      tasks: [
        {
          id: "cumul-integrity",
          title: "Ship greeting",
          description: "Multi-round TDD with tamper",
          acceptanceCriteria: ["greeting works"],
          affectedPaths: ["src/greet.ts"],
          blockedBy: [],
          tdd: true,
          status: "active",
          step: "writing_tests",
          attempts: { tests: 0, implementation: 0, review: 0 },
          evidence: [],
          testPaths: [],
          changedFiles: [],
        },
      ],
    });

    const advanced = await engine.advance(started.runId);
    expect(advanced.phase).toBe("completed");
    expect(advanced.tasks[0]?.redCheckpointPaths).toEqual(
      expect.arrayContaining([
        "tests/round-1.test.ts",
        "tests/round-2.test.ts",
        "tests/round-3.test.ts",
      ]),
    );

    const events = await readFile(
      path.join(fixture.root, ".agent-harness", "runs", started.runId, "events.jsonl"),
      "utf8",
    );
    expect(events).toContain("test_integrity.restored");

    const workspace = migrateRunWorkspace(
      await engine.store.readJson(started.runId, "workspace.json"),
      { controlRoot: fixture.root },
    );
    const worktree = workspace.worktreePath!;
    const roundOne = await readFile(path.join(worktree, "tests", "round-1.test.ts"), "utf8");
    expect(roundOne).toContain("original round 1");
    expect(roundOne).not.toContain("TAMPERED");
    expect(await readFile(path.join(worktree, "src", "round-3.ts"), "utf8")).toContain(
      "export const n = 3",
    );
    const commitCount = (
      await runGit(worktree, "rev-list", "--count", `${workspace.baseSha}..HEAD`)
    ).trim();
    expect(Number(commitCount)).toBe(1);
  });

  it("routes test_issue to the retained red-writer then resumes the same green session", async () => {
    const fixture = await createProjectFixture();
    await fixture.initGit();
    const config = fixtureConfig(fixture.root, {
      git: { enabled: true, baseBranch: "main" } as never,
      workflow: { tdd: true, maxImplementationAttempts: 3, generateCommitMessages: false } as never,
      commands: {
        verification: [{ id: "test", command: 'node -e "process.exit(0)"', timeoutMs: 600_000 }],
      } as never,
      agent: { promptBuilder: false } as never,
    });

    let redCalls = 0;
    let greenCalls = 0;
    let redSession: string | undefined;
    let greenSession: string | undefined;
    const backend: AgentBackend = {
      async run(request) {
        const providerSessionId =
          request.providerSessionId ??
          (request.role === "red-writer" ? "red-shared" : "green-shared");
        if (request.role === "red-writer") {
          redCalls += 1;
          if (!redSession) redSession = providerSessionId;
          expect(providerSessionId).toBe(redSession);
          if (redCalls === 1) {
            await mkdir(path.join(request.cwd, "tests"), { recursive: true });
            await writeFile(
              path.join(request.cwd, "tests", "greet.test.ts"),
              "export {};\n// broken\n",
              "utf8",
            );
            return {
              output: {
                status: "continue",
                summary: "initial red",
                changedFiles: ["tests/greet.test.ts"],
                behaviorsAdded: ["greets"],
                edgeCasesAdded: [],
              },
              providerSessionId,
              providerRunId: `red-${redCalls}`,
              providerSessionReused: Boolean(request.providerSessionId),
              submittedPrompt: request.prompt,
            };
          }
          if (redCalls === 2) {
            await writeFile(
              path.join(request.cwd, "tests", "greet.test.ts"),
              "export {};\n// repaired\n",
              "utf8",
            );
            return {
              output: {
                status: "continue",
                summary: "repaired test",
                changedFiles: ["tests/greet.test.ts"],
                behaviorsAdded: ["greets"],
                edgeCasesAdded: [],
              },
              providerSessionId,
              providerRunId: `red-${redCalls}`,
              providerSessionReused: Boolean(request.providerSessionId),
              submittedPrompt: request.continuationPrompt ?? request.prompt,
            };
          }
          return {
            output: {
              status: "done",
              summary: "done after repair round",
              changedFiles: [],
              acceptanceCoverage: [
                {
                  criterionIndex: 0,
                  covered: true,
                  testPaths: ["tests/greet.test.ts"],
                  rationale: "covered",
                },
              ],
              edgeCaseRationale: "n/a",
            },
            providerSessionId,
            providerRunId: `red-${redCalls}`,
            providerSessionReused: Boolean(request.providerSessionId),
            submittedPrompt: request.continuationPrompt ?? request.prompt,
          };
        }
        if (request.role === "implementer") {
          greenCalls += 1;
          if (!greenSession) greenSession = providerSessionId;
          expect(providerSessionId).toBe(greenSession);
          if (greenCalls === 1) {
            return {
              output: {
                status: "test_issue",
                summary: "defective assertion",
                changedFiles: [],
                testPath: "tests/greet.test.ts",
                reason: "asserts the wrong seam",
                evidence: "expected A, test demands B",
              },
              providerSessionId,
              providerRunId: `green-${greenCalls}`,
              providerSessionReused: Boolean(request.providerSessionId),
              submittedPrompt: request.prompt,
            };
          }
          await mkdir(path.join(request.cwd, "src"), { recursive: true });
          await writeFile(path.join(request.cwd, "src", "greet.ts"), "export {};\n", "utf8");
          return {
            output: {
              status: "green",
              summary: "implemented after repair",
              changedFiles: ["src/greet.ts"],
            },
            providerSessionId,
            providerRunId: `green-${greenCalls}`,
            providerSessionReused: Boolean(request.providerSessionId),
            submittedPrompt: request.continuationPrompt ?? request.prompt,
          };
        }
        if (request.role === "reviewer") {
          return {
            output: { approved: true, summary: "ok", findings: [] },
            providerSessionId: "rev",
            providerRunId: "rev-1",
            providerSessionReused: false,
            submittedPrompt: request.prompt,
          };
        }
        throw new Error(`Unexpected role ${request.role}`);
      },
      async release() {},
    };

    const engine = new HarnessEngine(config, { backend });
    const started = await engine.start("Test issue repair");
    const loaded = await engine.store.load(started.runId);
    await engine.store.writeJson(started.runId, "state.json", {
      ...loaded,
      phase: "executing",
      treeFingerprint: await new GitService(config, engine.paths).treeFingerprint(),
      reflectBrief: {
        draft: "d",
        confirmed: "Confirmed",
        confirmedAt: new Date().toISOString(),
      },
      tasks: [
        {
          id: "repair-loop",
          title: "Ship greeting",
          description: "Repair path",
          acceptanceCriteria: ["works"],
          affectedPaths: ["src/greet.ts"],
          blockedBy: [],
          tdd: true,
          status: "active",
          step: "writing_tests",
          attempts: { tests: 0, implementation: 0, review: 0 },
          evidence: [],
          testPaths: [],
          changedFiles: [],
        },
      ],
    });

    // Drive until after first GREEN completion (writing_tests again), then stop by failing next red.
    const advanced = await engine.advance(started.runId);
    // After green pass the loop returns to writing_tests and will call red again for done/continue.
    // Provide done on the third red call by extending the backend above — but redCalls===2 is repair.
    // If advance continues, redCalls===3 needs a done response. Extend: treat redCalls>=3 as done.
    expect(redCalls).toBeGreaterThanOrEqual(2);
    expect(greenCalls).toBeGreaterThanOrEqual(2);
    expect(redSession).toBe("red-shared");
    expect(greenSession).toBe("green-shared");

    const events = await readFile(
      path.join(fixture.root, ".agent-harness", "runs", started.runId, "events.jsonl"),
      "utf8",
    );
    expect(events).toContain("task.test_issue_reported");
    expect(events).toContain("task.test_issue_repaired");
    expect(advanced.tasks[0]?.tddLoop?.completedRounds.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("retries failed GREEN in-round without tripping the repeated-transition breaker", async () => {
    const fixture = await createProjectFixture();
    await fixture.initGit();
    const config = fixtureConfig(fixture.root, {
      git: { enabled: true, baseBranch: "main" } as never,
      workflow: { tdd: true, maxImplementationAttempts: 3, generateCommitMessages: false } as never,
      commands: {
        verification: [
          {
            id: "test",
            command: 'node -e "process.exit(process.env.HARNESS_FORCE_RED ? 1 : 0)"',
            timeoutMs: 600_000,
          },
        ],
        passEnv: ["HARNESS_FORCE_RED"],
      } as never,
      agent: { promptBuilder: false } as never,
    });

    let greenCalls = 0;
    const greenSessions: string[] = [];
    const backend: AgentBackend = {
      async run(request) {
        if (request.role === "implementer") {
          greenCalls += 1;
          const providerSessionId = request.providerSessionId ?? "green-retry-session";
          greenSessions.push(providerSessionId);
          // Fail targeted verification twice, then pass.
          if (greenCalls < 3) process.env.HARNESS_FORCE_RED = "1";
          else delete process.env.HARNESS_FORCE_RED;
          await mkdir(path.join(request.cwd, "src"), { recursive: true });
          await writeFile(
            path.join(request.cwd, "src", `greet-${greenCalls}.ts`),
            `export const n = ${greenCalls};\n`,
            "utf8",
          );
          return {
            output: {
              status: "green",
              summary: `attempt ${greenCalls}`,
              changedFiles: [`src/greet-${greenCalls}.ts`],
            },
            providerSessionId,
            providerRunId: `g-${greenCalls}`,
            providerSessionReused: Boolean(request.providerSessionId),
            submittedPrompt: request.continuationPrompt ?? request.prompt,
          };
        }
        if (request.role === "red-writer") {
          return {
            output: {
              status: "done",
              summary: "done after green retries",
              changedFiles: [],
              acceptanceCoverage: [
                {
                  criterionIndex: 0,
                  covered: true,
                  testPaths: ["tests/greet.test.ts"],
                  rationale: "covered",
                },
              ],
              edgeCaseRationale: "n/a",
            },
            providerSessionId: request.providerSessionId ?? "red-session",
            providerRunId: "red-1",
            providerSessionReused: Boolean(request.providerSessionId),
            submittedPrompt: request.prompt,
          };
        }
        if (request.role === "reviewer") {
          return {
            output: { approved: true, summary: "ok", findings: [] },
            providerSessionId: "rev",
            providerRunId: "rev-1",
            providerSessionReused: false,
            submittedPrompt: request.prompt,
          };
        }
        throw new Error(`Unexpected role ${request.role}`);
      },
      async release() {},
    };

    const engine = new HarnessEngine(config, { backend });
    const started = await engine.start("GREEN retries");
    const loaded = await engine.store.load(started.runId);
    await mkdir(path.join(engine.paths.workspaceRoot, "tests"), { recursive: true });
    await writeFile(
      path.join(engine.paths.workspaceRoot, "tests", "greet.test.ts"),
      "export {};\n",
      "utf8",
    );
    const git = new GitService(config, engine.paths);
    const checkpoint = await git.commitRedCheckpoint({
      taskId: "green-retry",
      taskTitle: "Ship greeting",
      paths: ["tests/greet.test.ts"],
    });
    await engine.store.writeJson(started.runId, "state.json", {
      ...loaded,
      phase: "executing",
      treeFingerprint: await git.treeFingerprint(),
      reflectBrief: {
        draft: "d",
        confirmed: "Confirmed",
        confirmedAt: new Date().toISOString(),
      },
      tasks: [
        {
          id: "green-retry",
          title: "Ship greeting",
          description: "Retry green",
          acceptanceCriteria: ["works"],
          affectedPaths: ["src/greet.ts"],
          blockedBy: [],
          tdd: true,
          status: "active",
          step: "implementing",
          attempts: { tests: 1, implementation: 0, review: 0 },
          evidence: [],
          testPaths: ["tests/greet.test.ts"],
          redCheckpointSha: checkpoint!.sha,
          redBaseSha: checkpoint!.baseSha,
          redCheckpointPaths: ["tests/greet.test.ts"],
          redCheckpointHistory: [checkpoint!.sha],
          changedFiles: ["tests/greet.test.ts"],
          tddLoop: {
            round: 1,
            atVerifiedGreen: false,
            pendingRound: {
              number: 1,
              mode: "feature",
              redCheckpointSha: checkpoint!.sha,
              testPathsAdded: ["tests/greet.test.ts"],
              behaviorsAdded: ["greets"],
              edgeCasesAdded: [],
              implementerAttempts: 0,
              startedAt: new Date().toISOString(),
            },
            redWriterSession: { providerSessionId: "red-session", turns: 1 },
          },
        },
      ],
    });

    const advanced = await engine.advance(started.runId);
    expect(advanced.phase).not.toBe("blocked");
    expect(advanced.failure ?? "").not.toMatch(/Repeated workflow transition/i);
    expect(greenCalls).toBe(3);
    expect(new Set(greenSessions).size).toBe(1);
    expect(advanced.tasks[0]?.tddLoop?.completedRounds).toHaveLength(1);
    delete process.env.HARNESS_FORCE_RED;
  });

  it("budgets final gate repair with finalRepairAttempts and returns to RED reassessment", async () => {
    const fixture = await createProjectFixture();
    await fixture.initGit();
    const config = fixtureConfig(fixture.root, {
      git: { enabled: true, baseBranch: "main" } as never,
      workflow: {
        tdd: true,
        maxImplementationAttempts: 3,
        maxReviewAttempts: 2,
        generateCommitMessages: false,
      } as never,
      commands: {
        verification: [
          {
            id: "test",
            command: 'node -e "process.exit(Number(process.env.HARNESS_FORCE_VERIFY_FAIL||0))"',
            timeoutMs: 600_000,
          },
        ],
        passEnv: ["HARNESS_FORCE_VERIFY_FAIL"],
      } as never,
      agent: { promptBuilder: false } as never,
    });

    let redCalls = 0;
    let greenCalls = 0;
    const greenReuse: boolean[] = [];
    const released: string[] = [];
    const backend: AgentBackend = {
      async run(request) {
        const providerSessionId = request.providerSessionId ?? `${request.role}-session`;
        if (request.role === "red-writer") {
          redCalls += 1;
          return {
            output: {
              status: "done",
              summary: "coverage complete",
              changedFiles: [],
              acceptanceCoverage: [
                {
                  criterionIndex: 0,
                  covered: true,
                  testPaths: ["tests/greet.test.ts"],
                  rationale: "covered",
                },
              ],
              edgeCaseRationale: "boundaries covered",
            },
            providerSessionId,
            providerRunId: `red-${redCalls}`,
            providerSessionReused: Boolean(request.providerSessionId),
            submittedPrompt: request.prompt,
          };
        }
        if (request.role === "implementer") {
          greenCalls += 1;
          greenReuse.push(Boolean(request.providerSessionId));
          // Clear the force-fail so targeted GREEN and later final gates can pass.
          delete process.env.HARNESS_FORCE_VERIFY_FAIL;
          return {
            output: {
              status: "green",
              summary: "final repair",
              changedFiles: ["src/greet.ts"],
            },
            providerSessionId,
            providerRunId: `green-${greenCalls}`,
            providerSessionReused: Boolean(request.providerSessionId),
            submittedPrompt: request.prompt,
          };
        }
        if (request.role === "reviewer") {
          return {
            output: { approved: true, summary: "ok", findings: [] },
            providerSessionId: "review-session",
            providerRunId: "review-1",
            providerSessionReused: false,
            submittedPrompt: request.prompt,
          };
        }
        throw new Error(`Unexpected role ${request.role}`);
      },
      async release(providerSessionId) {
        released.push(providerSessionId);
      },
    };

    const engine = new HarnessEngine(config, { backend });
    const started = await engine.start("Final repair budget");
    const loaded = await engine.store.load(started.runId);
    process.env.HARNESS_FORCE_VERIFY_FAIL = "1";
    await engine.store.writeJson(started.runId, "state.json", {
      ...loaded,
      phase: "executing",
      treeFingerprint: await new GitService(config, engine.paths).treeFingerprint(),
      reflectBrief: {
        draft: "d",
        confirmed: "Confirmed brief",
        confirmedAt: new Date().toISOString(),
      },
      tasks: [
        {
          id: "final-repair",
          title: "Ship greeting",
          description: "Final repair",
          acceptanceCriteria: ["greeting works"],
          affectedPaths: ["src/greet.ts"],
          blockedBy: [],
          tdd: true,
          status: "active",
          step: "verifying",
          // Cumulative counter already exhausted if it were the budget.
          attempts: { tests: 4, implementation: 9, review: 0 },
          evidence: [],
          testPaths: ["tests/greet.test.ts"],
          changedFiles: ["tests/greet.test.ts", "src/greet.ts"],
          tddLoop: {
            round: 2,
            atVerifiedGreen: true,
            finalRepairPending: false,
            finalRepairAttempts: 0,
            completedRounds: [
              {
                number: 1,
                outcome: "implemented",
                testPathsAdded: ["tests/greet.test.ts"],
                behaviorsAdded: ["greets"],
                edgeCasesAdded: [],
                targetedEvidencePurpose: "tdd:green",
                completedAt: new Date().toISOString(),
              },
            ],
            coverage: {
              behaviors: ["greets"],
              edgeCases: [],
              finalAssessment: {
                acceptanceCriteria: [
                  {
                    criterionIndex: 0,
                    covered: true,
                    testPaths: ["tests/greet.test.ts"],
                    rationale: "covered",
                  },
                ],
                edgeCaseRationale: "ok",
              },
            },
            redWriterSession: { providerSessionId: "red-session", turns: 2 },
            greenImplementerSession: { providerSessionId: "green-session", turns: 3 },
          },
        },
      ],
    });

    const state = await engine.advance(started.runId);
    const events = await readFile(
      path.join(fixture.root, ".agent-harness", "runs", started.runId, "events.jsonl"),
      "utf8",
    );
    expect(events).toContain("task.gates_failed");
    expect(events).toContain('"finalRepairAttempts":1');
    expect(events).toContain('"finalRepair":true');
    expect(greenCalls).toBeGreaterThanOrEqual(1);
    expect(greenReuse[0]).toBe(true);
    // Cumulative attempts.implementation must not prevent the dedicated budget.
    expect(state.tasks[0]?.attempts.implementation).toBeGreaterThanOrEqual(9);
    expect(state.tasks[0]?.tddLoop?.finalRepairAttempts).toBe(1);
    // Successful final repair clears the marker before RED reassessment.
    expect(state.tasks[0]?.tddLoop?.finalRepairPending).toBe(false);
    expect(events).toContain("task.green_observed");
    void released;
    delete process.env.HARNESS_FORCE_VERIFY_FAIL;
  });

  it("routes review test-coverage findings to RED and production findings to GREEN", async () => {
    const fixture = await createProjectFixture();
    await fixture.initGit();
    const config = fixtureConfig(fixture.root, {
      git: { enabled: true, baseBranch: "main" } as never,
      workflow: {
        tdd: true,
        maxImplementationAttempts: 3,
        maxReviewAttempts: 2,
        generateCommitMessages: false,
      } as never,
      commands: {
        verification: [{ id: "test", command: 'node -e "process.exit(0)"', timeoutMs: 600_000 }],
      } as never,
      agent: { promptBuilder: false } as never,
    });

    let reviewCalls = 0;
    const redPrompts: string[] = [];
    const backend: AgentBackend = {
      async run(request) {
        if (request.role === "reviewer") {
          reviewCalls += 1;
          if (reviewCalls === 1) {
            return {
              output: {
                approved: false,
                summary: "missing edge case",
                findings: [
                  {
                    severity: "blocking",
                    kind: "test-coverage",
                    message: "Add null-input coverage",
                  },
                ],
              },
              providerSessionId: "review-session",
              providerRunId: `review-${reviewCalls}`,
              providerSessionReused: false,
              submittedPrompt: request.prompt,
            };
          }
          if (reviewCalls === 2) {
            return {
              output: {
                approved: false,
                summary: "production bug",
                findings: [
                  {
                    severity: "blocking",
                    kind: "production",
                    message: "Null dereference in greet",
                  },
                ],
              },
              providerSessionId: "review-session",
              providerRunId: `review-${reviewCalls}`,
              providerSessionReused: false,
              submittedPrompt: request.prompt,
            };
          }
          return {
            output: { approved: true, summary: "ok", findings: [] },
            providerSessionId: "review-session",
            providerRunId: `review-${reviewCalls}`,
            providerSessionReused: false,
            submittedPrompt: request.prompt,
          };
        }
        if (request.role === "red-writer") {
          redPrompts.push(request.continuationPrompt ?? request.prompt);
          return {
            output: {
              status: "done",
              summary: "still done",
              changedFiles: [],
              acceptanceCoverage: [
                {
                  criterionIndex: 0,
                  covered: true,
                  testPaths: ["tests/greet.test.ts"],
                  rationale: "covered",
                },
              ],
              edgeCaseRationale: "ok",
            },
            providerSessionId: request.providerSessionId ?? "red-session",
            providerRunId: "red-1",
            providerSessionReused: Boolean(request.providerSessionId),
            submittedPrompt: request.prompt,
          };
        }
        if (request.role === "implementer") {
          return {
            output: {
              status: "green",
              summary: "fixed",
              changedFiles: ["src/greet.ts"],
            },
            providerSessionId: request.providerSessionId ?? "green-session",
            providerRunId: "green-1",
            providerSessionReused: Boolean(request.providerSessionId),
            submittedPrompt: request.prompt,
          };
        }
        throw new Error(`Unexpected role ${request.role}`);
      },
      async release() {},
    };

    const engine = new HarnessEngine(config, { backend });
    const started = await engine.start("Review finding routing");
    const loaded = await engine.store.load(started.runId);
    await engine.store.writeJson(started.runId, "state.json", {
      ...loaded,
      phase: "executing",
      treeFingerprint: await new GitService(config, engine.paths).treeFingerprint(),
      reflectBrief: {
        draft: "d",
        confirmed: "Confirmed brief",
        confirmedAt: new Date().toISOString(),
      },
      tasks: [
        {
          id: "review-route",
          title: "Ship greeting",
          description: "Review routing",
          acceptanceCriteria: ["greeting works"],
          affectedPaths: ["src/greet.ts"],
          blockedBy: [],
          tdd: true,
          status: "active",
          step: "reviewing",
          attempts: { tests: 2, implementation: 8, review: 0 },
          evidence: [],
          testPaths: ["tests/greet.test.ts"],
          changedFiles: ["tests/greet.test.ts", "src/greet.ts"],
          tddLoop: {
            round: 2,
            atVerifiedGreen: true,
            finalRepairAttempts: 0,
            finalRepairPending: false,
            completedRounds: [
              {
                number: 1,
                outcome: "implemented",
                testPathsAdded: ["tests/greet.test.ts"],
                behaviorsAdded: ["greets"],
                edgeCasesAdded: [],
                targetedEvidencePurpose: "tdd:green",
                completedAt: new Date().toISOString(),
              },
            ],
            coverage: {
              behaviors: ["greets"],
              edgeCases: [],
              finalAssessment: {
                acceptanceCriteria: [
                  {
                    criterionIndex: 0,
                    covered: true,
                    testPaths: ["tests/greet.test.ts"],
                    rationale: "covered",
                  },
                ],
                edgeCaseRationale: "ok",
              },
            },
            redWriterSession: { providerSessionId: "red-session", turns: 1 },
            greenImplementerSession: { providerSessionId: "green-session", turns: 1 },
          },
        },
      ],
    });

    await engine.advance(started.runId);
    const events = await readFile(
      path.join(fixture.root, ".agent-harness", "runs", started.runId, "events.jsonl"),
      "utf8",
    );
    expect(events).toContain('"reviewRepairRoute":"test-coverage"');
    expect(events).toContain('"reviewRepairRoute":"production"');
    expect(reviewCalls).toBe(3);
    expect(redPrompts.some((prompt) => prompt.includes("Null dereference in greet"))).toBe(true);
    // Production route budgets with finalRepairAttempts / finalRepairPending.
    expect(events).toContain('"finalRepairPending":true');
    expect(events).toMatch(/"finalRepairAttempts":[1-9]/);
  });

  it("rotates RED and GREEN context independently and releases only that role", async () => {
    const fixture = await createProjectFixture();
    await fixture.initGit();
    const config = fixtureConfig(fixture.root, {
      git: { enabled: true, baseBranch: "main" } as never,
      workflow: {
        tdd: true,
        maxContextTurns: 2,
        maxImplementationAttempts: 3,
        generateCommitMessages: false,
      } as never,
      commands: {
        verification: [{ id: "test", command: 'node -e "process.exit(0)"', timeoutMs: 600_000 }],
      } as never,
      agent: { promptBuilder: false } as never,
    });

    const released: string[] = [];
    const redRequests: Array<{ reused: boolean; providerSessionId?: string }> = [];
    const greenRequests: Array<{ reused: boolean; providerSessionId?: string }> = [];
    let redCalls = 0;
    const backend: AgentBackend = {
      async run(request) {
        if (request.role === "red-writer") {
          redCalls += 1;
          redRequests.push({
            reused: Boolean(request.providerSessionId),
            providerSessionId: request.providerSessionId,
          });
          const providerSessionId = request.providerSessionId ?? `red-fresh-${redCalls}`;
          if (redCalls === 1) {
            await mkdir(path.join(request.cwd, "tests"), { recursive: true });
            await writeFile(
              path.join(request.cwd, "tests", "a.test.ts"),
              "export {};\n",
              "utf8",
            );
            return {
              output: {
                status: "continue",
                summary: "batch",
                changedFiles: ["tests/a.test.ts"],
                behaviorsAdded: ["a"],
                edgeCasesAdded: [],
              },
              providerSessionId,
              providerRunId: `red-${redCalls}`,
              providerSessionReused: Boolean(request.providerSessionId),
              submittedPrompt: request.prompt,
            };
          }
          return {
            output: {
              status: "done",
              summary: "done",
              changedFiles: [],
              acceptanceCoverage: [
                {
                  criterionIndex: 0,
                  covered: true,
                  testPaths: ["tests/a.test.ts"],
                  rationale: "ok",
                },
              ],
              edgeCaseRationale: "ok",
            },
            providerSessionId,
            providerRunId: `red-${redCalls}`,
            providerSessionReused: Boolean(request.providerSessionId),
            submittedPrompt: request.prompt,
          };
        }
        if (request.role === "implementer") {
          greenRequests.push({
            reused: Boolean(request.providerSessionId),
            providerSessionId: request.providerSessionId,
          });
          await mkdir(path.join(request.cwd, "src"), { recursive: true });
          await writeFile(path.join(request.cwd, "src", "a.ts"), "export {};\n", "utf8");
          return {
            output: {
              status: "green",
              summary: "ok",
              changedFiles: ["src/a.ts"],
            },
            providerSessionId: request.providerSessionId ?? "green-session",
            providerRunId: "green-1",
            providerSessionReused: Boolean(request.providerSessionId),
            submittedPrompt: request.prompt,
          };
        }
        if (request.role === "reviewer") {
          return {
            output: { approved: true, summary: "ok", findings: [] },
            providerSessionId: "review-session",
            providerRunId: "review-1",
            providerSessionReused: false,
            submittedPrompt: request.prompt,
          };
        }
        throw new Error(`Unexpected role ${request.role}`);
      },
      async release(providerSessionId) {
        released.push(providerSessionId);
      },
    };

    const engine = new HarnessEngine(config, { backend });
    const started = await engine.start("Context rotation");
    const loaded = await engine.store.load(started.runId);
    await engine.store.writeJson(started.runId, "state.json", {
      ...loaded,
      phase: "executing",
      treeFingerprint: await new GitService(config, engine.paths).treeFingerprint(),
      reflectBrief: {
        draft: "d",
        confirmed: "Confirmed brief",
        confirmedAt: new Date().toISOString(),
      },
      tasks: [
        {
          id: "rotate",
          title: "Ship greeting",
          description: "Rotate context",
          acceptanceCriteria: ["works"],
          affectedPaths: ["src/a.ts"],
          blockedBy: [],
          tdd: true,
          status: "active",
          step: "writing_tests",
          attempts: { tests: 0, implementation: 0, review: 0 },
          evidence: [],
          testPaths: [],
          changedFiles: [],
          // RED already at the turn limit; GREEN stays under it.
          tddLoop: {
            round: 1,
            atVerifiedGreen: false,
            redWriterSession: { providerSessionId: "red-stale", turns: 2 },
            greenImplementerSession: { providerSessionId: "green-keep", turns: 1 },
          },
        },
      ],
    });

    const state = await engine.advance(started.runId);
    const events = await readFile(
      path.join(fixture.root, ".agent-harness", "runs", started.runId, "events.jsonl"),
      "utf8",
    );
    expect(events).toContain("task.tdd_context_rotated");
    expect(events).toContain('"role":"red-writer"');
    // RED rotated (stale released, first request cold-starts); GREEN reused independently.
    expect(released).toContain("red-stale");
    expect(redRequests[0]?.reused).toBe(false);
    expect(greenRequests[0]?.providerSessionId).toBe("green-keep");
    expect(greenRequests[0]?.reused).toBe(true);
    // Terminal completion releases remaining worker sessions (including green-keep).
    expect(released).toContain("green-keep");
    expect(state.tasks[0]?.tddLoop?.redWriterSession).toBeUndefined();
    expect(state.tasks[0]?.tddLoop?.greenImplementerSession).toBeUndefined();
  });

  it("releases both worker sessions on no-progress failure", async () => {
    const fixture = await createProjectFixture();
    await fixture.initGit();
    const config = fixtureConfig(fixture.root, {
      git: { enabled: true, baseBranch: "main" } as never,
      workflow: {
        tdd: true,
        maxImplementationAttempts: 3,
        generateCommitMessages: false,
      } as never,
      commands: {
        verification: [{ id: "test", command: 'node -e "process.exit(1)"', timeoutMs: 600_000 }],
      } as never,
      agent: { promptBuilder: false } as never,
    });

    const released: string[] = [];
    const backend: AgentBackend = {
      async run() {
        throw new Error("Agent should not run when progress gate blocks");
      },
      async release(providerSessionId) {
        released.push(providerSessionId);
      },
    };

    const engine = new HarnessEngine(config, { backend });
    const started = await engine.start("No progress release");
    const loaded = await engine.store.load(started.runId);
    await mkdir(path.join(engine.paths.workspaceRoot, "tests"), { recursive: true });
    await writeFile(
      path.join(engine.paths.workspaceRoot, "tests", "greet.test.ts"),
      "export {};\n",
      "utf8",
    );
    const gitService = new GitService(config, engine.paths);
    const checkpoint = await gitService.commitRedCheckpoint({
      taskId: "no-progress",
      taskTitle: "Ship greeting",
      paths: ["tests/greet.test.ts"],
      round: 1,
    });
    const evidence = {
      purpose: "tdd:green",
      command: "test",
      exitCode: 1,
      passed: false,
      stdout: "",
      stderr: "fail",
      durationMs: 1,
      at: new Date().toISOString(),
    };
    const reviewSummary = "still broken";
    const fingerprint = evidenceFingerprint({
      taskId: "no-progress",
      step: "implementing",
      sourceTreeState: await gitService.treeFingerprint(),
      redCheckpointSha: checkpoint!.sha,
      failingTestIds: failingTestIdsFromEvidence(evidence),
      failureCategory: failureCategoryFromEvidence(evidence, "verification"),
      reviewFinding: reviewSummary,
      frozenConfigHash: String(config.workflow.maxImplementationAttempts),
    });

    await engine.store.writeJson(started.runId, "state.json", {
      ...loaded,
      phase: "executing",
      treeFingerprint: await gitService.treeFingerprint(),
      reflectBrief: {
        draft: "d",
        confirmed: "Confirmed brief",
        confirmedAt: new Date().toISOString(),
      },
      tasks: [
        {
          id: "no-progress",
          title: "Ship greeting",
          description: "No progress",
          acceptanceCriteria: ["works"],
          affectedPaths: ["src/greet.ts"],
          blockedBy: [],
          tdd: true,
          status: "active",
          // Fresh implementing entry with prior review feedback trips the progress gate.
          step: "implementing",
          attempts: { tests: 1, implementation: 1, review: 1 },
          evidence: [evidence],
          evidenceFingerprint: fingerprint,
          seenEvidenceFingerprints: [fingerprint],
          seenRepairEdges: [`${fingerprint}:implementer->implementer`],
          reviewSummary,
          testPaths: ["tests/greet.test.ts"],
          redCheckpointSha: checkpoint!.sha,
          redBaseSha: checkpoint!.baseSha,
          redCheckpointPaths: ["tests/greet.test.ts"],
          redCheckpointHistory: [checkpoint!.sha],
          changedFiles: ["tests/greet.test.ts"],
          tddLoop: {
            round: 1,
            atVerifiedGreen: false,
            pendingRound: {
              number: 1,
              mode: "feature",
              redCheckpointSha: checkpoint!.sha,
              testPathsAdded: ["tests/greet.test.ts"],
              behaviorsAdded: ["greets"],
              edgeCasesAdded: [],
              // Zero so this is not treated as an in-round retry (progress gate applies).
              implementerAttempts: 0,
              startedAt: new Date().toISOString(),
            },
            redWriterSession: { providerSessionId: "red-session", turns: 1 },
            greenImplementerSession: { providerSessionId: "green-session", turns: 1 },
          },
        },
      ],
    });

    const state = await engine.advance(started.runId);
    expect(state.tasks[0]?.status).toBe("failed");
    expect(state.tasks[0]?.step).toBe("failed");
    expect(released).toEqual(expect.arrayContaining(["red-session", "green-session"]));
    expect(state.tasks[0]?.tddLoop?.redWriterSession).toBeUndefined();
    expect(state.tasks[0]?.tddLoop?.greenImplementerSession).toBeUndefined();
  });
});
