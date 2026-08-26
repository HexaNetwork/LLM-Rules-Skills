import { describe, expect, it } from "vitest";
import { roleRulesFor } from "../../src/domain/agent-roles.js";
import { recoverFinalizedWorker } from "../../src/plugins/agents.js";
import { recoverOrphanedRuns } from "../../src/plugins/run-lifecycle.js";
import { runProcess } from "../../src/plugins/sandbox.js";
import { toolsForRole } from "../../src/worker/invoke.js";
import { workingOn } from "../../src/domain/working.js";
import { bootTestHost } from "../helpers.js";

describe("project-profiler containment", () => {
  it("exposes only static repository inspection tools", () => {
    expect(toolsForRole("project-profiler")).toEqual(["read", "grep", "glob", "ls"]);
    expect(toolsForRole("implementer")).toBeUndefined();
    expect(roleRulesFor("project-profiler").join(" ")).toContain("Never invoke a shell");
  });
});

describe("worker process timeouts", () => {
  it("returns a hard timeout failure rather than a successful exit code", async () => {
    const result = await runProcess(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      undefined,
      undefined,
      50,
    );
    expect(result).toMatchObject({ timedOut: true, exitCode: 124 });
  });
});

describe("finalized session reconciliation", () => {
  it("recovers the final structured assistant output", () => {
    const result = recoverFinalizedWorker([
      { kind: "provider_status", status: "agent_ready", agentId: "agent-1" },
      { kind: "run_status", status: "sent", runId: "run-1", requestId: "request-1" },
      {
        kind: "step",
        step: {
          type: "assistantMessage",
          message: { text: '{"command":"npm test","testGlobs":["**/*.test.ts"]}' },
        },
      },
      { kind: "provider_status", status: "finalized" },
    ]);
    expect(result?.output).toEqual({ command: "npm test", testGlobs: ["**/*.test.ts"] });
    expect(result?.telemetry).toMatchObject({
      agentId: "agent-1",
      providerRunId: "run-1",
      requestId: "request-1",
    });
  });

  it("turns a startup orphan into a retriable blocked run", async () => {
    const { host } = await bootTestHost();
    const runId = "orphaned-run";
    const sessionId = "orphaned-session";
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const packet = {
      role: "project-profiler",
      runId,
      phase: "verification-settings",
      model: "default",
      input: {},
      guidance: "",
      retrieval: "",
      budget: { guidanceTokens: 1, inputTokens: 1, graphifyTokens: 1, truncated: [] },
      agentTimeoutMs: 30_000,
    };
    try {
      await host.ctx.store.writeState({
        runId,
        status: "active",
        phase: "verification-settings",
        idea: "profile verification",
        revision: 1,
        updatedAt: startedAt,
        artifacts: {},
        fog: [],
        tasks: [],
      });
      await host.ctx.store.writeProgress(
        runId,
        {
          ...workingOn("Invoking project-profiler", {
            phase: "verification-settings",
            role: "project-profiler",
          }),
          ownerPid: 999_999_999,
        },
      );
      await host.ctx.store.writeSession(runId, sessionId, {
        sessionId,
        role: "project-profiler",
        packet,
        startedAt,
        endedAt: startedAt,
        at: startedAt,
        status: "running",
      });
      await host.ctx.store.appendSessionEvent(runId, sessionId, {
        kind: "step",
        step: {
          type: "assistantMessage",
          message: { text: '{"command":"npm test","testGlobs":[]}' },
        },
      });
      await host.ctx.store.appendSessionEvent(runId, sessionId, {
        kind: "provider_status",
        status: "finalized",
      });

      await recoverOrphanedRuns(host.ctx);

      const state = await host.ctx.store.readState(runId);
      const progress = await host.ctx.store.readProgress(runId);
      const sessions = await host.ctx.store.readSessions<{ status: string; output?: unknown }>(runId);
      expect(state).toMatchObject({
        status: "blocked",
        block: { retriable: true },
      });
      expect(progress).toBeUndefined();
      expect(sessions[0]).toMatchObject({
        status: "completed",
        output: { command: "npm test", testGlobs: [] },
      });
    } finally {
      await host.dispose();
    }
  });
});
