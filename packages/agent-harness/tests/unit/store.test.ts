import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../../src/store.js";

const homes: string[] = [];
async function store() { const home = await mkdtemp(path.join(os.tmpdir(), "harness-store-")); homes.push(home); return Store.open(home); }
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });

describe("Store", () => {
  it("deduplicates commands and leases a command to one owner", async () => {
    const value = await store(); const project = value.addProject({ name: "p", repositoryPath: path.join(value.home, "repo"), baseBranch: "main" });
    const run = value.createRun({ projectId: project.id, workflowId: "complete", firstStep: "clarify", input: { idea: "x" }, effectiveConfig: {} });
    const first = value.enqueueCommand(run.id, "start-run", {}, "stable"); const duplicate = value.enqueueCommand(run.id, "start-run", {}, "stable");
    expect(duplicate.id).toBe(first.id); expect(value.leaseNextCommand("a", 30_000)?.id).toBe(first.id); expect(value.leaseNextCommand("b", 30_000)).toBeUndefined();
    value.finishCommand(first.id, "a"); value.close();
  });

  it("never loses a durable agent result", async () => {
    const value = await store(); const project = value.addProject({ name: "p", repositoryPath: path.join(value.home, "repo"), baseBranch: "main" });
    const run = value.createRun({ projectId: project.id, workflowId: "complete", firstStep: "clarify", input: { idea: "x" }, effectiveConfig: {} });
    const request = { turnId: "turn", role: "r", prompt: "p", outputSchema: { type: "object" } };
    value.createTurn(run.id, "clarify", "action", request); value.finishTurn("action", { turnId: "turn", sessionId: "session", output: { ok: true } });
    expect(value.turnResult("action")?.output).toEqual({ ok: true }); value.close();
  });

  it("can lease durable cancellation while another command is active", async () => {
    const value = await store(); const project = value.addProject({ name: "p", repositoryPath: path.join(value.home, "repo"), baseBranch: "main" });
    const run = value.createRun({ projectId: project.id, workflowId: "complete", firstStep: "clarify", input: { idea: "x" }, effectiveConfig: {} });
    value.enqueueCommand(run.id, "continue", {}, "work"); value.leaseNextCommand("owner", 30_000);
    const cancellation = value.enqueueCommand(run.id, "cancel-run", {}, "cancel", 100);
    expect(value.leaseNextCancellation("owner", 30_000)?.id).toBe(cancellation.id); value.close();
  });
});
