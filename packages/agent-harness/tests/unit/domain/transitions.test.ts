import { describe, expect, it } from "vitest";
import {
  applyGrillOutput,
  applyPlan,
  applyQuestionAnswers,
  applyReflectOutput,
  applyTaskDone,
  assertAcyclic,
  assertCanAdvance,
  assertDependenciesExecutable,
  canMarkTaskDone,
  createRunState,
  hasOpenQuestionBatch,
  isTerminalPhase,
  taskFrontier,
  type BuildTask,
  type ReflectOutput,
  type RunPhase,
  type RunState,
} from "../../../src/domain.js";

const NOW = "2026-08-09T12:00:00.000Z";

const REFLECT: ReflectOutput = {
  summary: "Greeting",
  restatement: "Add a greeting",
  goal: "Ship greeting",
  users: ["users"],
  inScope: ["copy"],
  outOfScope: [],
  assumptions: [],
  unknowns: ["tone"],
};

function withPhase(phase: RunPhase): RunState {
  return { ...createRunState("run-1", "Add greeting", NOW), phase };
}

function evidence(purpose: string, passed = true) {
  return {
    purpose,
    command: "test",
    exitCode: passed ? 0 : 1,
    passed,
    stdout: "",
    stderr: "",
    durationMs: 1,
    at: NOW,
  };
}

function task(overrides: Partial<BuildTask> & Pick<BuildTask, "id">): BuildTask {
  return {
    title: overrides.title ?? overrides.id,
    description: "desc",
    acceptanceCriteria: ["works"],
    affectedPaths: [],
    blockedBy: [],
    tdd: true,
    testCommand: 'node -e "process.exit(0)"',
    status: "pending",
    step: "pending",
    attempts: { tests: 0, implementation: 0, review: 0 },
    evidence: [],
    testPaths: [],
    changedFiles: [],
    ...overrides,
  };
}

describe("domain transitions", () => {
  it("terminal states reject normal advancement", () => {
    for (const phase of ["completed", "blocked", "cancelled"] as const) {
      expect(isTerminalPhase(phase)).toBe(true);
      expect(() => assertCanAdvance(withPhase(phase))).toThrow(/terminal phase/);
    }
    expect(isTerminalPhase("executing")).toBe(false);
    expect(() => assertCanAdvance(withPhase("grilling"))).not.toThrow();
  });

  it("answered questions never revert to unanswered", () => {
    const drafted = applyReflectOutput(withPhase("reflecting"), REFLECT, NOW, {
      batchId: "batch-1",
      questionIds: ["q-reflect"],
    });
    const answered = applyQuestionAnswers(
      drafted.state,
      [{ questionId: "q-reflect", answer: "Confirmed brief" }],
      NOW,
    );
    expect(answered.state.questions[0]?.status).toBe("answered");
    expect(() =>
      applyQuestionAnswers(
        answered.state,
        [{ questionId: "q-reflect", answer: "try again" }],
        NOW,
      ),
    ).toThrow(/already answered/);
  });

  it("a task cannot be done before approval and required command evidence", () => {
    const pending = task({ id: "greet", step: "implementing", status: "active" });
    expect(canMarkTaskDone(pending)).toBe(false);

    const reviewing = task({
      id: "greet",
      step: "reviewing",
      status: "active",
      evidence: [evidence("tdd:green")],
    });
    expect(canMarkTaskDone(reviewing)).toBe(false);

    const ready = task({
      id: "greet",
      step: "committing",
      status: "active",
      evidence: [evidence("tdd:green")],
    });
    expect(canMarkTaskDone(ready)).toBe(true);

    const state = { ...withPhase("executing"), tasks: [ready] };
    const done = applyTaskDone(state, "greet", NOW, { commitSha: "abc" });
    expect(done.state.tasks[0]?.status).toBe("done");
    expect(done.events[0]?.type).toBe("task.committed");
  });

  it("allows only one active question batch", () => {
    const first = applyReflectOutput(withPhase("reflecting"), REFLECT, NOW, {
      batchId: "batch-1",
      questionIds: ["q-1"],
    });
    expect(hasOpenQuestionBatch(first.state)).toBe(true);
    expect(() =>
      applyReflectOutput(first.state, REFLECT, NOW, {
        batchId: "batch-2",
        questionIds: ["q-2"],
      }),
    ).toThrow(/one active question batch/);
  });

  it("dependencies must be acyclic and complete before execution", () => {
    expect(() =>
      assertAcyclic([
        { id: "a", blockedBy: ["b"] },
        { id: "b", blockedBy: ["a"] },
      ]),
    ).toThrow(/cycle/i);

    expect(() => assertAcyclic([{ id: "a", blockedBy: ["missing"] }])).toThrow(/unknown blocker/);

    const blocked = [
      task({ id: "a", blockedBy: ["b"], status: "pending" }),
      task({ id: "b", blockedBy: [], status: "pending" }),
    ];
    expect(taskFrontier(blocked).map((item) => item.id)).toEqual(["b"]);

    const pendingBehindDone = [
      task({ id: "a", blockedBy: ["b"], status: "pending" }),
      task({ id: "b", blockedBy: [], status: "done", step: "done" }),
    ];
    expect(() => assertDependenciesExecutable(pendingBehindDone)).not.toThrow();
    expect(taskFrontier(pendingBehindDone).map((item) => item.id)).toEqual(["a"]);
  });

  it("each valid transition produces a stable event name", () => {
    const reflect = applyReflectOutput(withPhase("reflecting"), REFLECT, NOW, {
      batchId: "batch-1",
      questionIds: ["q-reflect"],
    });
    expect(reflect.events.map((event) => event.type)).toEqual([
      "reflect.drafted",
      "question.asked",
    ]);

    const grilling: RunState = {
      ...reflect.state,
      phase: "grilling",
      reflectBrief: {
        draft: reflect.state.reflectBrief!.draft,
        structured: REFLECT,
        confirmed: "Confirmed",
        confirmedAt: NOW,
      },
      questions: reflect.state.questions.map((question) => ({
        ...question,
        status: "answered" as const,
        answer: "Confirmed",
        answeredAt: NOW,
      })),
      activeQuestionId: undefined,
    };

    const grillReady = applyGrillOutput(
      grilling,
      { parkedUnknownIds: [], batchCeiling: 3 },
      {
        status: "ready_to_plan",
        summary: "Ready",
        resolutionSummaries: [],
        resolutions: [
          { id: "tone", question: "Tone?", answer: "Casual", summary: "Casual" },
        ],
        openUnknowns: [],
      },
      NOW,
    );
    expect(grillReady.events.map((event) => event.type)).toEqual(["grill.ready"]);

    const plan = applyPlan(
      { ...grillReady.state, phase: "planning", grillReady: undefined },
      {
        summary: "One task",
        tasks: [
          {
            id: "greet",
            title: "Ship greeting",
            description: "Implement",
            acceptanceCriteria: ["works"],
            blockedBy: [],
          },
        ],
        proposedInstalls: [],
      },
      NOW,
      { tdd: true, testCommand: 'node -e "process.exit(0)"' },
    );
    expect(plan.events.map((event) => event.type)).toEqual(["plan.created"]);
    expect(plan.state.phase).toBe("executing");
  });
});
