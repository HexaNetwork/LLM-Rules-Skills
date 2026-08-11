import { describe, expect, it } from "vitest";
import {
  BuildTaskSchema,
  GreenImplementerOutputSchema,
  RedWriterOutputSchema,
  TddLoopSchema,
  canAcceptRedContinue,
  canAcceptRedDone,
  canCompleteTddRound,
  canEnterFinalVerification,
  canRetryFinalRepair,
  canRetryRoundImplementation,
  canRouteTestIssue,
  createTddLoop,
  describeActiveTddStatus,
  reviewRepairRoute,
  withCompletedTddRound,
  withFinalRepairCleared,
  withFinalRepairRouting,
  withIncrementedRoundImplementerAttempt,
  withTestRepairPendingRound,
} from "../../../src/domain.js";

const NOW = "2026-08-11T12:00:00.000Z";

function minimalTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    title: "Greeting",
    description: "Add greeting",
    acceptanceCriteria: ["returns hello"],
    blockedBy: [],
    tdd: true,
    status: "pending",
    step: "pending",
    attempts: { tests: 0, implementation: 0, review: 0 },
    ...overrides,
  };
}

describe("tddLoop schema defaults", () => {
  it("applies defaults when parsing an empty tddLoop object", () => {
    const loop = TddLoopSchema.parse({});
    expect(loop).toEqual({
      round: 1,
      atVerifiedGreen: false,
      finalRepairPending: false,
      finalRepairAttempts: 0,
      completedRounds: [],
      coverage: { behaviors: [], edgeCases: [] },
    });
  });

  it("parses stored task JSON without tddLoop and leaves it undefined", () => {
    const parsed = BuildTaskSchema.parse(minimalTask());
    expect(parsed.tddLoop).toBeUndefined();
    expect(parsed.redCheckpointPaths).toEqual([]);
    expect(parsed.integrityViolationCount).toBe(0);
  });

  it("applies nested tddLoop defaults on a terse fixture task", () => {
    const parsed = BuildTaskSchema.parse(
      minimalTask({
        tddLoop: {
          pendingRound: {
            number: 1,
            mode: "feature",
            startedAt: NOW,
          },
        },
      }),
    );
    expect(parsed.tddLoop?.round).toBe(1);
    expect(parsed.tddLoop?.atVerifiedGreen).toBe(false);
    expect(parsed.tddLoop?.finalRepairAttempts).toBe(0);
    expect(parsed.tddLoop?.completedRounds).toEqual([]);
    expect(parsed.tddLoop?.coverage).toEqual({ behaviors: [], edgeCases: [] });
    expect(parsed.tddLoop?.pendingRound).toMatchObject({
      number: 1,
      mode: "feature",
      testPathsAdded: [],
      behaviorsAdded: [],
      edgeCasesAdded: [],
      implementerAttempts: 0,
      startedAt: NOW,
    });
  });

  it("defaults completed-round targetedEvidencePurpose to tdd:green", () => {
    const loop = TddLoopSchema.parse({
      completedRounds: [
        {
          number: 1,
          outcome: "implemented",
          testPathsAdded: ["tests/a.test.ts"],
          behaviorsAdded: ["greets"],
          edgeCasesAdded: [],
          completedAt: NOW,
        },
      ],
    });
    expect(loop.completedRounds[0]?.targetedEvidencePurpose).toBe("tdd:green");
  });
});

