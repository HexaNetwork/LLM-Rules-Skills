import { describe, expect, it } from "vitest";
import {
  AGENT_ROLES,
  DEFAULT_ROLE_ASSIGNMENTS,
  ROLE_RULES,
  outputContractFor,
} from "../../src/domain/agent-roles.js";
import { mergeSettings } from "../../src/domain/settings.js";
import { createKnowledgeService } from "../../src/plugins/knowledge.js";
import { createRoleGuidanceService } from "../../src/plugins/role-guidance.js";
import { renderDashboardPage } from "../../src/ui/page.js";
import { buildCursorInvokePrompt } from "../../src/worker/invoke.js";
import { createTempDir } from "../helpers.js";

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

describe("dedicated role guidance service", () => {
  it("resolves packaged defaults for every role", async () => {
    const home = await createTempDir("harness-guidance-");
    const service = createRoleGuidanceService(home);
    const roles = await service.listRoles();
    expect(roles.map((entry) => entry.role)).toEqual([...AGENT_ROLES]);
    for (const entry of roles) {
      expect(entry.source).toBe("packaged");
      expect(entry.hasHomeOverride).toBe(false);
    }
    const reflector = await service.read("reflector");
    expect(reflector.source).toBe("packaged");
    expect(reflector.body).toContain("Reflector guidance");
    expect(reflector.packagedBody).toBe(reflector.body);
  });

  it("prefers the harness-home override over the packaged default", async () => {
    const home = await createTempDir("harness-guidance-");
    const service = createRoleGuidanceService(home);
    await service.writeOverride("griller", "Custom home guidance for the griller.");
    const document = await service.read("griller");
    expect(document.source).toBe("home");
    expect(document.body).toContain("Custom home guidance for the griller.");
    expect(document.hasHomeOverride).toBe(true);
    expect(document.packagedBody).toContain("Griller guidance");
  });

  it("prefers the project override over the home override", async () => {
    const home = await createTempDir("harness-guidance-");
    const service = createRoleGuidanceService(home);
    await service.writeOverride("planner", "Home-level planner guidance.");
    await service.writeOverride("planner", "Project-level planner guidance.", "demo-project");
    const project = await service.read("planner", "demo-project");
    expect(project.source).toBe("project");
    expect(project.body).toContain("Project-level planner guidance.");
    expect(project.hasHomeOverride).toBe(true);
    expect(project.hasProjectOverride).toBe(true);
    const global = await service.read("planner");
    expect(global.source).toBe("home");
    expect(global.body).toContain("Home-level planner guidance.");
  });

  it("resets an override back to the packaged default", async () => {
    const home = await createTempDir("harness-guidance-");
    const service = createRoleGuidanceService(home);
    await service.writeOverride("fixer", "Temporary fixer override.");
    expect((await service.read("fixer")).source).toBe("home");
    const reset = await service.resetOverride("fixer");
    expect(reset.source).toBe("packaged");
    expect(reset.body).toContain("Fixer guidance");
    expect(reset.hasHomeOverride).toBe(false);
  });

  it("rejects unknown roles and empty bodies", async () => {
    const home = await createTempDir("harness-guidance-");
    const service = createRoleGuidanceService(home);
    await expect(service.read("nope")).rejects.toThrow("Unknown role");
    await expect(service.writeOverride("reflector", "  ")).rejects.toThrow("Guidance body is required");
  });

  it("compiles the worker context from rules, contract, and guidance body", async () => {
    const home = await createTempDir("harness-guidance-");
    const service = createRoleGuidanceService(home);
    const compiled = await service.compileRoleContext("reflector", { maxCharacters: 16000 });
    expect(compiled.source).toBe("packaged");
    expect(compiled.text).toContain("You are the reflector worker");
    expect(compiled.text).toContain(ROLE_RULES.reflector[0]!);
    expect(compiled.text).toContain("EXPECTED OUTPUT");
    expect(compiled.text).toContain(outputContractFor("reflector")!);
    expect(compiled.text).toContain("GUIDANCE");
    expect(compiled.text).toContain("Reflector guidance");
    expect(compiled.truncated).toBeUndefined();
  });

  it("truncates the compiled context to the character budget", async () => {
    const home = await createTempDir("harness-guidance-");
    const service = createRoleGuidanceService(home);
    const compiled = await service.compileRoleContext("implementer", { maxCharacters: 120 });
    expect(compiled.text.length).toBe(120);
    expect(compiled.truncated?.after).toBe(120);
    expect(compiled.truncated!.before).toBeGreaterThan(120);
  });
});

describe("dashboard agent contexts page", () => {
  it("exposes the Agent contexts editor shell", () => {
    const html = renderDashboardPage();
    expect(html).toContain("Agent contexts");
    expect(html).toContain('id="guidance-toggle"');
    expect(html).toContain("/api/guidance/roles");
    expect(html).toContain("renderGuidance");
    expect(html).toContain('id="guidance-editor"');
    expect(html).toContain("data-guidance-save");
    expect(html).toContain("data-guidance-reset");
  });

  it("embeds attention sounds with a mute toggle", () => {
    const html = renderDashboardPage();
    expect(html).toContain('id="soundMuteBtn"');
    expect(html).toContain("harnessSoundsMuted");
    expect(html).toContain("maybePlayStatusSound");
    expect(html).toContain("awaiting_input");
    expect(html).toContain("playTone");
  });
});
