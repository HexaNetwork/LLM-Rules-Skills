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

      const sessions = await host.ctx.store.readSessions(runId);
      expect(sessions).toHaveLength(1);
      expect((agentsPlugin as { inject: string[] }).inject).toEqual(
        expect.arrayContaining(["store", "sandbox"]),
      );
    } finally {
      await host.dispose();
    }
  });
});
