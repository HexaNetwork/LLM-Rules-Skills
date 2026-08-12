import { describe, expect, it } from "vitest";
import { buildInstallCommand, detectInstallFromCommand } from "../../src/commands.js";
import { detectInstallFromToolStep } from "../../src/agent.js";

describe("detectInstallFromCommand", () => {
  it("detects common package managers", () => {
    expect(detectInstallFromCommand("npm install lodash")).toEqual({
      manager: "npm",
      packages: ["lodash"],
      commandSummary: "npm install lodash"});
    expect(detectInstallFromCommand("pnpm add zod")).toMatchObject({ manager: "pnpm", packages: ["zod"] });
    expect(detectInstallFromCommand("yarn add left-pad")).toMatchObject({ manager: "yarn" });
    expect(detectInstallFromCommand("pip install requests")).toMatchObject({ manager: "pip", packages: ["requests"] });
    expect(detectInstallFromCommand("uv add rich")).toMatchObject({ manager: "uv" });
    expect(detectInstallFromCommand("cargo add serde")).toMatchObject({ manager: "cargo" });
  });

  it("ignores non-install commands", () => {
    expect(detectInstallFromCommand("npm test")).toBeUndefined();
    expect(detectInstallFromCommand("git status")).toBeUndefined();
  });

  it("builds allowlisted install commands", () => {
    expect(buildInstallCommand("npm", ["lodash", "@types/node"])).toBe("npm install lodash @types/node");
    expect(() => buildInstallCommand("npm", ["evil; rm -rf /"])).toThrow(/Unsafe package/);
  });
});

describe("detectInstallFromToolStep", () => {
  it("reads shell tool args", () => {
    expect(
      detectInstallFromToolStep({
        type: "toolCall",
        message: { type: "Shell", args: { command: "npm i chalk" } }}),
    ).toMatchObject({ manager: "npm", packages: ["chalk"] });
  });
});
