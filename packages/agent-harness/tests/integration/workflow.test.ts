import path from "node:path";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createFakeBackend } from "../../src/infrastructure/agents/fake-backend.js";
import type { AgentBackend, AgentRequest } from "../../src/infrastructure/agents/types.js";
import { CONFIG_VERSION, configurationHash } from "../../src/config/schema.js";
import { loadRunConfig, writeProjectSettings } from "../../src/config/io.js";
import { HarnessEngine } from "../../src/application/harness-engine.js";
import { GitService } from "../../src/git.js";
import {
  evidenceFingerprint,
  failingTestIdsFromEvidence,
  failureCategoryFromEvidence} from "../../src/application/evidence-fingerprint.js";
import { createRunState, type RunState } from "../../src/domain.js";
import {
  confirmGrillAndAdvance,
  createPlannerPrdSequence,
  createProjectFixture,
  fixtureConfig,
  fixtureRoot,
  git as runGit,
  HIGH_LEVEL_PLAN,
  PRD_OUTPUT,
  SCENARIO_PLANNER_OUTPUT,
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
  unknowns: ["formal vs casual"]};

const FIRST_GRILL_QUESTION = {
  prompt: "Should the greeting be formal or casual?",
  context: "The choice sets the voice users encounter throughout the feature.",
  options: [
    { id: "formal", label: "Formal", description: "Polished and reserved." },
    { id: "casual", label: "Casual", description: "Warm and direct." }],
  recommendedOptionId: "casual",
  recommendation: "Use casual for a lightweight greeting."};

