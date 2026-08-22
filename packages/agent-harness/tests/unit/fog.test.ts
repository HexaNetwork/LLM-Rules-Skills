import { describe, expect, it } from "vitest";
import {
  applyAgentResolutions,
  applyAnswers,
  markAsked,
  reconcileFog,
  seedFog,
} from "../../src/domain/fog.js";

describe("fog register", () => {
  it("seeds, asks, resolves, and keeps parked entries sticky", () => {
    let fog = seedFog(["Who are the users?", "What is out of scope?"]);
    expect(fog.map((entry) => entry.status)).toEqual(["fog", "fog"]);

    const usersId = fog.find((entry) => entry.text.startsWith("Who"))!.id;
    const scopeId = fog.find((entry) => entry.text.startsWith("What"))!.id;
    fog = markAsked(fog, [usersId]);
    expect(fog.find((entry) => entry.text.startsWith("Who"))?.status).toBe("asked");

    fog = applyAnswers(fog, [{ id: usersId, reason: "Operator selected end users" }], [scopeId]);
    expect(fog.find((entry) => entry.text.startsWith("Who"))?.status).toBe("resolved");
    expect(fog.find((entry) => entry.text.startsWith("What"))?.status).toBe("parked");
    expect(fog.find((entry) => entry.id === usersId)?.resolution).toEqual({
      source: "operator",
      reason: "Operator selected end users",
    });

    fog = reconcileFog(["Who are the users?", "Which command should run?"], fog);
    expect(fog.find((entry) => entry.text.startsWith("What"))?.status).toBe("parked");
    expect(fog.find((entry) => entry.text.startsWith("Which"))?.status).toBe("fog");
    expect(fog.find((entry) => entry.text.startsWith("Who"))?.status).toBe("resolved");
  });

  it("does not resolve omitted or paraphrased unknowns", () => {
    let fog = seedFog(["Where is the radius stored?", "Which camps are exempt?"]);
    fog = reconcileFog(
      [{ id: "fog-radius-storage-detail", text: "Choose a configuration key for the radius" }],
      fog,
    );

    expect(fog).toHaveLength(3);
    expect(fog.filter((entry) => entry.status === "fog")).toHaveLength(3);

    fog = reconcileFog([], fog);
    expect(fog.filter((entry) => entry.status === "fog")).toHaveLength(3);
  });

  it("requires an explicit reason to record an agent resolution", () => {
    let fog = seedFog(["Does the code already expose a setting?"]);
    fog = applyAgentResolutions(fog, [
      { id: fog[0]!.id, reason: "CivSettings exposes buildable_area_radius at settings.ts:42" },
    ]);

    expect(fog[0]).toMatchObject({
      status: "resolved",
      resolution: {
        source: "agent",
        reason: "CivSettings exposes buildable_area_radius at settings.ts:42",
      },
    });
  });
});