describe("agent output contracts", () => {
  it("parses red-writer continue and done outputs", () => {
    const cont = RedWriterOutputSchema.parse({
      status: "continue",
      summary: "batch 1",
      changedFiles: ["tests/a.test.ts"],
      behaviorsAdded: ["greets"],
    });
    expect(cont.status).toBe("continue");
    if (cont.status === "continue") {
      expect(cont.edgeCasesAdded).toEqual([]);
    }

    const done = RedWriterOutputSchema.parse({
      status: "done",
      summary: "complete",
      changedFiles: [],
      acceptanceCoverage: [
        {
          criterionIndex: 0,
          covered: true,
          testPaths: ["tests/a.test.ts"],
          rationale: "asserted",
        },
      ],
      edgeCaseRationale: "empty and boundary covered",
    });
    expect(done.status).toBe("done");
    if (done.status === "done") {
      expect(done.acceptanceCoverage[0]?.verificationMode).toBe("automated-test");
    }

    const operatorConfigured = RedWriterOutputSchema.parse({
      status: "done",
      summary: "complete without freezing operator policy",
      changedFiles: [],
      acceptanceCoverage: [
        {
          criterionIndex: 1,
          covered: true,
          verificationMode: "not-validated",
          testPaths: [],
          rationale: "The selected value remains operator owned.",
        },
      ],
      edgeCaseRationale: "Configuration mechanics are covered with synthetic boundaries.",
    });
    expect(operatorConfigured.status).toBe("done");
    if (operatorConfigured.status === "done") {
      expect(operatorConfigured.acceptanceCoverage[0]?.verificationMode).toBe("not-validated");
    }
    expect(() =>
      RedWriterOutputSchema.parse({
        status: "done",
        summary: "incorrectly claims a test for operator policy",
        changedFiles: [],
        acceptanceCoverage: [
          {
            criterionIndex: 1,
            covered: true,
            verificationMode: "not-validated",
            testPaths: ["tests/config-values.test.ts"],
            rationale: "must be rejected",
          },
        ],
        edgeCaseRationale: "n/a",
      }),
    ).toThrow(/may not claim automated test paths/);
  });

  it("rejects continue without behaviors or files, and done with dirty changedFiles", () => {
    expect(() =>
      RedWriterOutputSchema.parse({
        status: "continue",
        summary: "x",
        changedFiles: [],
        behaviorsAdded: ["greets"],
      }),
    ).toThrow();
    expect(() =>
      RedWriterOutputSchema.parse({
        status: "continue",
        summary: "x",
        changedFiles: ["tests/a.test.ts"],
        behaviorsAdded: [],
      }),
    ).toThrow();
    expect(() =>
      RedWriterOutputSchema.parse({
        status: "done",
        summary: "x",
        changedFiles: ["tests/a.test.ts"],
        acceptanceCoverage: [],
        edgeCaseRationale: "n/a",
      }),
    ).toThrow();
  });

  it("parses green-implementer green and test_issue outputs", () => {
    expect(
      GreenImplementerOutputSchema.parse({
        status: "already_green",
        summary: "covered",
        changedFiles: [],
      }).status,
    ).toBe("already_green");
    expect(
      GreenImplementerOutputSchema.parse({
        status: "test_issue",
        summary: "bad assertion",
        changedFiles: [],
        testPath: "tests/a.test.ts",
        reason: "expects wrong return",
        evidence: "AssertionError: …",
      }).status,
    ).toBe("test_issue");
  });
});

