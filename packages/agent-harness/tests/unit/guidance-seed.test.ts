import { describe, expect, it } from "vitest";
import { access } from "node:fs/promises";
import { resolveGuidanceTemplateDirectory } from "../../src/guidance-seed.js";

describe("resolveGuidanceTemplateDirectory", () => {
  it("points at packaged General templates", async () => {
    const directory = resolveGuidanceTemplateDirectory();
    expect(directory.replace(/\\/g, "/")).toMatch(/templates\/guidance\/General$/);
    await access(directory);
  });
});
