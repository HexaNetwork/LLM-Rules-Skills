import { describe, expect, it } from "vitest";
import { validateEnvironmentPolicy } from "../../src/container-runtime.js";
import { validateJsonSchema } from "../../src/schemas.js";
import { deliveryBranch } from "../../src/git-runtime.js";

describe("strict contracts", () => {
  it("requires the exact neutral runner base and safe caches", () => {
    expect(() => validateEnvironmentPolicy({ containerfile: "FROM node:22", setupCommands: [], healthcheckCommands: [], caches: [] }, "runner:v1")).toThrow(/must begin/);
    expect(() => validateEnvironmentPolicy({ containerfile: "FROM runner:v1", setupCommands: [], healthcheckCommands: [], caches: [{ name: "deps", containerPath: "/workspace/cache" }] }, "runner:v1")).toThrow(/outside/);
  });
  it("rejects aliases and extra structured-output fields", () => {
    const schema = { type: "object", required: ["questions"], properties: { questions: { type: "array" } }, additionalProperties: false };
    expect(validateJsonSchema({ choices: [] }, schema)).toEqual(expect.arrayContaining([expect.stringContaining("questions"), expect.stringContaining("choices")]));
  });
  it("makes a deterministic delivery branch", () => { expect(deliveryBranch("12345678-abcd", "Hello World")).toBe("agent-harness/hello-world-12345678"); });
});
