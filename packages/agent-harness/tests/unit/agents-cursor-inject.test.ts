import { describe, expect, it, vi } from "vitest";
import type { WorkPacket } from "../../src/domain/types.js";
import { bootHost } from "../../src/boot.js";
import { agentsPlugin } from "../../src/plugins/agents.js";
import { hostRuntimeRows } from "../../src/plugins/profile.js";
import { createTempDir } from "../helpers.js";

function cursorPacket(runId: string): WorkPacket {
  return {
    role: "implementer",
    runId,
    phase: "implement",
    model: "composer-2.5",
    input: { idea: "unblock live invoke" },
    guidance: "",
    retrieval: "",
    budget: { guidanceTokens: 0, inputTokens: 0, graphifyTokens: 0, truncated: [] },
  };
}

describe("agentsPlugin cursor mode", () => {
  it("resolves sandbox.exec in live cursor mode so invoke can run", async () => {
    const home = await createTempDir("harness-cursor-agents-");
    const host = await bootHost({
      home,
      extraRows: hostRuntimeRows({
        agents: { mode: "cursor" },
        sandbox: { mode: "none" },
      }),
    });
    try {
      const runId = "run-cursor-sandbox-inject";
      await host.ctx.store.writeIdentity({
        runId,
        projectKey: "toy",
        workflowBundleId: "default",
        controlRoot: home,
        worktreePath: home,
        baseSha: "0".repeat(40),
        baseBranch: "main",
        createdAt: new Date().toISOString(),
      });

      const exec = vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: JSON.stringify({
          stream: "result",
          protocolVersion: 1,
          output: { summary: "from-sandbox" },
          submittedPrompt: "Role: implementer\n\nInput: {}",
          telemetry: {
            provider: "cursor",
            model: "composer-2.5",
            agentId: "agent-1",
            providerRunId: "run-provider-1",
            usage: {
              inputTokens: 100,
              outputTokens: 20,
              cacheReadTokens: 50,
              cacheWriteTokens: 0,
              totalTokens: 120,
            },
            cost: { rawCostCents: 1.5, chargedCents: 1.2 },
          },
        }),
        stderr: "",
      });
      host.ctx.sandbox.exec = exec;

      const output = await host.ctx.agents.invoke("implementer", cursorPacket(runId));

      expect(exec).toHaveBeenCalledTimes(1);
      const [execRunId, request] = exec.mock.calls[0] as [string, { command: string[]; stdin: string }];
      expect(execRunId).toBe(runId);
      expect(request.command).toEqual(["node", "/opt/agent-harness/dist/worker/invoke.js"]);
      expect(JSON.parse(request.stdin)).toMatchObject({ role: "implementer", packet: { runId } });
      expect(output).toEqual({ summary: "from-sandbox" });

      const sessions = await host.ctx.store.readSessions<{
        sessionId: string;
        status: string;
        startedAt: string;
        endedAt: string;
        at: string;
        output: unknown;
        submittedPrompt?: string;
        telemetry: unknown;
      }>(runId);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        status: "completed",
        output: { summary: "from-sandbox" },
        submittedPrompt: "Role: implementer\n\nInput: {}",
        telemetry: {
          provider: "cursor",
          model: "composer-2.5",
          agentId: "agent-1",
          usage: { totalTokens: 120 },
          cost: { chargedCents: 1.2 },
        },
      });
      expect(sessions[0]!.sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(sessions[0]!.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(sessions[0]!.endedAt).toBe(sessions[0]!.at);
      const events = await host.ctx.store.readJsonl<{
        kind?: string;
        status?: string;
        packet?: { model?: string; inputKeys?: string[] };
      }>(`runs/${runId}/events.jsonl`);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "agent",
            role: "implementer",
            phase: "implement",
            status: "running",
            sessionId: sessions[0]!.sessionId,
            packet: expect.objectContaining({
              model: "composer-2.5",
              inputKeys: expect.arrayContaining(["idea"]),
            }),
          }),
          expect.objectContaining({
            kind: "agent",
            role: "implementer",
            phase: "implement",
            status: "completed",
            sessionId: sessions[0]!.sessionId,
            packet: expect.objectContaining({ model: "composer-2.5" }),
          }),
        ]),
      );
      expect(events.every((event) => event.kind !== "agent_stream")).toBe(true);
      expect((agentsPlugin as { inject: string[] }).inject).toEqual(
        expect.arrayContaining(["store", "sandbox"]),
      );
    } finally {
      await host.dispose();
    }
  });

  it("persists a failed session then rethrows", async () => {
    const home = await createTempDir("harness-cursor-agents-fail-");
    const host = await bootHost({
      home,
      extraRows: hostRuntimeRows({
        agents: { mode: "cursor" },
        sandbox: { mode: "none" },
      }),
    });
    try {
      const runId = "run-cursor-session-fail";
      await host.ctx.store.writeIdentity({
        runId,
        projectKey: "toy",
        workflowBundleId: "default",
        controlRoot: home,
        worktreePath: home,
        baseSha: "0".repeat(40),
        baseBranch: "main",
        createdAt: new Date().toISOString(),
      });

      host.ctx.sandbox.exec = vi.fn().mockResolvedValue({
        exitCode: 1,
        stdout: "",
        stderr: "worker boom",
      });

      await expect(host.ctx.agents.invoke("implementer", cursorPacket(runId))).rejects.toThrow(
        /implementer|worker boom|exit/i,
      );

      const sessions = await host.ctx.store.readSessions<{
        sessionId: string;
        status: string;
        error?: string;
        output?: unknown;
        startedAt: string;
        endedAt: string;
      }>(runId);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        status: "failed",
        role: "implementer",
      });
      expect(sessions[0]!.sessionId).toBeTruthy();
      expect(sessions[0]!.error).toMatch(/worker boom|implementer/i);
      expect(sessions[0]!.output).toBeUndefined();
      expect(sessions[0]!.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(sessions[0]!.endedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const events = await host.ctx.store.readJsonl<{ kind?: string; status?: string }>(
        `runs/${runId}/events.jsonl`,
      );
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "agent",
            status: "failed",
            sessionId: sessions[0]!.sessionId,
            role: "implementer",
          }),
        ]),
      );
    } finally {
      await host.dispose();
    }
  });

  it("keeps worker stream ticks on the session log only", async () => {
    const home = await createTempDir("harness-cursor-stream-");
    const host = await bootHost({
      home,
      extraRows: hostRuntimeRows({
        agents: { mode: "cursor" },
        sandbox: { mode: "none" },
      }),
    });
    try {
      const runId = "run-cursor-stream-session-only";
      await host.ctx.store.writeIdentity({
        runId,
        projectKey: "toy",
        workflowBundleId: "default",
        controlRoot: home,
        worktreePath: home,
        baseSha: "0".repeat(40),
        baseBranch: "main",
        createdAt: new Date().toISOString(),
      });

      host.ctx.sandbox.exec = vi.fn().mockImplementation(async (_id, request: {
        onStdoutLine?: (line: string) => void | Promise<void>;
      }) => {
        const emit = async (kind: string) => {
          await request.onStdoutLine?.(
            JSON.stringify({
              stream: "control",
              at: new Date().toISOString(),
              kind,
            }),
          );
        };
        return (async () => {
          await emit("delta");
          await emit("delta");
          await emit("tool_start");
          await emit("tool_finish");
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              stream: "result",
              protocolVersion: 1,
              output: { summary: "streamed" },
              submittedPrompt: "prompt",
              telemetry: {
                provider: "cursor",
                model: "composer-2.5",
                agentId: "agent-1",
                providerRunId: "run-1",
              },
            }),
            stderr: "",
          };
        })();
      });

      await host.ctx.agents.invoke("implementer", cursorPacket(runId));

      const sessions = await host.ctx.store.readSessions<{ sessionId: string }>(runId);
      expect(sessions).toHaveLength(1);
      const sessionEvents = await host.ctx.store.readSessionEvents<{ kind?: string }>(
        runId,
        sessions[0]!.sessionId,
      );
      expect(sessionEvents.map((event) => event.kind)).toEqual([
        "delta",
        "delta",
        "tool_start",
        "tool_finish",
      ]);

      const activity = await host.ctx.runLifecycle.activity(runId);
      expect(activity.every((event: { kind?: string }) => event.kind !== "agent_stream")).toBe(
        true,
      );
      expect(activity).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "agent", status: "running" }),
          expect.objectContaining({ kind: "agent", status: "completed" }),
        ]),
      );
    } finally {
      await host.dispose();
    }
  });
});
