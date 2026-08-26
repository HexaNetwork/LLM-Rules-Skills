import { describe, expect, it } from "vitest";
import { clearRoleAgent, readRoleAgents } from "../../src/domain/role-agents.js";
import type { Run } from "../../src/domain/types.js";

function runWithArtifacts(artifacts: Record<string, unknown>): Run {
  return {
    identity: {
      runId: "run-1",
      projectKey: "demo",
      workflowBundleId: "default",
      controlRoot: "/tmp",
      worktreePath: "/tmp/work",
      baseSha: "0".repeat(40),
      baseBranch: "main",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    state: {
      runId: "run-1",
      status: "active",
      phase: "grill",
      idea: "idea",
      revision: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      artifacts,
      fog: [],
      tasks: [],
    },
    settings: {} as Run["settings"],
  };
}

describe("role agents", () => {
  it("reads and clears persisted agent ids per role", () => {
    const run = runWithArtifacts({ roleAgents: { griller: "agent-42", reflector: "agent-1" } });
    expect(readRoleAgents(run.state.artifacts)).toEqual({
      griller: "agent-42",
      reflector: "agent-1",
    });
    clearRoleAgent(run, "griller");
    expect(readRoleAgents(run.state.artifacts)).toEqual({ reflector: "agent-1" });
    clearRoleAgent(run, "reflector");
    expect(run.state.artifacts.roleAgents).toBeUndefined();
  });
});
