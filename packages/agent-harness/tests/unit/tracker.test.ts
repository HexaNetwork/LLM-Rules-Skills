import path from "node:path";
import { resolveHarnessPaths } from "../../src/application/paths.js";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { BuildTaskSchema, createRunState, createTddLoop } from "../../src/domain.js";
import { RunStore } from "../../src/store.js";
import { LocalTracker } from "../../src/tracker.js";
import { createProjectFixture, type ProjectFixture } from "../testkit/project-fixture.js";

describe("local tracker", () => {
  let fixture: ProjectFixture | undefined;

  afterEach(async () => {
    if (fixture) {
      await fixture.cleanup();
      fixture = undefined;
    }
  });

  it("writes the confirmed brief and grill resolutions", async () => {
    fixture = await createProjectFixture();
    const store = new RunStore(fixture.config, resolveHarnessPaths(fixture.config).stateRoot);
    await store.initialize();
    const now = new Date().toISOString();
    let state = createRunState("brief-test", "Ship billing", now);
    await store.create(state);
    state = {
      ...state,
      phase: "grilling",
      reflectBrief: {
        draft: "Draft brief",
        confirmed: "Confirmed billing brief",
        confirmedAt: now,
      },
      grillResolutions: [
        {
          id: "q-1",
          question: "Which provider?",
          answer: "Stripe",
          summary: "Use Stripe",
          resolvedAt: now,
        },
      ],
    };
    await new LocalTracker(store).sync(state);

    const brief = await readFile(path.join(store.runDirectory(state.runId), "brief.md"), "utf8");
    const grill = await readFile(path.join(store.runDirectory(state.runId), "grill.md"), "utf8");
    expect(brief).toContain("Confirmed billing brief");
    expect(brief).toContain("confirmed");
    expect(brief).not.toContain("## Idea");
    expect(brief).not.toContain("Ship billing");
    expect(grill).toContain("Which provider?");
    expect(grill).toContain("Stripe");
  });

  it("renders TDD round ledger and coverage in task artifacts", async () => {
    fixture = await createProjectFixture();
    const store = new RunStore(fixture.config, resolveHarnessPaths(fixture.config).stateRoot);
    await store.initialize();
    const now = new Date().toISOString();
    const task = BuildTaskSchema.parse({
      id: "task-1",
      title: "Greet users",
      description: "Return a greeting",
      acceptanceCriteria: ["returns hello"],
      blockedBy: [],
      tdd: true,
      status: "active",
      step: "writing_tests",
      attempts: { tests: 1, implementation: 1, review: 0 },
      tddLoop: createTddLoop({
        round: 2,
        atVerifiedGreen: true,
        completedRounds: [
          {
            number: 1,
            outcome: "already-covered",
            testPathsAdded: ["tests/greet.test.ts"],
            behaviorsAdded: ["greets"],
            edgeCasesAdded: ["empty name"],
            completedAt: now,
          },
        ],
        pendingRound: {
          number: 2,
          mode: "feature",
          behaviorsAdded: ["farewell"],
          edgeCasesAdded: [],
          testPathsAdded: ["tests/bye.test.ts"],
          startedAt: now,
        },
        coverage: {
          behaviors: ["greets"],
          edgeCases: ["empty name"],
          finalAssessment: {
            acceptanceCriteria: [
              {
                criterionIndex: 0,
                covered: true,
                testPaths: ["tests/greet.test.ts"],
                rationale: "Asserts greeting string",
              },
            ],
            edgeCaseRationale: "Empty name covered in round 1",
          },
        },
        redWriterSession: { turns: 2 },
        greenImplementerSession: { turns: 1 },
      }),
    });
    let state = createRunState("tdd-artifact", "Ship greeting", now);
    await store.create(state);
    state = { ...state, phase: "executing", tasks: [task] };
    await new LocalTracker(store).sync(state);

    const artifact = await readFile(
      path.join(store.runDirectory(state.runId), "tasks/task-1-greet-users.md"),
      "utf8",
    );
    expect(artifact).toContain("## TDD loop");
    expect(artifact).toContain("**Active role:** red-writer");
    expect(artifact).toContain("### Pending round 2 (feature)");
    expect(artifact).toContain("already-covered (no production delta)");
    expect(artifact).toContain("#### Final coverage assessment");
    expect(artifact).toContain("Empty name covered in round 1");
    expect(artifact).toContain("red 2 turns · green 1 turns");
  });
});
