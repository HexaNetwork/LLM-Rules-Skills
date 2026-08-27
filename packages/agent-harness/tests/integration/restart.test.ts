import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../../src/store.js";
import { GitRuntime } from "../../src/git-runtime.js";
import { WorkflowEngine } from "../../src/workflow-engine.js";
import { WORKFLOWS } from "../../src/workflows/index.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import type { AgentDriver } from "../../src/agent-runtime.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("restart recovery", () => {
  it("continues from durable transitions without repeating a completed turn", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-restart-")); roots.push(root);
    const home = path.join(root, "home"); const worktreeRoot = path.join(home, "worktrees"); const repository = path.join(root, "fresh");
    const calls: string[] = [];
    const agent: AgentDriver = { async invoke(request) { calls.push(request.role); if (request.role === "reflector") return { turnId: request.turnId, sessionId: "reflect-session", output: { brief: "brief" } }; if (request.role === "griller") return { turnId: request.turnId, sessionId: "grill-session", output: { resolved: true, questions: [], clarifiedBrief: { brief: "done" } } }; throw new Error(`Unexpected role: ${request.role}`); } };

    let store = await Store.open(home); const project = store.addProject({ name: "fresh", repositoryPath: repository, baseBranch: "main" });
    const run = store.createRun({ projectId: project.id, workflowId: "complete", firstStep: "clarify", input: { idea: "idea", fresh: true }, effectiveConfig: DEFAULT_CONFIG as unknown as Record<string, unknown> });
    store.enqueueCommand(run.id, "start-run", {}, `${run.id}/start`);
    let engine = makeEngine(store, worktreeRoot, agent); await drainUntil(store, engine, () => store.getRun(run.id).status === "awaiting_user");
    expect(calls).toEqual(["reflector"]); store.close();

    store = await Store.open(home); engine = makeEngine(store, worktreeRoot, agent);
    store.enqueueCommand(run.id, "submit-answers", { gateId: "clarify-brief", answers: { brief: "edited" } }, `${run.id}/answer`);
    await drainUntil(store, engine, () => store.getRun(run.id).currentStep === "specify");
    expect(calls).toEqual(["reflector", "griller"]); store.close();
  });
});

function makeEngine(store: Store, worktreeRoot: string, agent: AgentDriver): WorkflowEngine {
  const containers = { containerName: (id: string) => `container-${id}`, destroy: async () => undefined, inspect: async () => false };
  return new WorkflowEngine({ store, workflows: WORKFLOWS, agent, containers: containers as never, environments: {} as never, git: new GitRuntime(worktreeRoot), worktreeRoot });
}

async function drainUntil(store: Store, engine: WorkflowEngine, done: () => boolean): Promise<void> {
  for (let index = 0; index < 20 && !done(); index++) {
    const command = store.leaseNextCommand("test", 30_000); if (!command) break;
    await engine.process(command); store.finishCommand(command.id, "test");
  }
  expect(done()).toBe(true);
}
