import { describe, expect, it } from "vitest";
import { reviewRepairRoute } from "../../src/domain/policies.js";

describe("reviewRepairRoute for final review kinds", () => {
  it("prefers production over other blocking kinds", () => {
    expect(
      reviewRepairRoute([
        { severity: "blocking", kind: "scenario-intent" },
        { severity: "blocking", kind: "production" },
      ]),
    ).toBe("production");
  });

  it("routes scenario-intent and test-design", () => {
    expect(
      reviewRepairRoute([{ severity: "blocking", kind: "scenario-intent" }]),
    ).toBe("scenario-intent");
    expect(
      reviewRepairRoute([{ severity: "blocking", kind: "test-design" }]),
    ).toBe("test-design");
  });

  it("returns none when only advisory findings exist", () => {
    expect(
      reviewRepairRoute([{ severity: "advisory", kind: "test-coverage" }]),
    ).toBe("none");
  });
});
