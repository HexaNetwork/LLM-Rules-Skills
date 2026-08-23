import { describe, expect, it } from "vitest";
import { normalizeProposal } from "../../src/phases/verification-settings.js";

describe("verification proposal normalization", () => {
  it("keeps the generic command and optional specific commands", () => {
    const proposal = normalizeProposal(
      {
        command: "npm test",
        testGlobs: ["**/*.test.ts"],
        rationale: "standard script",
        specificCommands: [
          {
            id: "focused",
            label: "Focused",
            command: "npm test -- status",
            rationale: "narrow to status",
          },
        ],
      },
      { testGlobs: [] },
    );
    expect(proposal.command).toBe("npm test");
    expect(proposal.testGlobs).toEqual(["**/*.test.ts"]);
    expect(proposal.specificCommands).toEqual([
      {
        id: "focused",
        label: "Focused",
        command: "npm test -- status",
        rationale: "narrow to status",
      },
    ]);
    expect(proposal.source).toBe("agent");
  });

  it("falls back to live settings when the agent returns nothing usable", () => {
    const proposal = normalizeProposal(
      { command: "", testGlobs: [], specificCommands: [] },
      { command: "pnpm test", testGlobs: ["**/*.spec.ts"] },
    );
    expect(proposal.command).toBe("pnpm test");
    expect(proposal.testGlobs).toEqual(["**/*.spec.ts"]);
    expect(proposal.source).toBe("settings");
  });
});
