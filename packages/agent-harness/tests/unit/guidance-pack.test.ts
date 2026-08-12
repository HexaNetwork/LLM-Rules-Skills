import { describe, expect, it } from "vitest";
import {
  compileRoleGuidancePack,
  stripYamlFrontmatter} from "../../src/infrastructure/knowledge/guidance-pack.js";
import type { KnowledgeDocument } from "../../src/infrastructure/knowledge/types.js";

function doc(partial: Partial<KnowledgeDocument> & Pick<KnowledgeDocument, "source" | "content">): KnowledgeDocument {
  return {
    id: partial.id ?? partial.source,
    source: partial.source,
    title: partial.title ?? partial.source.split("/").pop() ?? partial.source,
    content: partial.content,
    hash: partial.hash ?? "hash",
    updatedAt: partial.updatedAt ?? "2026-01-01T00:00:00.000Z",
    scope: partial.scope ?? "global",
    projectId: partial.projectId,
    visibility: partial.visibility ?? "private",
    managedByConfig: false,
    guidance: {
      kind: partial.guidance?.kind ?? "rule",
      name: partial.guidance?.name ?? "",
      description: partial.guidance?.description ?? "",
      globs: partial.guidance?.globs ?? [],
      alwaysApply: partial.guidance?.alwaysApply ?? false,
      roles: partial.guidance?.roles ?? [],
      disableModelInvocation: partial.guidance?.disableModelInvocation ?? false}};
}

describe("compileRoleGuidancePack", () => {
  it("strips YAML frontmatter from bodies", () => {
    expect(
      stripYamlFrontmatter("---\nname: tdd\n---\n\n# Test-Driven Development\n"),
    ).toBe("# Test-Driven Development");
    expect(stripYamlFrontmatter("# No frontmatter")).toBe("# No frontmatter");
  });

  it("joins assigned bodies in assignment order with project override", () => {
    const pack = compileRoleGuidancePack(
      [
        doc({
          source: "General/rules/alpha.mdc",
          content: "---\ndescription: a\n---\n\nglobal alpha",
          guidance: { kind: "rule", name: "alpha", description: "", globs: [], alwaysApply: false, roles: [], disableModelInvocation: false }}),
        doc({
          source: "rules/alpha.mdc",
          content: "---\ndescription: a\n---\n\nproject alpha",
          scope: "project",
          projectId: "demo",
          guidance: { kind: "rule", name: "alpha", description: "", globs: [], alwaysApply: false, roles: [], disableModelInvocation: false }}),
        doc({
          source: "General/skills/tdd/SKILL.md",
          content: "---\nname: tdd\n---\n\n# TDD body",
          guidance: { kind: "skill", name: "tdd", description: "", globs: [], alwaysApply: false, roles: [], disableModelInvocation: false }})],
      {
        assignment: { rules: ["alpha"], skills: ["tdd"] },
        maxCharacters: 6_000,
        projectId: "demo"},
    );

    expect(pack.sources).toEqual(["rules/alpha.mdc", "General/skills/tdd/SKILL.md"]);
    expect(pack.text).toBe("project alpha\n\n# TDD body");
    expect(pack.text).not.toContain("name: tdd");
    expect(pack.omittedOverrides).toEqual([
      expect.objectContaining({ source: "General/rules/alpha.mdc" })]);
    expect(pack.missingAssignments).toEqual([]);
  });

  it("returns an empty pack for empty assignments", () => {
    const pack = compileRoleGuidancePack(
      [
        doc({
          source: "General/skills/tdd/SKILL.md",
          content: "body",
          guidance: { kind: "skill", name: "tdd", description: "", globs: [], alwaysApply: false, roles: [], disableModelInvocation: false }})],
      {
        assignment: { rules: [], skills: [] },
        maxCharacters: 6_000,
        projectId: "demo"},
    );
    expect(pack).toEqual({
      text: "",
      sources: [],
      selected: [],
      missingAssignments: [],
      omittedOverrides: []});
  });

  it("truncates the joined pack and records truncation", () => {
    const pack = compileRoleGuidancePack(
      [
        doc({
          source: "General/skills/tdd/SKILL.md",
          content: "ABCDEFGHIJ",
          guidance: { kind: "skill", name: "tdd", description: "", globs: [], alwaysApply: false, roles: [], disableModelInvocation: false }})],
      {
        assignment: { rules: [], skills: ["tdd"] },
        maxCharacters: 4,
        projectId: "demo"},
    );
    expect(pack.text).toBe("ABCD");
    expect(pack.truncated).toEqual({ before: 10, after: 4 });
  });

  it("records missing assignments without inventing content", () => {
    const pack = compileRoleGuidancePack([], {
      assignment: { rules: ["missing"], skills: [] },
      maxCharacters: 100,
      projectId: "demo"});
    expect(pack.text).toBe("");
    expect(pack.missingAssignments).toEqual([
      expect.objectContaining({ kind: "rule", name: "missing" })]);
  });
});
