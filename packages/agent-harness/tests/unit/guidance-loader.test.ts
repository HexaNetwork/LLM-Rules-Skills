import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadGuidanceDocuments } from "../../src/infrastructure/knowledge/guidance-loader.js";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("loadGuidanceDocuments", () => {
  it("loads mdc and SKILL.md with frontmatter and prefers earlier roots", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ah-guidance-loader-"));
    tempRoots.push(root);
    const frozen = path.join(root, "frozen");
    const project = path.join(root, "project");
    const shared = path.join(root, "shared");
    await mkdir(path.join(frozen, "General", "rules"), { recursive: true });
    await mkdir(path.join(project, "rules"), { recursive: true });
    await mkdir(path.join(shared, "General", "skills", "tdd"), { recursive: true });
    await writeFile(
      path.join(frozen, "General", "rules", "priority.mdc"),
      "---\ndescription: frozen rule\nalwaysApply: true\n---\n\nfrozen body\n",
      "utf8",
    );
    await writeFile(
      path.join(project, "rules", "priority.mdc"),
      "---\ndescription: project rule\nalwaysApply: true\n---\n\nproject body\n",
      "utf8",
    );
    await writeFile(
      path.join(shared, "General", "skills", "tdd", "SKILL.md"),
      "---\nname: tdd\ndescription: tests\n---\n\nshared skill\n",
      "utf8",
    );
    await writeFile(path.join(shared, "General", "readme.md"), "# ignored\n", "utf8");

    const documents = await loadGuidanceDocuments([
      { absolutePath: frozen, scope: "global" },
      { absolutePath: project, scope: "project", projectId: "proj" },
      { absolutePath: shared, scope: "global" },
    ]);

    expect(documents.map((document) => document.source).sort()).toEqual([
      "General/rules/priority.mdc",
      "General/skills/tdd/SKILL.md",
      "rules/priority.mdc",
    ]);
    expect(documents.find((document) => document.source === "General/rules/priority.mdc")?.content)
      .toContain("frozen body");
    expect(documents.find((document) => document.source === "General/skills/tdd/SKILL.md")?.guidance)
      .toMatchObject({ kind: "skill", name: "tdd" });
  });

  it("tolerates missing roots", async () => {
    const documents = await loadGuidanceDocuments([
      { absolutePath: path.join(os.tmpdir(), "ah-missing-guidance-root"), scope: "global" },
    ]);
    expect(documents).toEqual([]);
  });
});
