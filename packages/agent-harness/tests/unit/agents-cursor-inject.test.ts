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
        stdout: JSON.stringify({ summary: "from-sandbox" }),
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
      }>(runId);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        status: "completed",
        output: { summary: "from-sandbox" },
      });
      expect(sessions[0]!.sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(sessions[0]!.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(sessions[0]!.endedAt).toBe(sessions[0]!.at);
      const events = await host.ctx.store.readJsonl<{ kind?: string; status?: string }>(
        `runs/${runId}/events.jsonl`,
      );
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "agent",
            role: "implementer",
            phase: "implement",
            status: "completed",
            sessionId: sessions[0]!.sessionId,
          }),
        ]),
      );
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
});
