import { describe, expect, it } from "vitest";
import { applyAnswers, markAsked, reconcileFog, seedFog } from "../../src/domain/fog.js";

describe("fog register", () => {
  it("seeds, asks, resolves, and keeps parked entries sticky", () => {
    let fog = seedFog(["Who are the users?", "What is out of scope?"]);
    expect(fog.map((entry) => entry.status)).toEqual(["fog", "fog"]);

    fog = markAsked(fog, ["Who are the users?"]);
    expect(fog.find((entry) => entry.text.startsWith("Who"))?.status).toBe("asked");

    fog = applyAnswers(fog, ["Who are the users?"], ["What is out of scope?"]);
    expect(fog.find((entry) => entry.text.startsWith("Who"))?.status).toBe("resolved");
    expect(fog.find((entry) => entry.text.startsWith("What"))?.status).toBe("parked");

    fog = reconcileFog(["Who are the users?", "Which command should run?"], fog);
    expect(fog.find((entry) => entry.text.startsWith("What"))?.status).toBe("parked");
    expect(fog.find((entry) => entry.text.startsWith("Which"))?.status).toBe("fog");
    expect(fog.find((entry) => entry.text.startsWith("Who"))?.status).toBe("fog");
  });
});
