import { describe, expect, it } from "vitest";
import type { ApplicationContext } from "../../src/application/application-context.js";
import {
  filterForTemplate,
  ScenarioTestingService,
} from "../../src/application/scenario-testing-service.js";
import { frozenCommandsHash } from "../../src/application/evidence-fingerprint.js";
import type { CommandResult } from "../../src/commands.js";
import type { BuildTask, RunState, TestScenario } from "../../src/domain.js";

const INCIDENT_STDERR =
  "No tests found for given includes: [civcraft/src/main/test/com/avrgaming/civcraft/BuildableAreaValidationTest.java](--tests filter)";

function scenario(overrides: Partial<TestScenario> = {}): TestScenario {
  return {
    id: "SC-BA-001",
    title: "Buildable area validation",
    kind: "happy-path",
    intent: "validate buildable areas",
    given: "a town chunk",
    when: "a structure is placed",
    then: "the area is validated",
    taskIds: [],
    status: "active",
    attempts: 0,
    writerAttempts: 1,
    repairAttempts: 0,
    testPaths: ["civcraft/src/main/test/com/avrgaming/civcraft/BuildableAreaValidationTest.java"],
    seenEvidenceFingerprints: [],
    seenRepairEdges: [],
    reviewFindings: [],
    ...overrides,
  };
}

function task(overrides: Partial<BuildTask> = {}): BuildTask {
  return {
    id: "buildable-area",
    title: "Buildable area",
    description: "Implement buildable area validation",
    acceptanceCriteria: ["areas validated"],
    ...overrides,
  } as BuildTask;
}

function stateFor(scenarios: TestScenario[], tasks: BuildTask[] = []): RunState {
  return {
    runId: "run-1",
    phase: "scenario_testing",
    scenarios,
    tasks,
  } as unknown as RunState;
}

type FakeCtxOptions = {
  testTargetTemplate?: string;
  run: (command: string) => Partial<CommandResult>;
  invoke?: (request: { role: string; knowledgeQuery?: string }) => unknown;
};

function fakeCtx(options: FakeCtxOptions) {
  const invocations: Array<{ role: string; knowledgeQuery?: string }> = [];
  const commandsRun: string[] = [];
  const ctx = {
    config: {
      workflow: {
        maxImplementationAttempts: 3,
        testPathPatterns: ["**/*.test.ts", "**/*Test.java"],
      },
      commands: {
        verification: [{ id: "test", command: "gradlew.bat test", timeoutMs: 600_000 }],
        testTargetTemplate: options.testTargetTemplate ?? "gradlew.bat test --tests {filter}",
      },
      git: { enabled: false },
    },
    store: {
      record: async (state: RunState) => state,
    },
    agents: {
      invoke: async (request: { role: string; knowledgeQuery?: string }) => {
        invocations.push(request);
        if (options.invoke) return options.invoke(request);
        throw new Error(`unexpected agent invocation: ${request.role}`);
      },
    },
    deps: {
      commands: {
        run: async (command: string): Promise<CommandResult> => {
          commandsRun.push(command);
          return {
            command,
            exitCode: 0,
            stdout: "",
            stderr: "",
            durationMs: 1,
            timedOut: false,
            ...options.run(command),
          };
        },
      },
    },
    paths: { workspaceRoot: "D:/workspace" },
    signalFor: () => undefined,
    commandEnvironmentOptions: () => ({ passEnv: [], protectedEnvNames: [] }),
    git: { treeFingerprint: async () => "tree" },
  } as unknown as ApplicationContext;
  return { ctx, invocations, commandsRun };
}

describe("filterForTemplate", () => {
  it("converts a Java test path to a wildcard class-name pattern for --tests templates", () => {
    expect(
      filterForTemplate(
        "civcraft/src/main/test/com/avrgaming/civcraft/BuildableAreaValidationTest.java",
        "gradlew.bat test --tests {filter}",
      ),
    ).toBe("*BuildableAreaValidationTest");
  });

  it("handles Windows separators", () => {
    expect(
      filterForTemplate(
        "civcraft\\src\\main\\test\\BuildableAreaValidationTest.java",
        "gradlew.bat test --tests {filter}",
      ),
    ).toBe("*BuildableAreaValidationTest");
  });

  it("passes the path through for non-Gradle templates", () => {
    expect(
      filterForTemplate("tests/greet.test.ts", "vitest run {filter}"),
    ).toBe("tests/greet.test.ts");
    expect(filterForTemplate("tests/test_greet.py", "pytest {filter}")).toBe(
      "tests/test_greet.py",
    );
  });
});

