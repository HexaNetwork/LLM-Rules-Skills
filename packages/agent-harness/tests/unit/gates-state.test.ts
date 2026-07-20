import { describe, expect, it } from "vitest";
import {
  validatePathScope,
  allGatesPassed,
} from "../../src/engine/gates.js";
import {
  createInitialRunState,
  assertResumeInvariants,
  blockTask,
  updateTaskState,
} from "../../src/engine/state-machine.js";
import { ProjectConfigSchema } from "../../src/schemas/config.js";
import type { RunManifest } from "../../src/schemas/manifest.js";

function manifest(): RunManifest {
  const config = ProjectConfigSchema.parse({
    contractVersion: "1",
    name: "demo",
    models: {
      prepare: "m",
      worker: "m",
      verifier: "m",
      repair: "m",
      adversarial: "m",
    },
    commandGates: [{ id: "build", command: "npm run build" }],
  });
  return {
    contractVersion: "1",
    draft: false,
    approvedAt: new Date().toISOString(),
    approvedBy: "me",
    manifestHash: "hash",
    source: {
      kind: "local",
      location: "x",
      contentHash: "c",
      fetchedAt: new Date().toISOString(),
    },
    configSnapshot: config,
    retries: config.retries,
    models: config.models,
    taskOrder: ["t1"],
    tasks: [
      {
        id: "t1",
        title: "T1",
        mode: "AFK",
        body: "",
        acceptanceCriteria: [
          { id: "ac-1", text: "Do the thing correctly" },
        ],
        blockedBy: [],
        allowedGlobs: ["src/**"],
        testSeams: [],
        browserProbes: [],
      },
    ],
  };
}

describe("gates", () => {
  it("detects path scope violations", () => {
    const result = validatePathScope(
      ["README.md"],
      ["src/**"],
      [".env"],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("PATH_SCOPE_VIOLATION");
  });

  it("detects protected paths", () => {
    const result = validatePathScope([".env"], ["**/*"], [".env"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("PROTECTED_PATH");
  });

  it("requires all command gates to pass", () => {
    expect(
      allGatesPassed([
        {
          gateId: "a",
          command: "a",
          exitCode: 0,
          passed: true,
          stdout: "",
          stderr: "",
          durationMs: 1,
        },
      ]),
    ).toBe(true);
    expect(allGatesPassed([])).toBe(false);
  });
});

describe("state machine", () => {
  it("creates initial task states from manifest order", () => {
    const state = createInitialRunState("run-1", manifest());
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0]?.status).toBe("pending");
  });

  it("blocks tasks with typed reasons", () => {
    const state = blockTask(
      createInitialRunState("run-1", manifest()),
      "t1",
      "COMMAND_GATE_FAILED",
      "build failed",
    );
    expect(state.tasks[0]?.status).toBe("blocked");
    expect(state.tasks[0]?.blockedReason).toBe("COMMAND_GATE_FAILED");
  });

  it("enforces resume invariants", () => {
    const state = updateTaskState(createInitialRunState("run-1", manifest()), "t1", {
      status: "accepted",
    });
    const withMeta = {
      ...state,
      worktreePath: "/tmp/wt",
      branchName: "agent-harness/run-1",
      headSha: "abc",
    };
    expect(() =>
      assertResumeInvariants({
        state: withMeta,
        manifestHash: "hash",
        worktreePath: "/tmp/other",
        branchName: "agent-harness/run-1",
        headSha: "abc",
      }),
    ).toThrow(/worktree/);
  });
});
