import { describe, expect, it } from "vitest";
import {
  buildFixerInput,
  buildGrillerInput,
  buildImageFixerInput,
  buildImplementerInput,
  buildImplementerRepairInput,
  buildIssueSlicerInput,
  buildMessageWriterInput,
  buildPlannerInput,
  buildProjectProfilerInput,
  buildReflectorInput,
  buildReviewerInput,
  buildScenarioPlannerInput,
  buildTaskReviewerInput,
} from "../../src/domain/role-packets.js";
import type { Task } from "../../src/domain/types.js";

const brief = {
  confirmed: "## Goal\n\nShip status",
  structured: {
    restatement: "Add status",
    goal: "Expose health",
    unknowns: ["should not appear"],
  },
};

describe("role packet builders", () => {
  it("buildReflectorInput includes only idea", () => {
    expect(buildReflectorInput({ idea: "Add status" })).toEqual({ idea: "Add status" });
  });

  it("buildGrillerInput slims brief and flattens resolutions", () => {
    const packet = buildGrillerInput({
      brief,
      fog: [{ id: "fog-1", text: "who?", status: "open" }],
      notes: "prefer JSON",
      resolutions: { users: "ops" },
    });
    expect(Object.keys(packet).sort()).toEqual(["brief", "fog", "notes", "resolutions"]);
    expect(packet.brief).toBe("## Goal\n\nShip status");
    expect(packet.resolutions).toEqual({ users: "ops" });
  });

  it("buildProjectProfilerInput keeps brief, liveVerification, and runtime only", () => {
    const packet = buildProjectProfilerInput({
      brief,
      liveVerification: { command: "npm test", testGlobs: ["**/*.test.ts"] },
      runtime: { mode: "docker", image: "worker:latest", dockerfile: "FROM node:22\n" },
    });
    expect(Object.keys(packet).sort()).toEqual(["brief", "liveVerification", "runtime"]);
    expect(packet).not.toHaveProperty("idea");
    expect(packet).not.toHaveProperty("fog");
    expect(packet).not.toHaveProperty("resolutions");
    expect(packet.brief).toBe("## Goal\n\nShip status");
    expect(packet.runtime).toEqual({
      mode: "docker",
      image: "worker:latest",
      dockerfile: "FROM node:22\n",
    });
  });

  it("buildPlannerInput drops open fog and glossary", () => {
    const packet = buildPlannerInput({
      brief,
      resolutions: { users: "ops" },
      fogResolutions: [{ id: "fog-1", source: "user", reason: "decided" }],
      planningFeedback: "tighten scope",
      operatorNotes: "note",
    });
    expect(Object.keys(packet).sort()).toEqual([
      "brief",
      "fogResolutions",
      "operatorNotes",
      "planningFeedback",
      "resolutions",
    ]);
    expect(packet).not.toHaveProperty("fog");
    expect(packet).not.toHaveProperty("glossary");
  });

  it("buildScenarioPlannerInput and buildIssueSlicerInput keep planning keys", () => {
    expect(
      Object.keys(
        buildScenarioPlannerInput({
          plan: "plan",
          prd: { title: "t", body: "b" },
          planningFeedback: "more",
        }),
      ).sort(),
    ).toEqual(["plan", "planningFeedback", "prd"]);
    expect(
      Object.keys(
        buildIssueSlicerInput({
          plan: "plan",
          prd: { title: "t", body: "b" },
          scenarios: [{ id: "s1" }],
        }),
      ).sort(),
    ).toEqual(["plan", "prd", "scenarios"]);
  });

  it("buildImplementerInput slims task, brief, and verification", () => {
    const task: Task = {
      id: "t1",
      title: "Wire route",
      description: "Add GET /status",
      status: "in_progress",
      verification: {
        command: "npm test",
        passed: false,
        classification: "project_failure",
        output: "fail",
        exitCode: 1,
      },
    };
    const packet = buildImplementerInput({
      task,
      brief,
      plan: "1. Implement",
      reviewFeedback: "fix edge case",
      verification: task.verification,
    });
    expect(packet.task).toEqual({
      id: "t1",
      title: "Wire route",
      description: "Add GET /status",
    });
    expect(packet.brief).toBe("## Goal\n\nShip status");
    expect(packet.verification).toEqual({
      command: "npm test",
      passed: false,
      classification: "project_failure",
      output: "fail",
    });
    expect(packet).not.toHaveProperty("status");
  });

  it("buildImplementerRepairInput slims tasks", () => {
    const packet = buildImplementerRepairInput({
      repair: true,
      finalReview: { verdict: "reject", summary: "missing guard" },
      plan: "plan",
      tasks: [
        {
          id: "t1",
          title: "A",
          description: "d",
          status: "committed",
          commitSha: "abc",
          reviewSummary: "noise",
        },
      ],
    });
    expect(packet.tasks).toEqual([
      { id: "t1", title: "A", description: "d", commitSha: "abc" },
    ]);
  });

  it("buildTaskReviewerInput and buildReviewerInput use slim shapes", () => {
    const task: Task = {
      id: "t1",
      title: "A",
      description: "d",
      status: "in_progress",
    };
    const taskReview = buildTaskReviewerInput({
      task,
      implemented: { summary: "done" },
    });
    expect(Object.keys(taskReview).sort()).toEqual(["implemented", "task"]);
    const review = buildReviewerInput({
      plan: "plan",
      tasks: [task],
      scenarioTest: { passed: true },
      verification: {
        command: "npm test",
        passed: true,
        classification: "passed",
        output: "ok",
      },
    });
    expect(Object.keys(review).sort()).toEqual([
      "plan",
      "scenarioTest",
      "tasks",
      "verification",
    ]);
    expect(review).not.toHaveProperty("scenarios");
  });

  it("buildFixerInput, buildMessageWriterInput, and buildImageFixerInput match contracts", () => {
    expect(buildFixerInput({ failure: "boom", scenarios: [] })).toEqual({
      failure: "boom",
      scenarios: [],
    });
    const message = buildMessageWriterInput({
      idea: "Ship it",
      plan: "plan",
      tasks: [
        {
          id: "t1",
          title: "Done",
          description: "d",
          status: "committed",
          commitSha: "abc",
        },
        { id: "t2", title: "Pending", description: "d", status: "pending" },
      ],
    });
    expect(message.tasks).toEqual([
      { id: "t1", title: "Done", description: "d", commitSha: "abc" },
    ]);
    expect(
      buildImageFixerInput({
        command: "npm test",
        output: "missing curl",
        dockerfile: "FROM node:22\n",
        image: "run-tag",
      }),
    ).toEqual({
      command: "npm test",
      output: "missing curl",
      dockerfile: "FROM node:22\n",
      image: "run-tag",
    });
  });
});
