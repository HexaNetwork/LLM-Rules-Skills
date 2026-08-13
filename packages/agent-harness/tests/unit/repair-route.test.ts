import { describe, expect, it } from "vitest";
import { repairRoute } from "../../src/application/helpers.js";
import { CONFIG_FAILURE_PATTERN, classifyFailure } from "../../src/errors.js";

describe("repairRoute", () => {
  it("routes blockedKind config to config-fixer", () => {
    expect(repairRoute({ blockedKind: "config" })).toBe("config-fixer");
  });

  it("does not special-case retired Test/Red writer path strings", () => {
    expect(
      repairRoute({
        blockedKind: "internal",
        failure:
          "Test writer changed non-test paths: civcraft/src/main/test/BuildFootprintTest.java",
      }),
    ).toBe("fixer");
    expect(
      repairRoute({
        blockedKind: "internal",
        failure: "Red writer changed non-test paths: src/sneaky.ts",
      }),
    ).toBe("fixer");
  });

  it("routes config drift messages to config-fixer", () => {
    expect(
      repairRoute({
        blockedKind: "workspace",
        failure: "Run configuration changed; resume with the persisted run config",
      }),
    ).toBe("config-fixer");
  });

  it("keeps ordinary internal failures on the file fixer", () => {
    expect(
      repairRoute({
        blockedKind: "internal",
        failure: "Implementer left the tree in a broken state",
      }),
    ).toBe("fixer");
  });

  it("shares the config failure pattern with classifyFailure", () => {
    const message = "targeted test run found no tests; the test filter/template is broken";
    expect(CONFIG_FAILURE_PATTERN.test(message)).toBe(true);
    expect(classifyFailure(new Error(message))).toEqual({ kind: "config", retriable: false });
  });

  it("routes command-not-launched RED exhaustion to config-fixer", () => {
    const message =
      "Test command could not be launched: ./gradlew test\n'.' is not recognized as an internal or external command";
    expect(CONFIG_FAILURE_PATTERN.test(message)).toBe(true);
    expect(repairRoute({ blockedKind: "contract", failure: message })).toBe("config-fixer");
    expect(classifyFailure(new Error(`Task task-1 failed: ${message}`))).toEqual({
      kind: "config",
      retriable: false,
    });
  });
});
