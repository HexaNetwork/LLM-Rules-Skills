import { describe, expect, it } from "vitest";
import { DEFAULT_ROLE_ASSIGNMENTS, ROLE_RULES } from "../../src/domain/agent-roles.js";
import { mergeSettings } from "../../src/domain/settings.js";
import { createKnowledgeService } from "../../src/plugins/knowledge.js";
import { renderDashboardPage } from "../../src/ui/page.js";
import { buildCursorInvokePrompt } from "../../src/worker/invoke.js";

describe("role guidance assignments", () => {
  it("defaults reflector to domain-modeling only", () => {
    const settings = mergeSettings();
    expect(settings.guidance.assignments.reflector).toEqual({
      rules: [],
      skills: ["domain-modeling"],
    });
    expect(settings.guidance.assignments.griller.skills).toEqual(["grill-me", "domain-modeling"]);
  });

  it("compiles the reflector pack from assigned skills, not lexical idea search", async () => {
    const knowledge = createKnowledgeService();
    const pack = await knowledge.compileRoleGuidancePack({
      assignment: DEFAULT_ROLE_ASSIGNMENTS.reflector,
      maxCharacters: 16000,
    });
    expect(pack.missingAssignments).toEqual([]);
    expect(pack.selected.map((item) => `${item.kind}:${item.name}`)).toEqual(["skill:domain-modeling"]);
    expect(pack.text.toLowerCase()).toContain("domain modeling");
    expect(pack.text.toLowerCase()).not.toContain("rip and tear");
  });

  it("does not inject rip-and-tear into the reflector when compiling defaults", async () => {
    const knowledge = createKnowledgeService();
    const lexical = await knowledge.search(
      "remove plot claim system rip tear culture zone protection",
    );
    expect(lexical.some((hit) => hit.path.toLowerCase().includes("rip-and-tear"))).toBe(true);

    const pack = await knowledge.compileRoleGuidancePack({
      assignment: DEFAULT_ROLE_ASSIGNMENTS.reflector,
      maxCharacters: 16000,
    });
    expect(pack.sources.join("\n").toLowerCase()).not.toContain("rip-and-tear");
  });
});

describe("role prompt rules", () => {
  it("includes specialized role rules for every agent type in the live prompt", () => {
    for (const role of Object.keys(ROLE_RULES)) {
      const prompt = buildCursorInvokePrompt({
        role,
        packet: { role, input: { idea: "x" }, guidance: `pack-for-${role}` },
      });
      expect(prompt).toContain(`Role: ${role}`);
      expect(prompt).toContain(`pack-for-${role}`);
      expect(ROLE_RULES[role as keyof typeof ROLE_RULES].length).toBeGreaterThan(0);
      expect(prompt).toContain(ROLE_RULES[role as keyof typeof ROLE_RULES][0]!);
    }
  });
});

describe("dashboard agent contexts page", () => {
  it("exposes the Agent contexts inspector shell", () => {
    const html = renderDashboardPage();
    expect(html).toContain("Agent contexts");
    expect(html).toContain('id="guidance-toggle"');
    expect(html).toContain("/api/guidance/packs");
    expect(html).toContain("renderGuidance");
  });
});