describe("durable idea-to-feature workflow", () => {
  it("reflects, pauses for editable confirm, grills, then plans and finishes", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { maxGrillQuestionsPerEpisode: 5 } as never});
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
                summary: "Use a casual greeting"}]};
        }
        return {
          status: "needs_input",
          summary: "Need tone",
          questions: [FIRST_GRILL_QUESTION]};
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
          "scenario-planner": () => SCENARIO_PLANNER_OUTPUT,
          "issue-slicer": () => ({
            summary: "One task",
        tasks: [
          {
            id: "greet",
            title: "Ship greeting",
            description: "Render the casual greeting.",
            acceptanceCriteria: ["Greeting is casual"],
            scenarioIds: ["greet-happy"],
            blockedBy: []}],
        proposedInstalls: []})};
      })(),
      implementer: () => ({ summary: "Built", changedFiles: ["src/greet.ts"] }),
      reviewer: () => ({ approved: true, summary: "Looks good", findings: [] }),
      "scenario-writer": () => ({
        status: "implemented",
        summary: "Scenario tests",
        testPaths: ["tests/greet.test.ts"],
        changedFiles: ["tests/greet.test.ts"],
      }),
      "message-writer": () => ({ subject: "feat: add greeting", body: "Verified." })});

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
      workflow: { maxGrillQuestionsPerEpisode: 5 } as never});
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
            openUnknowns: []};
        }
        return {
          status: "needs_input",
          summary: "Need more after feedback",
          questions: [FIRST_GRILL_QUESTION],
          openUnknowns: []};
      },
      planner: createPlannerPrdSequence().planner,
      "scenario-planner": () => SCENARIO_PLANNER_OUTPUT,
      "issue-slicer": () => ({
        summary: "One task",
        tasks: [
          {
            id: "greet",
            title: "Ship greeting",
            description: "Render the casual greeting.",
            acceptanceCriteria: ["Greeting is casual"],
            scenarioIds: ["greet-happy"],
            blockedBy: []}],
        proposedInstalls: []}),
      implementer: () => ({ summary: "Built", changedFiles: ["src/greet.ts"] }),
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "scenario-writer": () => ({ status: "implemented", summary: "Scenario tests", testPaths: ["tests/greet.test.ts"], changedFiles: ["tests/greet.test.ts"] }),      "message-writer": () => ({ subject: "feat: greet", body: "ok" })});

    const engine = new HarnessEngine(config, { backend });
    let state = await engine.start("Greeting with reopen");
    state = await engine.advance(state.runId);
    state = await engine.answer(state.runId, state.activeQuestionId!, "Confirmed brief");
    state = await engine.advance(state.runId);
    expect(state.phase).toBe("awaiting_input");
    expect(state.grillReady?.summary).toBe("Seemed ready");

    state = await engine.confirmGrill(state.runId, {
      feedback: "Please also decide the greeting length"});
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
      workflow: { maxGrillQuestionsPerEpisode: 1 } as never});
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
                recommendation: "Keep it short."}]};
        }
        return {
          status: "ready_to_plan",
          summary: "Done grilling",
          resolutions: []};
      },
      planner: createPlannerPrdSequence().planner,
      "scenario-planner": () => SCENARIO_PLANNER_OUTPUT,
      "issue-slicer": () => ({
        summary: "One task",
        tasks: [
          {
            id: "greet",
            title: "Ship greeting",
            description: "Render the casual greeting.",
            acceptanceCriteria: ["Greeting is casual"],
            scenarioIds: ["greet-happy"],
            blockedBy: []}],
        proposedInstalls: []}),
      implementer: () => ({ summary: "Built", changedFiles: ["src/greet.ts"] }),
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "scenario-writer": () => ({ status: "implemented", summary: "Scenario tests", testPaths: ["tests/greet.test.ts"], changedFiles: ["tests/greet.test.ts"] }),      "message-writer": () => ({ subject: "feat: greet", body: "ok" })});

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
      workflow: { staleAnswerMinutes: 30, maxGrillQuestionsPerEpisode: 5 } as never});
    const requests: AgentRequest[] = [];
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
      griller: (request) => {
        requests.push(request);
        if (request.providerSessionId) {
          return {
            status: "needs_input",
            summary: "first",
            questions: [FIRST_GRILL_QUESTION]};
        }
        if (String(request.prompt).includes("stale_answer") || String(request.prompt).includes("Casual")) {
          expect(request.providerSessionId).toBeUndefined();
          return {
            status: "ready_to_plan",
            summary: "Recovered from stale answer",
            resolutions: []};
        }
        return {
          status: "needs_input",
          summary: "first",
          questions: [FIRST_GRILL_QUESTION]};
      },
      planner: createPlannerPrdSequence().planner,
      "scenario-planner": () => SCENARIO_PLANNER_OUTPUT,
      "issue-slicer": () => ({
        summary: "One task",
        tasks: [
          {
            id: "greet",
            title: "Ship greeting",
            description: "Render the casual greeting.",
            acceptanceCriteria: ["Greeting is casual"],
            scenarioIds: ["greet-happy"],
            blockedBy: []}],
        proposedInstalls: []}),
      implementer: () => ({ summary: "Built", changedFiles: ["src/greet.ts"] }),
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "scenario-writer": () => ({ status: "implemented", summary: "Scenario tests", testPaths: ["tests/greet.test.ts"], changedFiles: ["tests/greet.test.ts"] }),      "message-writer": () => ({ subject: "feat: greet", body: "ok" })});

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
      )};
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
    expect([
      "planning",
      "executing",
      "scenario_testing",
      "crystallizing",
      "final_review",
      "publishing",
      "completed",
    ]).toContain(state.phase);
  });

  it("blocks a hung reflector and retries from the persisted phase", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      agent: { timeoutMs: 20 } as never,
      workflow: { maxProviderRetries: 0 } as never});
    const backend = createFakeBackend({
      reflector: () => new Promise(() => undefined)});
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
        ""].join("\n"),
      "utf8",
    );
    const config = fixtureConfig(root, {
      workflow: { testPathPatterns: ["tests/**"] } as never,
      commands: { verification: [{ id: "test", command: 'node -e "process.exit(0)"', timeoutMs: 600_000 }] }});
    const backend = createFakeBackend({ reflector: () => REFLECT_OUTPUT });
    const engine = new HarnessEngine(config, { backend });
    let state = await engine.start("mid-run test paths");
    const stamped = state.configurationHash;

    await writeProjectSettings(configPath, {
      workflow: { testPathPatterns: ["modules/**/src/test/**"] }});
    const project = fixtureConfig(root, {
      workflow: { testPathPatterns: ["modules/**/src/test/**"] } as never,
      commands: { verification: [{ id: "test", command: 'node -e "process.exit(0)"', timeoutMs: 600_000 }] }});
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
        ""].join("\n"),
      "utf8",
    );
    const config = fixtureConfig(root, {
      workflow: { testPathPatterns: ["tests/**"] } as never,
      commands: { verification: [{ id: "test", command: originalTest, timeoutMs: 600_000 }] }});
    const backend = createFakeBackend({ reflector: () => REFLECT_OUTPUT });
    const engine = new HarnessEngine(config, { backend });
    let state = await engine.start("mid-run hashed command");
    const stamped = state.configurationHash;

    await writeProjectSettings(configPath, {
      commands: { verification: [{ id: "test", command: "./gradlew test", timeoutMs: 600_000 }] }});
    const driftedProject = fixtureConfig(root, {
      workflow: { testPathPatterns: ["tests/**"] } as never,
      commands: { verification: [{ id: "test", command: "./gradlew test", timeoutMs: 600_000 }] }});
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
      reflector: () => REFLECT_OUTPUT});
    const engine = new HarnessEngine(config, { backend });
    let state = await engine.start("legacy");
    state = { ...state, configurationHash: hash, configVersion: 0 };
    await engine.store.writeJson(state.runId, "state.json", state);
    await engine.store.writeJson(state.runId, "config.json", {
      ...legacyConfig,
      configVersion: 0});

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
      workflow: { } as never,
      knowledge: {
        ...fixtureConfig(rootA).knowledge,
        sharedIndexDirectory: path.join(rootA, "shared-a")},
      stateDirectory: ".agent-harness-a"});
    const configB = fixtureConfig(rootB, {
      workflow: { } as never,
      knowledge: {
        ...fixtureConfig(rootB).knowledge,
        sharedIndexDirectory: path.join(rootB, "shared-b")},
      stateDirectory: ".agent-harness-b"});
    expect(configA.repositoryRoot).not.toBe(configB.repositoryRoot);
    expect(configA.stateDirectory).not.toBe(configB.stateDirectory);
    expect(configA.knowledge.sharedIndexDirectory).not.toBe(configB.knowledge.sharedIndexDirectory);

    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT});
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
      configurationHash: "legacy-pre-canonical-hash"};
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
      workflow: { } as never});
    let grillAttempts = 0;
    const backend: ReturnType<typeof createFakeBackend> = {
      async run(request) {
        if (request.role === "reflector") {
          return {
            output: REFLECT_OUTPUT,
            providerSessionId: "grill-agent",
            providerRunId: "run-1",
            providerSessionReused: false,
            submittedPrompt: request.prompt};
        }
        if (request.role === "griller") {
          grillAttempts += 1;
          if (grillAttempts === 1) {
            return {
              output: "not-json",
              providerSessionId: "grill-agent",
              providerRunId: "run-bad",
              providerSessionReused: Boolean(request.providerSessionId),
              submittedPrompt: request.continuationPrompt ?? request.prompt};
          }
          return {
            output: {
              status: "needs_input",
              summary: "Recovered",
              questions: [FIRST_GRILL_QUESTION]},
            providerSessionId: "grill-agent",
            providerRunId: "run-good",
            providerSessionReused: true,
            submittedPrompt: request.continuationPrompt ?? request.prompt};
        }
        throw new Error(`Unexpected role ${request.role}`);
      },
      async release() {}};

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
        generateCommitMessages: false}});
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
            summary: "Casual"}]}),
      planner: createPlannerPrdSequence().planner,
      "scenario-planner": () => SCENARIO_PLANNER_OUTPUT,
      "issue-slicer": () => ({
        summary: "One task",
        tasks: [
          {
            id: "greet",
            title: "Ship greeting",
            description: "Render the casual greeting.",
            acceptanceCriteria: ["Greeting is casual"],
            scenarioIds: ["greet-happy"],
            blockedBy: []}],
        proposedInstalls: []}),
      implementer: () => ({ summary: "Built", changedFiles: ["src/greet.ts"] }),
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "scenario-writer": () => ({ status: "implemented", summary: "Scenario tests", testPaths: ["tests/greet.test.ts"], changedFiles: ["tests/greet.test.ts"] }),      "message-writer": () => ({ subject: "should-not-be-used", body: "nope" })});
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

  it("prepares repository intelligence on start and blocks with a readable failure", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      knowledge: {
        ...fixtureConfig(root).knowledge,
        repositoryIntelligence: {
          ...fixtureConfig(root).knowledge.repositoryIntelligence,
          enabled: true,
          providers: {
            ...fixtureConfig(root).knowledge.repositoryIntelligence.providers,
            gitnexus: {
              ...fixtureConfig(root).knowledge.repositoryIntelligence.providers.gitnexus,
              enabled: false,
            },
            codegraph: {
              ...fixtureConfig(root).knowledge.repositoryIntelligence.providers.codegraph,
              enabled: true,
            },
          },
          routes: { search: ["codegraph"], "symbol-context": ["codegraph"] },
        }}});
    const runner = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "codegraph missing",
      timedOut: false});
    const engine = new HarnessEngine(config, {
      backend: createFakeBackend({}),
      repositoryIntelligenceRunner: runner});
    const state = await engine.start("Needs graph");
    expect(state.phase).toBe("blocked");
    expect(state.failure).toMatch(/CodeGraph|@colbymchenry\/codegraph|repository intelligence/i);
  });


  it("resolves a batch of independent questions in a single griller invocation", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { grillQuestionsPerBatch: 3 } as never});
    let grillCalls = 0;
    const batchQuestions = [
      { ...FIRST_GRILL_QUESTION, prompt: "Q1: formal or casual?", unknownId: "tone" },
      {
        ...FIRST_GRILL_QUESTION,
        prompt: "Q2: short or long?",
        unknownId: "length"},
      {
        ...FIRST_GRILL_QUESTION,
        prompt: "Q3: emoji or plain?",
        unknownId: "emoji"}];
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
              { id: "emoji", title: "Emoji", impact: "minor" }]};
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
      "scenario-planner": () => SCENARIO_PLANNER_OUTPUT,
      "issue-slicer": () => ({
        summary: "One task",
        tasks: [
          {
            id: "greet",
            title: "Ship greeting",
            description: "Render the casual greeting.",
            acceptanceCriteria: ["Greeting is casual"],
            scenarioIds: ["greet-happy"],
            blockedBy: []}],
        proposedInstalls: []}),
      implementer: () => ({ summary: "Built", changedFiles: ["src/greet.ts"] }),
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "scenario-writer": () => ({ status: "implemented", summary: "Scenario tests", testPaths: ["tests/greet.test.ts"], changedFiles: ["tests/greet.test.ts"] }),      "message-writer": () => ({ subject: "feat: greet", body: "ok" })});

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
      { questionId: batchIds[2]!, answer: "Plain" }]);
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
      workflow: { grillQuestionsPerBatch: 3 } as never});
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
              { ...FIRST_GRILL_QUESTION, prompt: "Skip: formal or casual?", unknownId: "skip" }],
            openUnknowns: [
              { id: "keep", title: "Keep decision", impact: "shaping" },
              { id: "skip", title: "Skip decision", impact: "minor" }]};
        }
        const prompt = String(request.prompt);
        expect(prompt).toContain("Kept answer");
        return {
          status: "ready_to_plan",
          summary: "Done, skip left for later",
          resolutions: [],
          // The griller still lists the skipped unknown; it was not re-asked.
          openUnknowns: [{ id: "skip", title: "Skip decision", impact: "minor" }]};
      },
      planner: createPlannerPrdSequence().planner,
      "scenario-planner": () => SCENARIO_PLANNER_OUTPUT,
      "issue-slicer": () => ({
        summary: "One task",
        tasks: [
          {
            id: "greet",
            title: "Ship greeting",
            description: "Render the casual greeting.",
            acceptanceCriteria: ["Greeting is casual"],
            scenarioIds: ["greet-happy"],
            blockedBy: []}],
        proposedInstalls: []}),
      implementer: () => ({ summary: "Built", changedFiles: ["src/greet.ts"] }),
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "scenario-writer": () => ({ status: "implemented", summary: "Scenario tests", testPaths: ["tests/greet.test.ts"], changedFiles: ["tests/greet.test.ts"] }),      "message-writer": () => ({ subject: "feat: greet", body: "ok" })});

    const engine = new HarnessEngine(config, { backend });
    let state = await engine.start("Greeting");
    state = await engine.advance(state.runId);
    state = await engine.answer(state.runId, state.activeQuestionId!, "Confirmed brief");
    state = await engine.advance(state.runId);
    const keepId = state.questions.find((q) => q.prompt.startsWith("Keep"))!.id;
    const skipId = state.questions.find((q) => q.prompt.startsWith("Skip"))!.id;

    state = await engine.answerMany(state.runId, [{ questionId: keepId, answer: "Kept answer" }], [
      skipId]);
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
      workflow: { grillQuestionsPerBatch: 3 } as never});
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
              { ...FIRST_GRILL_QUESTION, prompt: "Clarify: formal or casual?", unknownId: "clarify" }],
            openUnknowns: [
              { id: "keep", title: "Keep decision", impact: "shaping" },
              { id: "clarify", title: "Clarify decision", impact: "minor" }]};
        }
        const prompt = String(request.prompt);
        expect(prompt).toContain("Clarification requested on grill question");
        expect(prompt).toContain("What does formal mean for onboarding copy?");
        return {
          status: "ready_to_plan",
          summary: "Done after clarification",
          resolutions: [],
          openUnknowns: [{ id: "clarify", title: "Clarify decision", impact: "minor" }]};
      },
      planner: createPlannerPrdSequence().planner,
      "scenario-planner": () => SCENARIO_PLANNER_OUTPUT,
      "issue-slicer": () => ({
        summary: "One task",
        tasks: [
          {
            id: "greet",
            title: "Ship greeting",
            description: "Render the casual greeting.",
            acceptanceCriteria: ["Greeting is casual"],
            scenarioIds: ["greet-happy"],
            blockedBy: []}],
        proposedInstalls: []}),
      implementer: () => ({ summary: "Built", changedFiles: ["src/greet.ts"] }),
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "scenario-writer": () => ({ status: "implemented", summary: "Scenario tests", testPaths: ["tests/greet.test.ts"], changedFiles: ["tests/greet.test.ts"] }),      "message-writer": () => ({ subject: "feat: greet", body: "ok" })});

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
      workflow: { staleAnswerMinutes: 30, grillQuestionsPerBatch: 3 } as never});
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
            { ...FIRST_GRILL_QUESTION, prompt: "Two: formal or casual?" }]};
      },
      planner: createPlannerPrdSequence().planner,
      "scenario-planner": () => SCENARIO_PLANNER_OUTPUT,
      "issue-slicer": () => ({
        summary: "One task",
        tasks: [
          {
            id: "greet",
            title: "Ship greeting",
            description: "Render the casual greeting.",
            acceptanceCriteria: ["Greeting is casual"],
            scenarioIds: ["greet-happy"],
            blockedBy: []}],
        proposedInstalls: []}),
      implementer: () => ({ summary: "Built", changedFiles: ["src/greet.ts"] }),
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "scenario-writer": () => ({ status: "implemented", summary: "Scenario tests", testPaths: ["tests/greet.test.ts"], changedFiles: ["tests/greet.test.ts"] }),      "message-writer": () => ({ subject: "feat: greet", body: "ok" })});

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
      )};
    await engine.store.writeJson(state.runId, "state.json", state);

    state = await engine.answerMany(state.runId, [
      { questionId: grillIds[0]!, answer: "One" },
      { questionId: grillIds[1]!, answer: "Two" }]);
    const events = await readFile(
      path.join(root, ".agent-harness", "runs", state.runId, "events.jsonl"),
      "utf8",
    );
    // One stale-reset event for the whole batch, not one per question.
    expect(events.match(/grill\.episode_stale_reset/g)?.length).toBe(1);
    state = await engine.advance(state.runId);
    expect(state.grillReady?.summary).toBeTruthy();
    state = await confirmGrillAndAdvance(engine, state.runId);
    expect([
      "planning",
      "executing",
      "scenario_testing",
      "crystallizing",
      "final_review",
      "publishing",
      "completed",
    ]).toContain(state.phase);
  });

  it("stamps each grillResolution with its own resolutionSummaries entry", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: { grillQuestionsPerBatch: 3 } as never});
    let grillCalls = 0;
    let resolutionSummaries: Array<{ questionId: string; summary: string }> = [];
    const batchQuestions = [
      { ...FIRST_GRILL_QUESTION, prompt: "Q1: formal or casual?", unknownId: "tone" },
      { ...FIRST_GRILL_QUESTION, prompt: "Q2: short or long?", unknownId: "length" },
      { ...FIRST_GRILL_QUESTION, prompt: "Q3: emoji or plain?", unknownId: "emoji" }];
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
              { id: "emoji", title: "Emoji", impact: "minor" }]};
        }
        return {
          status: "ready_to_plan",
          summary: "Turn-level wrap-up of the batch",
          resolutionSummaries,
          resolutions: [],
          openUnknowns: []};
      },
      planner: createPlannerPrdSequence().planner,
      "scenario-planner": () => SCENARIO_PLANNER_OUTPUT,
      "issue-slicer": () => ({
        summary: "One task",
        tasks: [
          {
            id: "greet",
            title: "Ship greeting",
            description: "Render the casual greeting.",
            acceptanceCriteria: ["Greeting is casual"],
            scenarioIds: ["greet-happy"],
            blockedBy: []}],
        proposedInstalls: []}),
      implementer: () => ({ summary: "Built", changedFiles: ["src/greet.ts"] }),
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "scenario-writer": () => ({ status: "implemented", summary: "Scenario tests", testPaths: ["tests/greet.test.ts"], changedFiles: ["tests/greet.test.ts"] }),      "message-writer": () => ({ subject: "feat: greet", body: "ok" })});

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
      { questionId: ids[2]!, summary: "Settled on plain text without emoji" }];
    state = await engine.answerMany(state.runId, [
      { questionId: ids[0]!, answer: "Formal" },
      { questionId: ids[1]!, answer: "Short" },
      { questionId: ids[2]!, answer: "Plain" }]);
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
      workflow: { grillQuestionsPerBatch: 3 } as never});
    let grillCalls = 0;
    const batchQuestions = [
      { ...FIRST_GRILL_QUESTION, prompt: "Q1: formal or casual?", unknownId: "tone" },
      { ...FIRST_GRILL_QUESTION, prompt: "Q2: short or long?", unknownId: "length" },
      { ...FIRST_GRILL_QUESTION, prompt: "Q3: emoji or plain?", unknownId: "emoji" }];
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
              { id: "emoji", title: "Emoji", impact: "minor" }]};
        }
        // Intentionally omit resolutionSummaries — weaker models may do this.
        return {
          status: "ready_to_plan",
          summary: "Shared turn summary for the whole batch",
          resolutions: [],
          openUnknowns: []};
      },
      planner: createPlannerPrdSequence().planner,
      "scenario-planner": () => SCENARIO_PLANNER_OUTPUT,
      "issue-slicer": () => ({
        summary: "One task",
        tasks: [
          {
            id: "greet",
            title: "Ship greeting",
            description: "Render the casual greeting.",
            acceptanceCriteria: ["Greeting is casual"],
            scenarioIds: ["greet-happy"],
            blockedBy: []}],
        proposedInstalls: []}),
      implementer: () => ({ summary: "Built", changedFiles: ["src/greet.ts"] }),
      reviewer: () => ({ approved: true, summary: "ok", findings: [] }),
      "scenario-writer": () => ({ status: "implemented", summary: "Scenario tests", testPaths: ["tests/greet.test.ts"], changedFiles: ["tests/greet.test.ts"] }),      "message-writer": () => ({ subject: "feat: greet", body: "ok" })});

    const engine = new HarnessEngine(config, { backend });
    let state = await engine.start("Greeting");
    state = await engine.advance(state.runId);
    state = await engine.answer(state.runId, state.activeQuestionId!, "Confirmed brief");
    state = await engine.advance(state.runId);
    const ids = state.questions.filter((q) => q.purpose === "grill").map((q) => q.id);
    state = await engine.answerMany(state.runId, [
      { questionId: ids[0]!, answer: "Formal" },
      { questionId: ids[1]!, answer: "Short" },
      { questionId: ids[2]!, answer: "Plain" }]);
    state = await engine.advance(state.runId);

    expect(state.grillResolutions).toHaveLength(3);
    expect(state.grillResolutions.map((item) => item.summary)).toEqual([
      "Shared turn summary for the whole batch",
      "Shared turn summary for the whole batch",
      "Shared turn summary for the whole batch"]);
  });

  it("cold-starts the implementer when a run resumes without in-process session handles", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      workflow: {
        ...fixtureConfig(root).workflow,
        maxReviewAttempts: 2,
        maxImplementationAttempts: 3,
        generateCommitMessages: false},
      agent: { ...fixtureConfig(root).agent, promptBuilder: false }});
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
            submittedPrompt};
        }
        if (request.role === "reviewer" || request.role === "task-reviewer") {
          return {
            output: { approved: true, summary: "ok", findings: [] },
            providerSessionId: "review-1",
            providerRunId: "rev-run-1",
            providerSessionReused: false,
            submittedPrompt: request.prompt};
        }
        throw new Error(`Unexpected role ${request.role}`);
      },
      async release(providerSessionId) {
        aliveSessions.delete(providerSessionId);
      }});

    const hash = configurationHash(config);
    let state: RunState = {
      ...createRunState("cold-start-resume", "idea", new Date().toISOString(), hash, CONFIG_VERSION),
      phase: "executing",
      configurationHash: hash,
      reflectBrief: {
        draft: "d",
        confirmed: "Confirmed brief",
        confirmedAt: new Date().toISOString()},
      tasks: [
        {
          id: "greet",
          title: "Ship greeting",
          description: "Render greeting.",
          acceptanceCriteria: ["Works"],
          affectedPaths: [],
          blockedBy: [],
          status: "active",
          step: "implementing",
          attempts: { implementation: 1, review: 1 },
          evidence: [],
          testPaths: [],
          changedFiles: ["src/greet.ts"],
          reviewSummary: "Needs a null check\n- Handle null input",
          implementerSession: { providerSessionId: "impl-stale" }}]};
    const resumed = new HarnessEngine(config, { backend: makeBackend() });
    await resumed.store.initialize();
    await resumed.store.create(state);
    await resumed.store.writeJson(state.runId, "state.json", state);
    await resumed.store.writeJson(state.runId, "config.json", {
      ...config,
      configVersion: CONFIG_VERSION});

    state = await resumed.advance(state.runId);
    expect(implementerCalls).toBeGreaterThanOrEqual(1);
    expect(implementerPrompts[0]?.reused).toBe(false);
    expect(implementerPrompts[0]?.prompt).not.toContain("New authoritative input");
    expect(implementerPrompts[0]?.prompt).toContain("Ship greeting");
  });


  it("invokes implementer on first implementing attempt even for missing-symbol evidence", async () => {
    const fixture = await createProjectFixture();
    await fixture.initGit();
    const config = fixtureConfig(fixture.root, {
      git: { enabled: true, baseBranch: "main" } as never,
      workflow: { maxImplementationAttempts: 2 } as never,
      commands: {
        verification: [{ id: "test", command: 'node -e "process.exit(1)"', timeoutMs: 600_000 }],
      } as never});
    let implementerCalls = 0;
    const backend = createFakeBackend({
      implementer: async (request) => {
        implementerCalls += 1;
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(
          path.join(request.cwd, "src", "greet.ts"),
          "export const greet = () => \"hi\";\n",
          "utf8",
        );
        return { summary: "implemented", changedFiles: ["src/greet.ts"] };
      }});
    const engine = new HarnessEngine(config, { backend });
    const started = await engine.start("No false repair");
    const state = await engine.store.load(started.runId);
    const missingSymbolEvidence = {
      purpose: "test",
      command: "npm test",
      exitCode: 1,
      passed: false,
      stdout: "",
      stderr: [
        "tests/GreeterTest.java:12: error: cannot find symbol",
        "  symbol:   class Greeter",
        "  location: class GreeterTest",
        "Compilation failed"].join("\n"),
      durationMs: 10,
      at: new Date().toISOString()};
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
          status: "active",
          step: "implementing",
          attempts: { implementation: 0, review: 0 },
          evidence: [missingSymbolEvidence],
          testPaths: [],
          changedFiles: []}]});

    await engine.advance(started.runId);
    const events = await readFile(
      path.join(fixture.root, ".agent-harness", "runs", started.runId, "events.jsonl"),
      "utf8",
    );
    expect(events).not.toContain("task.test_repair_routed");
    expect(implementerCalls).toBeGreaterThanOrEqual(1);
    expect(implementerCalls).toBeLessThanOrEqual(2);
  });

  it("starts pending tasks on the implementer path, not legacy writing_tests", async () => {
    const roles: string[] = [];
    const fixture = await createProjectFixture();
    await fixture.initGit();
    const config = fixtureConfig(fixture.root, {
      git: { enabled: true, baseBranch: "main" } as never,
      workflow: {} as never,
      commands: {
        verification: [{ id: "test", command: 'node -e "process.exit(0)"', timeoutMs: 600_000 }],
      } as never});
    const backend = createFakeBackend({
      implementer: (request) => {
        roles.push(request.role);
        return { summary: "done", changedFiles: ["src/greet.ts"] };
      },
      "task-reviewer": (request) => {
        roles.push(request.role);
        return { approved: true, summary: "ok", findings: [] };
      }});
    const engine = new HarnessEngine(config, { backend });
    const started = await engine.start("Intent-first path");
    const state = await engine.store.load(started.runId);
    await engine.store.writeJson(started.runId, "state.json", {
      ...state,
      phase: "executing",
      treeFingerprint: await new GitService(config, engine.paths).treeFingerprint(),
      tasks: [
        {
          id: "intent-first",
          title: "Ship greeting",
          description: "Render greeting",
          acceptanceCriteria: ["done"],
          affectedPaths: ["src/greet.ts"],
          blockedBy: [],
          status: "pending",
          step: "pending",
          attempts: { implementation: 0, review: 0 },
          evidence: [],
          testPaths: [],
          changedFiles: []}]});

    const advanced = await engine.advance(started.runId);
    expect(roles).toContain("implementer");
    expect(advanced.tasks[0]?.step).not.toBe("writing_tests");
    expect(["implementing", "verifying", "reviewing", "committing", "done"]).toContain(
      advanced.tasks[0]?.step,
    );
  });
});
