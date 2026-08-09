import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { fixtureRoot } from "../helpers.js";
import {
  SEEDED_GUIDANCE_RELATIVE_PATH,
  seedGlobalGuidance,
  withGlobalGuidanceSource,
} from "../../src/guidance-seed.js";

describe("guidance seed", () => {
  it("copies package General templates once and reuses on a second call", async () => {
    const root = await fixtureRoot();
    const first = await seedGlobalGuidance(root);
    expect(first).toMatchObject({
      sourcePath: SEEDED_GUIDANCE_RELATIVE_PATH,
      copied: true,
      reused: false,
    });
    const skill = await readFile(
      path.join(root, "agent-harness", "guidance", "General", "skills", "tdd", "SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("name: tdd");

    const second = await seedGlobalGuidance(root);
    expect(second).toMatchObject({
      sourcePath: SEEDED_GUIDANCE_RELATIVE_PATH,
      copied: false,
      reused: true,
    });
  });

  it("reuses an existing root General/ without copying into agent-harness/guidance", async () => {
    const root = await fixtureRoot();
    await mkdir(path.join(root, "General", "rules"), { recursive: true });
    await writeFile(
      path.join(root, "General", "rules", "custom.mdc"),
      "---\ndescription: custom\n---\n\ncustom rule\n",
      "utf8",
    );

    const result = await seedGlobalGuidance(root);
    expect(result).toMatchObject({
      sourcePath: "General",
      copied: false,
      reused: true,
    });
    await expect(
      readFile(path.join(root, "agent-harness", "guidance", "General", "skills", "tdd", "SKILL.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prepends a global guidance source without duplicating paths", () => {
    const sources = withGlobalGuidanceSource(
      [
        { path: "README.md", scope: "project", visibility: "private" },
        { path: "agent-harness/guidance/General", scope: "project", visibility: "private" },
      ],
      "agent-harness/guidance/General",
    );
    expect(sources).toEqual([
      { path: "agent-harness/guidance/General", scope: "global", visibility: "private" },
      { path: "README.md", scope: "project", visibility: "private" },
    ]);
  });

  it("skips seeding when disabled", async () => {
    const root = await fixtureRoot();
    await expect(seedGlobalGuidance(root, { enabled: false })).resolves.toEqual({
      copied: false,
      reused: false,
    });
  });
});
