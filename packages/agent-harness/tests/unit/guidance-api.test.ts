import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeBackend } from "../../src/agent.js";
import { startUiServer, type UiServer } from "../../src/ui/server.js";
import { fixtureConfig, fixtureRoot } from "../helpers.js";

describe("GET /api/guidance/packs", () => {
  let ui: UiServer | undefined;

  afterEach(async () => {
    await ui?.close();
    ui = undefined;
  });

  it("returns compiled packs with role rules and assigned skill bodies", async () => {
    const root = await fixtureRoot();
    const sharedRoot = path.join(root, "guidance-shared");
    await mkdir(path.join(sharedRoot, "General", "skills", "tdd"), { recursive: true });
    await writeFile(
      path.join(sharedRoot, "General", "skills", "tdd", "SKILL.md"),
      [
        "---",
        "name: tdd",
        "description: Test-first behavior",
        "---",
        "",
        "# Test-Driven Development",
        "",
        "Write a failing behavioral test first.",
      ].join("\n"),
      "utf8",
    );

    const config = fixtureConfig(root, {
      knowledge: {
        ...fixtureConfig(root).knowledge,
        guidance: {
          ...fixtureConfig(root).knowledge.guidance,
          sharedRoot,
        },
      },
    });
    ui = await startUiServer({
      config,
      backend: createFakeBackend({}),
      port: 0,
      token: "guidance-api-test",
    });

    const response = await fetch(`${ui.origin}/api/guidance/packs`, {
      headers: { "X-Harness-Token": ui.token },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      packs: Array<{
        role: string;
        roleRules: string[];
        guidancePack: string;
        promptPreview: string;
        sources: string[];
        assignment: { skills: string[] };
      }>;
    };

    const implementer = body.packs.find((pack) => pack.role === "implementer");
    expect(implementer).toBeDefined();
    expect(implementer!.assignment.skills).toContain("tdd");
    expect(implementer!.sources).toContain("General/skills/tdd/SKILL.md");
    expect(implementer!.guidancePack).toContain("# Test-Driven Development");
    expect(implementer!.guidancePack).toContain("Write a failing behavioral test first.");
    expect(implementer!.guidancePack).not.toContain("name: tdd");
    expect(implementer!.roleRules.some((rule) => rule.includes("never commit"))).toBe(true);
    expect(implementer!.promptPreview).toContain("You are the implementer worker");
    expect(implementer!.promptPreview).toContain("GUIDANCE");
    expect(implementer!.promptPreview).not.toContain("SELECTED GUIDANCE");
    expect(implementer!.promptPreview).not.toContain("Reason:");
  });
});
