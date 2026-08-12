import { describe, expect, it } from "vitest";
import { materializeTasks } from "../../src/domain/transitions.js";
import { HarnessFailure } from "../../src/errors.js";

describe("materializeTasks scenario tagging", () => {
  it("maps scenarioIds onto tasks and reverse taskIds onto scenarios", () => {
    const { tasks, scenarios } = materializeTasks(
      {
        tasks: [
          {
            id: "greet",
            title: "Greet",
            description: "Ship greeting",
            acceptanceCriteria: ["ok"],
            blockedBy: [],
            scenarioIds: ["greet-happy"],
          },
        ],
      },
      {
        scenarios: [
          {
            id: "greet-happy",
            title: "Happy",
            kind: "happy-path",
            intent: "greet",
            given: "g",
            when: "w",
            then: "t",
            taskIds: [],
            status: "pending",
            attempts: 0,
            writerAttempts: 0,
            repairAttempts: 0,
            testPaths: [],
            seenEvidenceFingerprints: [],
            seenRepairEdges: [],
            reviewFindings: [],
          },
        ],
      },
    );
    expect(tasks[0]?.scenarioIds).toEqual(["greet-happy"]);
    expect(scenarios[0]?.taskIds).toEqual(["greet"]);
  });

  it("rejects unknown scenario ids", () => {
    expect(() =>
      materializeTasks(
        {
          tasks: [
            {
              id: "greet",
              title: "Greet",
              description: "Ship greeting",
              acceptanceCriteria: ["ok"],
              blockedBy: [],
              scenarioIds: ["missing"],
            },
          ],
        },
        {
          scenarios: [
            {
              id: "greet-happy",
              title: "Happy",
              kind: "happy-path",
              intent: "greet",
              given: "g",
              when: "w",
              then: "t",
              taskIds: [],
              status: "pending",
              attempts: 0,
              writerAttempts: 0,
              repairAttempts: 0,
              testPaths: [],
              seenEvidenceFingerprints: [],
              seenRepairEdges: [],
              reviewFindings: [],
            },
          ],
        },
      ),
    ).toThrow(HarnessFailure);
  });
});
