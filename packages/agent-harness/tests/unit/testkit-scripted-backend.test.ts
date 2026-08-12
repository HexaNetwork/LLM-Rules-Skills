import { HIGH_LEVEL_PLAN, PRD_OUTPUT } from "../helpers.js";
import { describe, expect, it } from "vitest";
import type { AgentRequest } from "../../src/agent.js";
import { createScriptedBackend } from "../testkit/scripted-backend.js";

function request(role: AgentRequest["role"], prompt = `${role} objective`): AgentRequest {
  return {
    role,
    model: "test-model",
    prompt,
    cwd: "/tmp/fixture",
    signal: new AbortController().signal};
}

describe("createScriptedBackend", () => {
  it("represents a full TDD workflow as one ordered scenario", async () => {
    const scripted = createScriptedBackend([
      {
        role: "reflector",
        output: {
          summary: "Greeting",
          restatement: "Add greeting",
          goal: "Ship greeting",
          users: ["users"],
          inScope: ["copy"],
          outOfScope: [],
          assumptions: [],
          unknowns: []}},
      {
        role: "griller",
        output: {
          status: "ready_to_plan",
          summary: "Ready",
          resolutions: [
            {
              id: "tone",
              question: "Tone?",
              answer: "Casual",
              summary: "Casual"}]}},
      { role: "planner", output: HIGH_LEVEL_PLAN },
      { role: "planner", output: PRD_OUTPUT },
      {
        role: "issue-slicer",
        output: {

          summary: "One task",
          tasks: [
            {
              id: "greet",
              title: "Ship greeting",
              description: "Implement greeting",
              acceptanceCriteria: ["works"],
              blockedBy: []}],
          proposedInstalls: []}},
      {
        role: "red-writer",
        output: {
          status: "continue",
          summary: "RED",
          changedFiles: ["tests/greet.test.ts"],
          behaviorsAdded: ["greeting fails until implemented"],
          edgeCasesAdded: []}},
      {
        role: "implementer",
        output: { summary: "GREEN", changedFiles: ["src/greet.ts"] }},
      {
        role: "reviewer",
        output: { approved: true, summary: "ok", findings: [] }},
      {
        role: "message-writer",
        output: { subject: "feat: greeting", body: "Done." }}]);

    for (const role of [
      "reflector",
      "griller",
      "planner",
      "planner",
      "issue-slicer",
      "red-writer",
      "implementer",
      "reviewer",
      "message-writer"] as const) {
      const result = await scripted.backend.run(request(role));
      expect(result.output).toBeTruthy();
    }

    expect(scripted.calls.map((call) => call.role)).toEqual([
      "reflector",
      "griller",
      "planner",
      "planner",
      "issue-slicer",
      "red-writer",
      "implementer",
      "reviewer",
      "message-writer"]);
    expect(scripted.calls[0]?.objective).toContain("reflector");
    expect(scripted.calls[0]?.retrieval.cwd).toBe("/tmp/fixture");
    scripted.assertExhausted();
  });

  it("fails clearly on unexpected roles and unconsumed steps", async () => {
    const scripted = createScriptedBackend([
      { role: "reflector", output: { ok: true } },
      { role: "planner", output: { ok: true } }]);

    await expect(scripted.backend.run(request("griller"))).rejects.toThrow(
      /expected role "reflector"/,
    );

    const remaining = createScriptedBackend([{ role: "reviewer", output: { ok: true } }]);
    expect(() => remaining.assertExhausted()).toThrow(/unconsumed step/);
  });

  it("supports deferred wait and error steps", async () => {
    let release!: () => void;
    const waitFor = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scripted = createScriptedBackend([
      { role: "implementer", waitFor, output: { summary: "done" } },
      { role: "reviewer", error: new Error("review boom") }]);

    const pending = scripted.backend.run(request("implementer"));
    release();
    await expect(pending).resolves.toMatchObject({ output: { summary: "done" } });
    await expect(scripted.backend.run(request("reviewer"))).rejects.toThrow("review boom");
    scripted.assertExhausted();
  });

  it("emits configured onStep tool-call steps before returning output", async () => {
    const observed: string[] = [];
    const scripted = createScriptedBackend([
      {
        role: "red-writer",
        steps: [
          { type: "toolCall", toolName: "readFile", summary: "readFile" },
          { type: "toolCall", toolName: "shell", summary: "shell" }],
        output: { summary: "red", changedFiles: [] }}]);
    const result = await scripted.backend.run({
      ...request("red-writer"),
      onStep: (step) => {
        if (step.toolName) observed.push(step.toolName);
      }});
    expect(result.output).toEqual({ summary: "red", changedFiles: [] });
    expect(observed).toEqual(["readFile", "shell"]);
    scripted.assertExhausted();
  });
});