describe("tdd loop guards and attempt accounting", () => {
  const continueOutput = RedWriterOutputSchema.parse({
    status: "continue",
    summary: "batch",
    changedFiles: ["tests/a.test.ts"],
    behaviorsAdded: ["greets"],
    edgeCasesAdded: ["empty name"],
  });

  const doneOutput = RedWriterOutputSchema.parse({
    status: "done",
    summary: "complete",
    changedFiles: [],
    acceptanceCoverage: [
      {
        criterionIndex: 0,
        covered: true,
        testPaths: ["tests/a.test.ts"],
        rationale: "covered",
      },
    ],
    edgeCaseRationale: "ok",
  });

  const greenOutput = GreenImplementerOutputSchema.parse({
    status: "green",
    summary: "implemented",
    changedFiles: ["src/a.ts"],
  });

  const testIssueOutput = GreenImplementerOutputSchema.parse({
    status: "test_issue",
    summary: "bad test",
    changedFiles: [],
    testPath: "tests/a.test.ts",
    reason: "wrong expectation",
    evidence: "fail",
  });

  it("accepts continue only for test-only dirty paths with behaviors", () => {
    expect(
      canAcceptRedContinue({
        output: continueOutput,
        dirtyTestPaths: ["tests/a.test.ts"],
        dirtyNonTestPaths: [],
      }),
    ).toEqual({ ok: true });
    expect(
      canAcceptRedContinue({
        output: continueOutput,
        dirtyTestPaths: [],
        dirtyNonTestPaths: [],
      }).ok,
    ).toBe(false);
    expect(
      canAcceptRedContinue({
        output: continueOutput,
        dirtyTestPaths: ["tests/a.test.ts"],
        dirtyNonTestPaths: ["src/a.ts"],
      }).ok,
    ).toBe(false);
  });

  it("accepts done only at verified green with completed rounds and a clean tree", () => {
    const ready = createTddLoop({
      atVerifiedGreen: true,
      completedRounds: [
        {
          number: 1,
          outcome: "implemented",
          testPathsAdded: ["tests/a.test.ts"],
          behaviorsAdded: ["greets"],
          edgeCasesAdded: [],
          targetedEvidencePurpose: "tdd:green",
          completedAt: NOW,
        },
      ],
    });
    expect(canAcceptRedDone({ output: doneOutput, tddLoop: ready, dirtyPaths: [] })).toEqual({
      ok: true,
    });
    expect(
      canAcceptRedDone({
        output: doneOutput,
        tddLoop: createTddLoop({ atVerifiedGreen: false, completedRounds: ready.completedRounds }),
        dirtyPaths: [],
      }).ok,
    ).toBe(false);
    expect(
      canAcceptRedDone({
        output: doneOutput,
        tddLoop: createTddLoop({
          atVerifiedGreen: true,
          pendingRound: {
            number: 2,
            mode: "feature",
            startedAt: NOW,
          },
          completedRounds: ready.completedRounds,
        }),
        dirtyPaths: [],
      }).ok,
    ).toBe(false);
    expect(
      canAcceptRedDone({
        output: doneOutput,
        tddLoop: createTddLoop({ atVerifiedGreen: true }),
        dirtyPaths: [],
      }).ok,
    ).toBe(false);
  });

  it("gates round completion and test_issue on a pending round", () => {
    const open = createTddLoop({
      pendingRound: {
        number: 1,
        mode: "feature",
        testPathsAdded: ["tests/a.test.ts"],
        behaviorsAdded: ["greets"],
        startedAt: NOW,
      },
    });
    expect(
      canCompleteTddRound({
        output: greenOutput,
        tddLoop: open,
        targetedEvidencePassed: true,
      }),
    ).toEqual({ ok: true });
    expect(
      canCompleteTddRound({
        output: greenOutput,
        tddLoop: createTddLoop(),
        targetedEvidencePassed: true,
      }).ok,
    ).toBe(false);
    expect(
      canCompleteTddRound({
        output: greenOutput,
        tddLoop: open,
        targetedEvidencePassed: false,
      }).ok,
    ).toBe(false);
    expect(canRouteTestIssue({ output: testIssueOutput, tddLoop: open })).toEqual({ ok: true });
    expect(canRouteTestIssue({ output: testIssueOutput, tddLoop: createTddLoop() }).ok).toBe(false);
  });

  it("tracks per-round implementer attempts separately from final repair budget", () => {
    let loop = createTddLoop({
      pendingRound: {
        number: 1,
        mode: "feature",
        startedAt: NOW,
        implementerAttempts: 0,
      },
    });
    expect(canRetryRoundImplementation(loop, 3)).toBe(true);
    loop = withIncrementedRoundImplementerAttempt(loop);
    loop = withIncrementedRoundImplementerAttempt(loop);
    loop = withIncrementedRoundImplementerAttempt(loop);
    expect(loop.pendingRound?.implementerAttempts).toBe(3);
    expect(canRetryRoundImplementation(loop, 3)).toBe(false);

    // Cumulative-looking diagnostic attempts do not affect final-repair budget helpers.
    expect(canRetryFinalRepair(loop, 3)).toBe(true);
    loop = withFinalRepairRouting(loop);
    expect(loop.finalRepairPending).toBe(true);
    expect(loop.finalRepairAttempts).toBe(1);
    loop = withFinalRepairRouting(loop);
    loop = withFinalRepairRouting(loop);
    expect(canRetryFinalRepair(loop, 3)).toBe(false);
    loop = withFinalRepairCleared(loop);
    expect(loop.finalRepairPending).toBe(false);
    expect(loop.finalRepairAttempts).toBe(3);
    expect(loop.atVerifiedGreen).toBe(true);
  });

  it("routes structured review findings without parsing prose", () => {
    expect(
      reviewRepairRoute([
        { severity: "blocking", kind: "test-coverage" },
        { severity: "advisory", kind: "production" },
      ]),
    ).toBe("test-coverage");
    expect(
      reviewRepairRoute([{ severity: "blocking", kind: "production" }]),
    ).toBe("production");
    expect(
      reviewRepairRoute([
        { severity: "blocking", kind: "production" },
        { severity: "blocking", kind: "test-coverage" },
      ]),
    ).toBe("production");
    expect(reviewRepairRoute([{ severity: "advisory", kind: "advisory" }])).toBe("none");
  });

  it("allows final verification only after RED done at verified green", () => {
    expect(canEnterFinalVerification(createTddLoop()).ok).toBe(false);
    expect(
      canEnterFinalVerification(
        createTddLoop({
          atVerifiedGreen: true,
          completedRounds: [
            {
              number: 1,
              outcome: "implemented",
              testPathsAdded: ["tests/a.test.ts"],
              behaviorsAdded: ["greet"],
              edgeCasesAdded: [],
              targetedEvidencePurpose: "tdd:green",
              completedAt: NOW,
            },
          ],
        }),
      ),
    ).toEqual({ ok: true });
    expect(
      canEnterFinalVerification(
        createTddLoop({
          atVerifiedGreen: true,
          finalRepairPending: true,
          completedRounds: [
            {
              number: 1,
              outcome: "implemented",
              testPathsAdded: ["tests/a.test.ts"],
              behaviorsAdded: ["greet"],
              edgeCasesAdded: [],
              targetedEvidencePurpose: "tdd:green",
              completedAt: NOW,
            },
          ],
        }),
      ).ok,
    ).toBe(false);
  });

  it("completes a round and preserves attempt count across test-repair mode flips", () => {
    let loop = createTddLoop({
      pendingRound: {
        number: 2,
        mode: "feature",
        redCheckpointSha: "abc",
        testPathsAdded: ["tests/b.test.ts"],
        behaviorsAdded: ["farewell"],
        edgeCasesAdded: ["null"],
        implementerAttempts: 2,
        startedAt: NOW,
      },
      coverage: { behaviors: ["greets"], edgeCases: [] },
    });
    loop = withTestRepairPendingRound(loop);
    expect(loop.pendingRound).toMatchObject({
      number: 2,
      mode: "test-repair",
      implementerAttempts: 2,
    });
    loop = withCompletedTddRound(loop, { outcome: "implemented", completedAt: NOW });
    expect(loop.pendingRound).toBeUndefined();
    expect(loop.round).toBe(3);
    expect(loop.atVerifiedGreen).toBe(true);
    expect(loop.completedRounds).toHaveLength(1);
    expect(loop.completedRounds[0]).toMatchObject({
      number: 2,
      outcome: "implemented",
      targetedEvidencePurpose: "tdd:green",
    });
    expect(loop.coverage.behaviors).toEqual(["greets", "farewell"]);
    expect(loop.coverage.edgeCases).toEqual(["null"]);
  });
});

describe("describeActiveTddStatus", () => {
  it("summarizes round, role, and retained session turns for an active TDD task", () => {
    const task = BuildTaskSchema.parse(
      minimalTask({
        status: "active",
        step: "implementing",
        tddLoop: createTddLoop({
          round: 2,
          atVerifiedGreen: true,
          pendingRound: {
            number: 2,
            mode: "feature",
            behaviorsAdded: ["farewell"],
            edgeCasesAdded: ["empty"],
            testPathsAdded: ["tests/b.test.ts"],
            implementerAttempts: 1,
            startedAt: NOW,
          },
          completedRounds: [
            {
              number: 1,
              outcome: "implemented",
              testPathsAdded: ["tests/a.test.ts"],
              behaviorsAdded: ["greets"],
              edgeCasesAdded: [],
              completedAt: NOW,
            },
          ],
          redWriterSession: { turns: 3 },
          greenImplementerSession: { turns: 2 },
        }),
      }),
    );
    expect(describeActiveTddStatus(task)).toBe(
      "round 2 · green-implementer · 1 completed · red 3 turns · green 2 turns · at verified green · batch 1 behaviors / 1 edge cases",
    );
  });
});
