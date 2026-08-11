import { describe, expect, it } from "vitest";
import {
  HISTORICAL_TRIGGER_SUMMARY,
  buildAgentActivity,
  type InvocationRecord,
} from "../../src/application/agent-activity.js";

function record(overrides: Partial<InvocationRecord> & Pick<InvocationRecord, "sessionId" | "path">): InvocationRecord {
  return {
    role: "implementer",
    model: "composer",
    status: "completed",
    attempt: 0,
    startedAt: "2026-08-10T20:00:00.000Z",
    endedAt: "2026-08-10T20:01:00.000Z",
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    ...overrides,
  };
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
          summary: "initial implementation",
        },
      }),
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
          previousInvocationId: "inv-a",
        },
      }),
      record({
        path: "sessions/c.json",
        sessionId: "c",
        providerSessionId: "ctx-1",
        providerSessionReused: true,
        startedAt: "2026-08-10T20:12:00.000Z",
        invocationKind: "continuation",
        usage: { inputTokens: 300, outputTokens: 60, totalTokens: 360 },
      }),
    ]);

    expect(activity.providerContexts).toHaveLength(1);
    expect(activity.totals).toEqual({
      providerContexts: 1,
      invocations: 3,
      continuedInvocations: 2,
      schemaRepairs: 0,
    });
    const context = activity.providerContexts[0]!;
    expect(context.id).toBe("ctx-1");
    expect(context.invocationCount).toBe(3);
    expect(context.invocations.map((item) => item.contextTurn)).toEqual([1, 2, 3]);
    expect(context.usage).toMatchObject({ inputTokens: 600, outputTokens: 120, totalTokens: 720 });
    expect(context.invocations[0]!.triggerSummary).toBe("initial implementation");
  });

  it("creates one synthetic context per record when providerSessionId is missing", () => {
    const activity = buildAgentActivity([
      record({ path: "sessions/a.json", sessionId: "a", startedAt: "2026-08-10T20:00:00.000Z" }),
      record({ path: "sessions/b.json", sessionId: "b", startedAt: "2026-08-10T20:01:00.000Z" }),
    ]);
    expect(activity.providerContexts).toHaveLength(2);
    expect(activity.providerContexts.map((item) => item.id)).toEqual([
      "synthetic:b",
      "synthetic:a",
    ]);
  });

  it("marks mixed roles and uses the latest outcome when a group spans statuses", () => {
    const activity = buildAgentActivity([
      record({
        path: "sessions/a.json",
        sessionId: "a",
        providerSessionId: "shared",
        role: "implementer",
        status: "completed",
        startedAt: "2026-08-10T20:00:00.000Z",
      }),
      record({
        path: "sessions/b.json",
        sessionId: "b",
        providerSessionId: "shared",
        role: "reviewer",
        status: "failed",
        startedAt: "2026-08-10T20:02:00.000Z",
      }),
    ]);
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
        status: "failed",
      }),
      record({
        path: "sessions/b.json",
        sessionId: "b",
        invocationId: "inv-1",
        providerSessionId: "ctx",
        attempt: 1,
        invocationKind: "schema-repair",
        startedAt: "2026-08-10T20:00:30.000Z",
        status: "completed",
      }),
    ]);
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
        startedAt: "2026-08-10T20:00:00.000Z",
      }),
      record({
        path: "sessions/b.json",
        sessionId: "b",
        providerSessionId: "ctx",
        status: "running",
        startedAt: "2026-08-10T20:01:00.000Z",
        endedAt: undefined,
      }),
    ]);
    expect(activity.providerContexts[0]!.status).toBe("running");
    expect(activity.providerContexts[0]!.endedAt).toBeUndefined();
  });

  it("orders contexts newest-first and labels historical triggers", () => {
    const activity = buildAgentActivity([
      record({
        path: "sessions/later.json",
        sessionId: "later",
        providerSessionId: "b",
        startedAt: "2026-08-10T21:00:00.000Z",
      }),
      record({
        path: "sessions/earlier.json",
        sessionId: "earlier",
        providerSessionId: "a",
        startedAt: "2026-08-10T20:00:00.000Z",
      }),
    ]);
    expect(activity.providerContexts.map((item) => item.id)).toEqual(["b", "a"]);
    expect(activity.providerContexts[1]!.invocations[0]!.triggerSummary).toBe(
      HISTORICAL_TRIGGER_SUMMARY,
    );
  });
});
