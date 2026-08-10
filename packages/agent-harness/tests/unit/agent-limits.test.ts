import { describe, expect, it } from "vitest";

import { AgentCoordinator, createFakeBackend } from "../../src/agent.js";
import { WorkerOutputSchema, createRunState } from "../../src/domain.js";
import { LocalKnowledgeBase } from "../../src/knowledge.js";
import { RunStore } from "../../src/store.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

describe("agent tool-call limit", () => {
  it("cancels an invocation once it exceeds the configured cap", async () => {
    const root = await fixtureRoot();
    const config = fixtureConfig(root, {
      agent: { promptBuilder: false, schemaRepairAttempts: 0, maxToolCalls: 2 } as never,
    });
    const store = new RunStore(config);
    await store.initialize();
    const runId = "tool-limit-run";
    await store.create(createRunState(runId, "Implement a bounded change", new Date().toISOString()));
    const agents = new AgentCoordinator(
      config,
      createFakeBackend({
        implementer: (request) => {
          request.onStep?.({ type: "toolCall", toolName: "read", summary: "read one.ts" });
          request.onStep?.({ type: "toolCall", toolName: "read", summary: "read two.ts" });
          request.onStep?.({ type: "toolCall", toolName: "read", summary: "read three.ts" });
          if (request.signal.aborted) throw new Error("provider observed aborted signal");
          return { summary: "unexpected completion", changedFiles: [] };
        },
      }),
      store,
      new LocalKnowledgeBase(config),
    );

    await expect(agents.invoke({
      runId,
      role: "implementer",
      objective: "Implement a bounded change",
      input: { task: "bounded" },
      expectedOutput: "{summary,changedFiles}",
      schema: WorkerOutputSchema,
      retrieval: false,
    })).rejects.toMatchObject({
      kind: "budget",
      retriable: false,
      message: "implementer agent exceeded the 2-tool-call limit",
    });

    const sessions = (await store.listFiles(runId, "sessions")).filter(
      (file) => file.endsWith(".json") && !file.endsWith(".steps.jsonl"),
    );
    const session = (await store.readJson(runId, sessions[0]!)) as { status: string; error?: string };
    expect(session.status).toBe("failed");
    expect(session.error).toContain("exceeded the 2-tool-call limit");
  });
});
