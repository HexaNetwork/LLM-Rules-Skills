import { describe, expect, it } from "vitest";
import {
  HISTORICAL_TRIGGER_SUMMARY,
  buildAgentActivity,
  deriveInvocationOutcome,
  type ActivityEventInput,
  type InvocationRecord} from "../../src/application/agent-activity.js";

function record(overrides: Partial<InvocationRecord> & Pick<InvocationRecord, "sessionId" | "path">): InvocationRecord {
  return {
    role: "implementer",
    model: "composer",
    status: "completed",
    attempt: 0,
    startedAt: "2026-08-10T20:00:00.000Z",
    endedAt: "2026-08-10T20:01:00.000Z",
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    ...overrides};
}

function event(
  overrides: Partial<ActivityEventInput> & Pick<ActivityEventInput, "sequence" | "type" | "at">,
): ActivityEventInput {
  return {
    detail: {},
    ...overrides};
}

describe("buildAgentActivity", () => {
  it("groups three implementer records sharing one providerSessionId into one context", () => {
    const activity = buildAgentActivity([
      record({
        path: "sessions/a.json",
        sessionId: "a",
        providerSessionId: "ctx-1",
        providerSessionReused: false,
        startedAt: "2026-08-10T20:07:00.000Z",
        invocationKind: "initial",
        trigger: {
          event: "task.implementing",
          classification: "initial",
          summary: "initial implementation"}}),
      record({
        path: "sessions/b.json",
        sessionId: "b",
        providerSessionId: "ctx-1",
        providerSessionReused: true,
        startedAt: "2026-08-10T20:10:00.000Z",
        invocationKind: "implementation-repair",
        usage: { inputTokens: 200, outputTokens: 40, totalTokens: 240 },
        trigger: {
          event: "task.implementation_repair_needed",
          classification: "verification",
          summary: "implementation repair",
          previousInvocationId: "inv-a"}}),
      record({
        path: "sessions/c.json",
        sessionId: "c",
        providerSessionId: "ctx-1",
        providerSessionReused: true,
        startedAt: "2026-08-10T20:12:00.000Z",
        invocationKind: "continuation",
        usage: { inputTokens: 300, outputTokens: 60, totalTokens: 360 }})]);

    expect(activity.providerContexts).toHaveLength(1);
    expect(activity.totals).toEqual({
      providerContexts: 1,
      invocations: 3,
      continuedInvocations: 2,
      schemaRepairs: 0});
    const context = activity.providerContexts[0]!;
    expect(context.id).toBe("ctx-1");
    expect(context.invocationCount).toBe(3);
    expect(context.invocations.map((item) => item.contextTurn)).toEqual([1, 2, 3]);
    expect(context.usage).toMatchObject({ inputTokens: 600, outputTokens: 120, totalTokens: 720 });
    expect(context.invocations[0]!.triggerSummary).toBe("initial implementation");
    expect(activity.timeline).toHaveLength(3);
    expect(activity.timeline.map((item) => item.sequence)).toEqual([1, 2, 3]);
  });

  it("creates one synthetic context per record when providerSessionId is missing", () => {
    const activity = buildAgentActivity([
      record({ path: "sessions/a.json", sessionId: "a", startedAt: "2026-08-10T20:00:00.000Z" }),
      record({ path: "sessions/b.json", sessionId: "b", startedAt: "2026-08-10T20:01:00.000Z" })]);
    expect(activity.providerContexts).toHaveLength(2);
    expect(activity.providerContexts.map((item) => item.id)).toEqual([
      "synthetic:b",
      "synthetic:a"]);
  });

  it("marks mixed roles and uses the latest outcome when a group spans statuses", () => {
    const activity = buildAgentActivity([
      record({
        path: "sessions/a.json",
        sessionId: "a",
        providerSessionId: "shared",
        role: "implementer",
        status: "completed",
        startedAt: "2026-08-10T20:00:00.000Z"}),
      record({
        path: "sessions/b.json",
        sessionId: "b",
        providerSessionId: "shared",
        role: "reviewer",
        status: "failed",
        startedAt: "2026-08-10T20:02:00.000Z"})]);
    expect(activity.providerContexts[0]!.role).toBe("mixed");
    expect(activity.providerContexts[0]!.status).toBe("failed");
  });

  it("counts schema-repair records sharing an invocationId", () => {
    const activity = buildAgentActivity([
      record({
        path: "sessions/a.json",
        sessionId: "a",
        invocationId: "inv-1",
        providerSessionId: "ctx",
        attempt: 0,
        startedAt: "2026-08-10T20:00:00.000Z",
        status: "failed"}),
      record({
        path: "sessions/b.json",
        sessionId: "b",
        invocationId: "inv-1",
        providerSessionId: "ctx",
        attempt: 1,
        invocationKind: "schema-repair",
        startedAt: "2026-08-10T20:00:30.000Z",
        status: "completed"})]);
    expect(activity.totals.schemaRepairs).toBe(1);
    expect(activity.providerContexts[0]!.schemaRepairCount).toBe(1);
    expect(activity.providerContexts[0]!.status).toBe("completed");
  });

  it("keeps running status when any invocation is still running", () => {
    const activity = buildAgentActivity([
      record({
        path: "sessions/a.json",
        sessionId: "a",
        providerSessionId: "ctx",
        status: "completed",
        startedAt: "2026-08-10T20:00:00.000Z"}),
      record({
        path: "sessions/b.json",
        sessionId: "b",
        providerSessionId: "ctx",
        status: "running",
        startedAt: "2026-08-10T20:01:00.000Z",
        endedAt: undefined})]);
    expect(activity.providerContexts[0]!.status).toBe("running");
    expect(activity.providerContexts[0]!.endedAt).toBeUndefined();
  });

  it("orders contexts newest-first and labels historical triggers", () => {
    const activity = buildAgentActivity([
      record({
        path: "sessions/later.json",
        sessionId: "later",
        providerSessionId: "b",
        startedAt: "2026-08-10T21:00:00.000Z"}),
      record({
        path: "sessions/earlier.json",
        sessionId: "earlier",
        providerSessionId: "a",
        startedAt: "2026-08-10T20:00:00.000Z"})]);
    expect(activity.providerContexts.map((item) => item.id)).toEqual(["b", "a"]);
    expect(activity.providerContexts[1]!.invocations[0]!.triggerSummary).toBe(
      HISTORICAL_TRIGGER_SUMMARY,
    );
  });

  it("interleaves invocations from different provider contexts chronologically", () => {
    const activity = buildAgentActivity([
      record({
        path: "sessions/impl-1.json",
        sessionId: "impl-1",
        role: "implementer",
        providerSessionId: "impl-ctx",
        startedAt: "2026-08-11T10:31:04.000Z",
        outcome: { status: "implemented" }}),
      record({
        path: "sessions/review-1.json",
        sessionId: "review-1",
        role: "reviewer",
        providerSessionId: "review-ctx",
        startedAt: "2026-08-11T10:39:48.000Z",
        outcome: { status: "approved" }}),
      record({
        path: "sessions/impl-2.json",
        sessionId: "impl-2",
        role: "implementer",
        providerSessionId: "impl-ctx",
        providerSessionReused: true,
        startedAt: "2026-08-11T10:45:11.000Z",
        invocationKind: "continuation",
        outcome: { status: "repaired" }})]);

    expect(activity.providerContexts).toHaveLength(2);
    expect(activity.timeline.map((entry) => {
      if (entry.type !== "invocation") return entry.type;
      return entry.invocation.sessionId;
    })).toEqual(["impl-1", "review-1", "impl-2"]);
    const implContext = activity.providerContexts.find((item) => item.id === "impl-ctx")!;
    expect(implContext.invocations.map((item) => item.contextTurn)).toEqual([1, 2]);
  });

  it("keeps implementer turns separated by verification and reviewer activity", () => {
    const activity = buildAgentActivity(
      [
        record({
          path: "sessions/impl-1.json",
          sessionId: "impl-1",
          role: "implementer",
          taskId: "task-1",
          providerSessionId: "impl-ctx",
          startedAt: "2026-08-11T10:31:04.000Z",
          invocationKind: "initial",
          outcome: { status: "implemented", summary: "done" },
          trigger: {
            event: "task.implementing",
            classification: "initial",
            summary: "initial"}}),
        record({
          path: "sessions/review-1.json",
          sessionId: "review-1",
          role: "reviewer",
          taskId: "task-1",
          providerSessionId: "review-ctx",
          startedAt: "2026-08-11T10:34:22.000Z",
          outcome: {
            status: "blocking",
            blockingCount: 1,
            repairRoute: "production",
            summary: "production finding"}}),
        record({
          path: "sessions/impl-2.json",
          sessionId: "impl-2",
          role: "implementer",
          taskId: "task-1",
          providerSessionId: "impl-ctx",
          providerSessionReused: true,
          startedAt: "2026-08-11T10:39:48.000Z",
          invocationKind: "review-repair",
          outcome: { status: "repaired" },
          trigger: {
            event: "task.implementation_repair_needed",
            classification: "review-repair",
            summary: "repair"}}),
        record({
          path: "sessions/review-2.json",
          sessionId: "review-2",
          role: "reviewer",
          taskId: "task-1",
          providerSessionId: "review-ctx-2",
          startedAt: "2026-08-11T10:46:04.000Z",
          outcome: {
            status: "approved",
            blockingCount: 0}}),
      ],
      [
        event({
          sequence: 10,
          type: "task.gates_passed",
          at: "2026-08-11T10:34:18.000Z",
          detail: { taskId: "task-1" }}),
        event({
          sequence: 11,
          type: "task.review_failed",
          at: "2026-08-11T10:34:23.000Z",
          detail: { taskId: "task-1", reviewRepairRoute: "production" }}),
        event({
          sequence: 12,
          type: "task.implementation_verified",
          at: "2026-08-11T10:40:00.000Z",
          detail: { taskId: "task-1" }}),
        event({
          sequence: 13,
          type: "task.gates_passed",
          at: "2026-08-11T10:46:02.000Z",
          detail: { taskId: "task-1" }})],
    );

    const labels = activity.timeline.map((entry) => {
      if (entry.type === "invocation") {
        return `${entry.invocation.role}:${entry.invocation.sessionId}`;
      }
      return `${entry.event}:${entry.summary}`;
    });
    expect(labels).toEqual([
      "implementer:impl-1",
      "task.gates_passed:Final gates",
      "reviewer:review-1",
      "routing:review → implementer",
      "implementer:impl-2",
      "task.implementation_verified:Implementation verified",
      "task.gates_passed:Final gates",
      "reviewer:review-2"]);

    const implRows = activity.timeline.filter(
      (entry) => entry.type === "invocation" && entry.invocation.role === "implementer",
    );
    expect(implRows).toHaveLength(2);
    expect(
      activity.timeline
        .filter((entry) => entry.type === "invocation" && entry.invocation.providerSessionId === "impl-ctx")
        .map((entry) => (entry.type === "invocation" ? entry.invocation.contextTurn : null)),
    ).toEqual([1, 2]);

    expect(activity.totals.invocations).toBe(4);
    expect(activity.totals.providerContexts).toBe(3);
  });

  it("uses event sequence as the deterministic tie-breaker for identical timestamps", () => {
    const activity = buildAgentActivity(
      [
        record({
          path: "sessions/a.json",
          sessionId: "a",
          role: "reviewer",
          startedAt: "2026-08-11T10:00:00.000Z"})],
      [
        event({
          sequence: 2,
          type: "task.review_failed",
          at: "2026-08-11T10:00:00.000Z",
          detail: { reviewRepairRoute: "production", taskId: "t1" }}),
        event({
          sequence: 1,
          type: "task.gates_passed",
          at: "2026-08-11T10:00:00.000Z",
          detail: { taskId: "t1" }})],
    );
    expect(
      activity.timeline.map((entry) =>
        entry.type === "transition" ? entry.event : entry.invocation.sessionId,
      ),
    ).toEqual(["task.gates_passed", "routing", "a"]);
  });

  it("does not let transition rows alter invocation or token totals", () => {
    const activity = buildAgentActivity(
      [
        record({
          path: "sessions/a.json",
          sessionId: "a",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }})],
      [
        event({ sequence: 1, type: "task.gates_passed", at: "2026-08-11T10:00:01.000Z" }),
        event({
          sequence: 2,
          type: "task.review_failed",
          at: "2026-08-11T10:00:02.000Z",
          detail: { reviewRepairRoute: "production" }})],
    );
    expect(activity.totals).toEqual({
      providerContexts: 1,
      invocations: 1,
      continuedInvocations: 0,
      schemaRepairs: 0});
    expect(activity.timeline.filter((entry) => entry.type === "transition")).toHaveLength(2);
  });

  it("renders historical records without trigger or outcome metadata", () => {
    const activity = buildAgentActivity([
      record({
        path: "sessions/legacy.json",
        sessionId: "legacy",
        startedAt: undefined,
        endedAt: undefined,
        trigger: undefined,
        outcome: undefined,
        output: undefined})]);
    expect(activity.timeline).toHaveLength(1);
    const entry = activity.timeline[0]!;
    expect(entry.type).toBe("invocation");
    if (entry.type === "invocation") {
      expect(entry.invocation.triggerSummary).toBe(HISTORICAL_TRIGGER_SUMMARY);
      expect(entry.invocation.outcome).toBeUndefined();
      expect(entry.occurredAt).toBe("");
    }
  });

  it("derives structured outcomes from stored output for historical reviewer records", () => {
    const activity = buildAgentActivity([
      record({
        path: "sessions/review.json",
        sessionId: "review",
        role: "reviewer",
        output: {
          approved: false,
          summary: "Need more coverage",
          findings: [{ severity: "blocking", kind: "test-coverage", message: "edge case missing" }]}})]);
    const entry = activity.timeline[0]!;
    expect(entry.type).toBe("invocation");
    if (entry.type === "invocation") {
      expect(entry.invocation.outcome).toEqual({
        status: "blocking",
        summary: "Need more coverage",
        blockingCount: 1,
        repairRoute: "test-coverage"});
    }
  });

  it("keeps schema-repair invocations linked under the same provider context", () => {
    const activity = buildAgentActivity([
      record({
        path: "sessions/a.json",
        sessionId: "a",
        invocationId: "inv-1",
        providerSessionId: "ctx",
        attempt: 0,
        startedAt: "2026-08-10T20:00:00.000Z",
        status: "failed",
        error: "Validation error"}),
      record({
        path: "sessions/b.json",
        sessionId: "b",
        invocationId: "inv-1",
        providerSessionId: "ctx",
        attempt: 1,
        invocationKind: "schema-repair",
        startedAt: "2026-08-10T20:00:30.000Z",
        status: "completed"})]);
    expect(activity.providerContexts[0]!.invocations.map((item) => item.invocationId)).toEqual([
      "inv-1",
      "inv-1"]);
    expect(activity.timeline.map((entry) => (entry.type === "invocation" ? entry.invocation.sessionId : null))).toEqual([
      "a",
      "b"]);
  });
});

describe("deriveInvocationOutcome", () => {
  it("maps implementer status from structured output", () => {
    expect(deriveInvocationOutcome("implementer", { status: "implemented", summary: "ok" })).toEqual({
      status: "implemented",
      summary: "ok"});
  });
});
