import { describe, expect, it } from "vitest";
import { HOST_SERVICE_NAMES } from "../../src/boot.js";
import {
  AGENT_ROLES,
  ROLE_RULES,
  outputContractFor,
} from "../../src/domain/agent-roles.js";
import { createRoleGuidanceService } from "../../src/plugins/role-guidance.js";
import { mergeSettings } from "../../src/domain/settings.js";
import { renderDashboardPage } from "../../src/ui/page.js";
import { buildCursorInvokePrompt } from "../../src/worker/invoke.js";
import { createTempDir } from "../helpers.js";

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

  it("requires explicit code provenance in griller resolutions", () => {
    expect(outputContractFor("griller")).toContain('source:"code"');
    const rules = ROLE_RULES.griller.join("\n");
    expect(rules).toContain("ask every independent unresolved product");
    expect(rules).toContain("opaque identifier");
    expect(rules).toContain("Never partially resolve a fog entry");
    expect(rules).toContain("both questions and resolvedUnknowns");
  });
});

describe("legacy guidance cleanup", () => {
  it("does not expose a knowledge service or retain legacy assignment settings", () => {
    expect(HOST_SERVICE_NAMES).not.toContain("knowledge");
    const settings = mergeSettings({
      guidance: { assignments: { griller: { skills: ["grill-me"] } } },
    } as never);
    expect("guidance" in settings).toBe(false);
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
    const griller = await service.read("griller");
    expect(griller.body).toContain("Treat supplied fog IDs as opaque");
    expect(griller.body).toContain("Resolve an existing fog entry only when code settles the whole entry");
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