describe("ScenarioTestingService no-tests routing", () => {
  it("blocks the recorded Gradle incident as config without invoking any agent", async () => {
    const { ctx, invocations, commandsRun } = fakeCtx({
      run: () => ({ exitCode: 1, stderr: INCIDENT_STDERR }),
    });
    const service = new ScenarioTestingService(ctx);
    const next = await service.advance(stateFor([scenario()]));

    expect(next.phase).toBe("blocked");
    expect(next.blockedFrom).toBe("scenario_testing");
    expect(next.blockedKind).toBe("config");
    expect(next.failure).toContain("found no tests");
    expect(next.failure).toContain(
      "gradlew.bat test --tests *BuildableAreaValidationTest",
    );
    expect(invocations).toHaveLength(0);
    // The rendered command converts the file path to a wildcard class-name filter.
    expect(commandsRun).toEqual(["gradlew.bat test --tests *BuildableAreaValidationTest"]);
    // The scenario stays active so a fixed template re-runs it on resume.
    expect(next.scenarios[0]?.status).toBe("active");
  });

  it("blocks a missing test command as config without invoking any agent", async () => {
    const { ctx, invocations } = fakeCtx({
      run: () => ({
        exitCode: 1,
        stderr: "'gradlew.bat' is not recognized as an internal or external command",
      }),
    });
    const service = new ScenarioTestingService(ctx);
    const next = await service.advance(stateFor([scenario()]));

    expect(next.phase).toBe("blocked");
    expect(next.blockedKind).toBe("config");
    expect(next.failure).toContain("could not be launched");
    expect(invocations).toHaveLength(0);
  });

  it("still routes behavioral failures to the implementer", async () => {
    const { ctx, invocations } = fakeCtx({
      run: () => ({
        exitCode: 1,
        stdout:
          "BuildableAreaValidationTest > rejects overlap FAILED\norg.opentest4j.AssertionFailedError: expected: <true> but was: <false>",
      }),
      invoke: () => ({ summary: "no-op", changedFiles: [] }),
    });
    const service = new ScenarioTestingService(ctx);
    const next = await service.advance(stateFor([scenario()]));

    expect(invocations.map((call) => call.role)).toEqual(["implementer"]);
    // Second identical evidence hits the progress gate.
    expect(next.phase).toBe("blocked");
    expect(next.blockedKind).toBe("no_progress");
  });
});

describe("scenario-writer knowledge seeding", () => {
  it("seeds the writer query with linked tasks' changed files and symbols", async () => {
    const { ctx, invocations } = fakeCtx({
      run: () => ({ exitCode: 0 }),
      invoke: () => ({
        status: "implemented",
        summary: "tests written",
        testPaths: ["tests/greet.test.ts"],
        changedFiles: ["tests/greet.test.ts"],
      }),
    });
    const service = new ScenarioTestingService(ctx);
    const linked = task({
      changedFiles: ["civcraft/src/main/java/com/avrgaming/civcraft/Buildable.java"],
      affectedPaths: ["civcraft/src/main/java/com/avrgaming/civcraft"],
    } as Partial<BuildTask>);
    const pending = scenario({ status: "pending", testPaths: [], taskIds: [linked.id] });

    const next = await service.advance(stateFor([pending], [linked]));

    expect(invocations.map((call) => call.role)).toEqual(["scenario-writer"]);
    expect(invocations[0]?.knowledgeQuery).toContain("Buildable");
    expect(next.scenarios[0]?.status).toBe("passing");
  });
});

describe("frozenCommandsHash", () => {
  const verification = [{ id: "test", command: "gradlew.bat test", timeoutMs: 600_000 }];

  it("is stable for identical commands", () => {
    expect(
      frozenCommandsHash({ verification, testTargetTemplate: "gradlew.bat test --tests {filter}" }),
    ).toBe(
      frozenCommandsHash({ verification, testTargetTemplate: "gradlew.bat test --tests {filter}" }),
    );
  });

  it("changes when testTargetTemplate or verification commands change", () => {
    const base = frozenCommandsHash({
      verification,
      testTargetTemplate: "gradlew.bat test --tests {filter}",
    });
    expect(
      frozenCommandsHash({ verification, testTargetTemplate: "gradlew.bat test --tests {filter} --info" }),
    ).not.toBe(base);
    expect(
      frozenCommandsHash({
        verification: [{ id: "test", command: "gradlew.bat check", timeoutMs: 600_000 }],
        testTargetTemplate: "gradlew.bat test --tests {filter}",
      }),
    ).not.toBe(base);
    expect(frozenCommandsHash({ verification })).not.toBe(base);
  });
});
