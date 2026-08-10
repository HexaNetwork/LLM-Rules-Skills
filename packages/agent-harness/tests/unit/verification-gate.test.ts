import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeBackend } from "../../src/agent.js";
import { configurationHash } from "../../src/config.js";
import { HarnessEngine } from "../../src/engine.js";
import { VerificationSettingsPatchSchema } from "../../src/domain.js";
import {
  confirmGrillAndAdvance,
  fixtureConfig,
  fixtureRoot,
  passingCommandRunner,
} from "../helpers.js";

const REFLECT_OUTPUT = {
  proposedTitle: "Add greeting tone",
  summary: "Restated",
  restatement: "Ship greeting.",
  goal: "Greet users",
  users: ["users"],
  inScope: ["greeting"],
  outOfScope: [],
  assumptions: [],
  unknowns: [],
};

const PLAN = {
  summary: "Plan",
  tasks: [
    {
      id: "one",
      title: "First",
      description: "Do first",
      acceptanceCriteria: ["ok"],
      blockedBy: [] as string[],
      tdd: false,
    },
  ],
};

describe("verification settings gate", () => {
  it("proposes → awaiting_input → confirm → planning, and skips re-proposal after confirm", async () => {
    const root = await fixtureRoot();
    let profilerCalls = 0;
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
      griller: () => ({
        status: "ready_to_plan",
        summary: "Ready",
        resolutions: [],
      }),
      "project-profiler": () => {
        profilerCalls += 1;
        return {
          summary: "Use vitest for this package",
          configPatch: {
            commands: { test: "npm run test:unit" },
            workflow: { testPathPatterns: ["**/*.test.ts"] },
          },
        };
      },
      planner: () => PLAN,
    });
    const config = fixtureConfig(root, {
      workflow: { tdd: false } as never,
      agent: { promptBuilder: false } as never,
      commands: { test: "npm test" } as never,
    });
    const engine = new HarnessEngine(config, {
      backend,
      commands: passingCommandRunner(),
    });
    let state = await engine.start("Ship greeting");
    state = await engine.advance(state.runId);
    const reflectQ = state.questions.find((item) => item.status === "open");
    state = await engine.answerMany(state.runId, [
      { questionId: reflectQ!.id, answer: REFLECT_OUTPUT.restatement },
    ]);
    state = await engine.advance(state.runId);
    expect(state.grillReady?.summary).toBeTruthy();

    state = await engine.confirmGrill(state.runId);
    state = await engine.advance(state.runId);
    expect(state.phase).toBe("awaiting_input");
    expect(state.verificationReady?.summary).toContain("vitest");
    expect(state.verificationReady?.proposedPatch.commands?.test).toBe("npm run test:unit");
    expect(profilerCalls).toBe(1);

    // Resume while gate is open must not re-invoke the profiler.
    state = await engine.advance(state.runId);
    expect(state.phase).toBe("awaiting_input");
    expect(profilerCalls).toBe(1);

    state = await engine.confirmVerification(state.runId, {
      patch: state.verificationReady!.proposedPatch,
    });
    expect(state.phase).toBe("planning");
    expect(state.verificationReady).toBeUndefined();
    expect(state.verificationConfirmedAt).toBeTruthy();
    expect(engine.config.commands.test).toBe("npm run test:unit");
    expect(engine.config.workflow.testPathPatterns).toEqual(["**/*.test.ts"]);

    const frozen = JSON.parse(
      await readFile(
        path.join(root, ".agent-harness", "runs", state.runId, "config.json"),
        "utf8",
      ),
    ) as { commands: { test: string }; workflow: { testPathPatterns: string[] } };
    expect(frozen.commands.test).toBe("npm run test:unit");
    expect(frozen.workflow.testPathPatterns).toEqual(["**/*.test.ts"]);
    expect(state.configurationHash).toBe(configurationHash(engine.config));

    state = await engine.advance(state.runId);
    expect(state.verificationBaselinePassedAt).toBeTruthy();
    expect(state.tasks).toHaveLength(1);
    expect(profilerCalls).toBe(1);
  });

  it("keep-current confirms without changing frozen config", async () => {
    const root = await fixtureRoot();
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
      griller: () => ({
        status: "ready_to_plan",
        summary: "Ready",
        resolutions: [],
      }),
      "project-profiler": () => ({
        summary: "Suggested change",
        configPatch: { commands: { test: "pytest" } },
      }),
      planner: () => PLAN,
    });
    const config = fixtureConfig(root, {
      workflow: { tdd: false } as never,
      agent: { promptBuilder: false } as never,
      commands: { test: "npm test" } as never,
    });
    const engine = new HarnessEngine(config, {
      backend,
      commands: passingCommandRunner(),
    });
    let state = await engine.start("Ship greeting");
    state = await engine.advance(state.runId);
    state = await engine.answerMany(state.runId, [
      { questionId: state.activeQuestionId!, answer: REFLECT_OUTPUT.restatement },
    ]);
    state = await engine.advance(state.runId);
    state = await engine.confirmGrill(state.runId);
    state = await engine.advance(state.runId);
    expect(state.verificationReady).toBeTruthy();

    state = await engine.confirmVerification(state.runId, { keepCurrent: true });
    expect(state.verificationConfirmedAt).toBeTruthy();
    expect(engine.config.commands.test).toBe("npm test");
    state = await engine.advance(state.runId);
    expect(state.verificationBaselinePassedAt).toBeTruthy();
    expect(state.tasks).toHaveLength(1);
  });

  it("rejects unrelated keys on the verification patch schema", () => {
    expect(() =>
      VerificationSettingsPatchSchema.parse({
        git: { autoCommitPreflight: true },
      }),
    ).toThrow();
    expect(() =>
      VerificationSettingsPatchSchema.parse({
        workflow: { maxGrillQuestionsPerEpisode: 3 },
      }),
    ).toThrow();
    expect(
      VerificationSettingsPatchSchema.parse({
        commands: { test: "npm test" },
        workflow: { testPathPatterns: ["**/*.test.ts"] },
      }),
    ).toEqual({
      commands: { test: "npm test" },
      workflow: { testPathPatterns: ["**/*.test.ts"] },
    });
  });

  it("enables tools when verification evidence is thin", async () => {
    const root = await fixtureRoot();
    let observedAllowTools: boolean | undefined;
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
      griller: () => ({
        status: "ready_to_plan",
        summary: "Ready",
        resolutions: [],
      }),
      "project-profiler": (request) => {
        observedAllowTools = request.allowTools;
        return {
          summary: "No manifests; proposing npm from brief",
          configPatch: { commands: { test: "npm test -- --run" } },
        };
      },
      planner: () => PLAN,
    });
    const config = fixtureConfig(root, {
      workflow: { tdd: false } as never,
      agent: { promptBuilder: false } as never,
    });
    const engine = new HarnessEngine(config, {
      backend,
      commands: passingCommandRunner(),
    });
    let state = await engine.start("Ship greeting");
    state = await engine.advance(state.runId);
    state = await engine.answerMany(state.runId, [
      { questionId: state.activeQuestionId!, answer: REFLECT_OUTPUT.restatement },
    ]);
    state = await engine.advance(state.runId);
    state = await engine.confirmGrill(state.runId);
    state = await engine.advance(state.runId);
    expect(state.verificationReady).toBeTruthy();
    expect(observedAllowTools).toBe(true);
  });

  it("keeps tools off when nested single-stack evidence is strong", async () => {
    const root = await fixtureRoot();
    await mkdir(path.join(root, "civcraft"), { recursive: true });
    await writeFile(path.join(root, "settings.gradle.kts"), 'rootProject.name = "demo"\n', "utf8");
    await writeFile(path.join(root, "gradlew"), "#!/bin/sh\n", "utf8");
    await writeFile(path.join(root, "civcraft", "build.gradle.kts"), "plugins { java }\n", "utf8");
    await mkdir(path.join(root, "civcraft", "src", "main", "test"), { recursive: true });
    await writeFile(
      path.join(root, "civcraft", "src", "main", "test", "ThingTest.java"),
      "class ThingTest {}\n",
      "utf8",
    );

    let observedAllowTools: boolean | undefined;
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
      griller: () => ({
        status: "ready_to_plan",
        summary: "Ready",
        resolutions: [],
      }),
      "project-profiler": (request) => {
        observedAllowTools = request.allowTools;
        return {
          summary: "Use Gradle wrapper tests",
          configPatch: {
            commands: { test: "./gradlew test" },
            workflow: {
              testPathPatterns: ["**/src/main/test/**", "**/*Test.java"],
            },
          },
        };
      },
      planner: () => PLAN,
    });
    const config = fixtureConfig(root, {
      workflow: { tdd: false } as never,
      agent: { promptBuilder: false } as never,
    });
    const engine = new HarnessEngine(config, {
      backend,
      commands: passingCommandRunner(),
    });
    let state = await engine.start("Ship greeting");
    state = await engine.advance(state.runId);
    state = await engine.answerMany(state.runId, [
      { questionId: state.activeQuestionId!, answer: REFLECT_OUTPUT.restatement },
    ]);
    state = await engine.advance(state.runId);
    state = await engine.confirmGrill(state.runId);
    state = await engine.advance(state.runId);
    expect(state.verificationReady?.evidence?.sampleTestPaths).toEqual(
      expect.arrayContaining(["civcraft/src/main/test/ThingTest.java"]),
    );
    expect(observedAllowTools).toBe(false);
  });

  it("confirmGrillAndAdvance clears verification before planning", async () => {
    const root = await fixtureRoot();
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
      griller: () => ({
        status: "ready_to_plan",
        summary: "Ready",
        resolutions: [],
      }),
      planner: () => PLAN,
    });
    const config = fixtureConfig(root, {
      workflow: { tdd: false } as never,
      agent: { promptBuilder: false } as never,
    });
    const engine = new HarnessEngine(config, {
      backend,
      commands: passingCommandRunner(),
    });
    let state = await engine.start("Ship greeting");
    state = await engine.advance(state.runId);
    state = await engine.answerMany(state.runId, [
      { questionId: state.activeQuestionId!, answer: REFLECT_OUTPUT.restatement },
    ]);
    state = await engine.advance(state.runId);
    state = await confirmGrillAndAdvance(engine, state.runId);
    expect(state.verificationReady).toBeUndefined();
    expect(state.verificationConfirmedAt).toBeTruthy();
    expect(state.verificationBaselinePassedAt).toBeTruthy();
    expect(state.tasks.length).toBeGreaterThan(0);
  });

  it("opens a baseline gate on failure and retries with an edited command", async () => {
    const root = await fixtureRoot();
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
      griller: () => ({
        status: "ready_to_plan",
        summary: "Ready",
        resolutions: [],
      }),
      "project-profiler": () => ({
        summary: "Broken command",
        configPatch: { commands: { test: "failing-baseline" } },
      }),
      planner: () => PLAN,
    });
    const config = fixtureConfig(root, {
      workflow: { tdd: false } as never,
      agent: { promptBuilder: false } as never,
      commands: { test: "npm test" } as never,
    });
    const engine = new HarnessEngine(config, {
      backend,
      commands: {
        async run(command) {
          if (command === "failing-baseline") {
            return {
              command,
              exitCode: 1,
              stdout: "1 failed",
              stderr: "",
              durationMs: 3,
              timedOut: false,
            };
          }
          return {
            command,
            exitCode: 0,
            stdout: "",
            stderr: "",
            durationMs: 1,
            timedOut: false,
          };
        },
      },
    });
    let state = await engine.start("Ship greeting");
    state = await engine.advance(state.runId);
    state = await engine.answerMany(state.runId, [
      { questionId: state.activeQuestionId!, answer: REFLECT_OUTPUT.restatement },
    ]);
    state = await engine.advance(state.runId);
    state = await engine.confirmGrill(state.runId);
    state = await engine.advance(state.runId);
    state = await engine.confirmVerification(state.runId, {
      patch: state.verificationReady!.proposedPatch,
    });
    state = await engine.advance(state.runId);
    expect(state.phase).toBe("awaiting_input");
    expect(state.verificationBaselineReady?.summary).toMatch(/failed/i);
    expect(state.verificationBaselineReady?.evidence.command).toBe("failing-baseline");
    expect(state.verificationBaselinePassedAt).toBeUndefined();

    // Resume must not re-run while the gate is open.
    const before = state.verificationBaselineReady!.readyAt;
    state = await engine.advance(state.runId);
    expect(state.verificationBaselineReady?.readyAt).toBe(before);

    state = await engine.retryVerificationBaseline(state.runId, {
      testCommand: 'node -e "process.exit(0)"',
    });
    expect(state.verificationBaselineReady).toBeUndefined();
    expect(state.verificationBaselinePassedAt).toBeTruthy();
    expect(engine.config.commands.test).toBe('node -e "process.exit(0)"');
    expect(state.phase).toBe("planning");

    state = await engine.advance(state.runId);
    expect(state.tasks).toHaveLength(1);
  });

  it("treats greenfield no-tests output as an acceptable baseline", async () => {
    const root = await fixtureRoot();
    const backend = createFakeBackend({
      reflector: () => REFLECT_OUTPUT,
      griller: () => ({
        status: "ready_to_plan",
        summary: "Ready",
        resolutions: [],
      }),
      "project-profiler": () => ({
        summary: "Empty suite",
        configPatch: { commands: { test: "vitest run" } },
      }),
      planner: () => PLAN,
    });
    const config = fixtureConfig(root, {
      workflow: { tdd: false } as never,
      agent: { promptBuilder: false } as never,
    });
    const engine = new HarnessEngine(config, {
      backend,
      commands: {
        async run(command) {
          return {
            command,
            exitCode: 1,
            stdout: "No test files found",
            stderr: "",
            durationMs: 5,
            timedOut: false,
          };
        },
      },
    });
    let state = await engine.start("Ship greeting");
    state = await engine.advance(state.runId);
    state = await engine.answerMany(state.runId, [
      { questionId: state.activeQuestionId!, answer: REFLECT_OUTPUT.restatement },
    ]);
    state = await engine.advance(state.runId);
    state = await engine.confirmGrill(state.runId);
    state = await engine.advance(state.runId);
    state = await engine.confirmVerification(state.runId, {
      patch: state.verificationReady!.proposedPatch,
    });
    state = await engine.advance(state.runId);
    expect(state.verificationBaselineReady).toBeUndefined();
    expect(state.verificationBaselinePassedAt).toBeTruthy();
    expect(state.tasks).toHaveLength(1);
  });
});
