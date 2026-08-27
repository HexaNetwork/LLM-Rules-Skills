import { describe, expect, it } from "vitest";
import { invokeModeFor } from "../../src/domain/agent-roles.js";
import {
  shouldResumeFinalReviewer,
  shouldResumeImplementer,
  shouldResumeTaskReviewer,
} from "../../src/domain/role-agents.js";
import type { Run, Task } from "../../src/domain/types.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Do work",
    description: "desc",
    status: "in_progress",
    ...overrides,
  };
}

function runWithArtifacts(artifacts: Record<string, unknown>): Run {
  return {
    identity: {
      runId: "run-1",
      projectKey: "demo",
      workflowBundleId: "default",
      controlRoot: "/tmp",
      worktreePath: "/tmp/work",
      baseSha: "0".repeat(40),
      baseBranch: "main",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    state: {
      runId: "run-1",
      status: "active",
      phase: "implement",
      idea: "idea",
      revision: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      artifacts,
      fog: [],
      tasks: [],
    },
    settings: {} as Run["settings"],
  };
}

describe("agent invoke modes", () => {
  it("routes reviewers through agent sessions so resume is available", () => {
    expect(invokeModeFor("task-reviewer")).toBe("agent");
    expect(invokeModeFor("reviewer")).toBe("agent");
    expect(invokeModeFor("docs-writer")).toBe("completion");
  });
});

describe("implementer resume policy", () => {
  it("starts a fresh agent for the first attempt on a task", () => {
    expect(shouldResumeImplementer(task({ attempts: { implementation: 0, review: 0 } }))).toBe(false);
    expect(shouldResumeImplementer(task())).toBe(false);
  });

  it("resumes the agent when retrying after verification or review failure", () => {
    expect(
      shouldResumeImplementer(task({ attempts: { implementation: 1, review: 0 } })),
    ).toBe(true);
    expect(shouldResumeImplementer(task({ reviewSummary: "Fix the regression" }))).toBe(true);
  });
});

describe("task-reviewer resume policy", () => {
  it("starts fresh on the first review for a task", () => {
    expect(shouldResumeTaskReviewer(task({ attempts: { implementation: 0, review: 0 } }))).toBe(false);
  });

  it("resumes when re-reviewing after a rejection on the same task", () => {
    expect(shouldResumeTaskReviewer(task({ attempts: { implementation: 1, review: 1 } }))).toBe(true);
  });
});

describe("final reviewer resume policy", () => {
  it("starts fresh before any repair attempt", () => {
    expect(shouldResumeFinalReviewer(runWithArtifacts({}))).toBe(false);
  });

  it("resumes after an implementer repair pass", () => {
    expect(shouldResumeFinalReviewer(runWithArtifacts({ finalReviewAttempts: 1 }))).toBe(true);
  });
});
