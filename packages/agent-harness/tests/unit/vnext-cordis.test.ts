import { describe, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import {
  bootProfile,
  dumpProfileConfig,
  validateProfileDefinition,
  type ProfileDefinition,
} from "../../src/vnext/boot/boot-profile.js";
import { securityPolicyPlugin } from "../../src/vnext/plugins/security-policy.js";
import { immutableEnvironmentPlugin } from "../../src/vnext/plugins/immutable-environment.js";
import { profileForDump } from "../../src/vnext/profiles/index.js";

describe("Cordis vNext profiles", () => {
  it("boots required services and disposes effect-owned providers", async () => {
    let disposed = false;
    const webPlugin = (ctx: Context) => {
      ctx.provide("webServer", {
        origin: "http://127.0.0.1:0",
        close: async () => undefined,
      });
      return () => {
        disposed = true;
      };
    };
    const profile: ProfileDefinition = {
      name: "test-host",
      production: true,
      hmr: false,
      requiredServices: ["securityPolicy", "webServer"],
      rows: [
        {
          id: "security",
          plugin: securityPolicyPlugin,
          provides: ["securityPolicy"],
          trusted: true,
        },
        {
          id: "web",
          plugin: webPlugin,
          provides: ["webServer"],
          trusted: true,
        },
      ],
    };

    const booted = await bootProfile(profile);
    expect(booted.ctx.webServer.origin).toBe("http://127.0.0.1:0");
    expect(booted.diagnostics.every((item) => item.status === "active")).toBe(true);
    await booted.dispose();
    expect(disposed).toBe(true);
  });

  it("fails closed for duplicate production security providers", () => {
    const profile = profileForDump("host");
    profile.rows.push({
      id: "security-duplicate",
      plugin: securityPolicyPlugin,
      provides: ["securityPolicy"],
      trusted: true,
    });
    expect(() => validateProfileDefinition(profile)).toThrow(/duplicate providers/i);
  });

  it("dumps stable rows with credential redaction", () => {
    const profile = profileForDump("host");
    profile.rows[0]!.config = { credential: "do-not-print", nested: { apiKey: "hidden" } };
    const dump = dumpProfileConfig(profile);
    expect(dump).toContain("[REDACTED]");
    expect(dump).not.toContain("do-not-print");
    expect(dump).not.toContain("hidden");
  });

  it.each([
    [
      "host",
      [
        "runState",
        "runArtifacts",
        "runLifecycle",
        "containerRuntime",
        "workspaceSource",
        "environment",
        "workerControl",
        "credentials",
        "publisher",
        "webServer",
        "securityPolicy",
      ],
    ],
    [
      "worker",
      [
        "runState",
        "runArtifacts",
        "workerControl",
        "credentials",
        "agents",
        "knowledge",
        "repositoryIntelligence",
        "verification",
        "resultExport",
        "commands",
        "securityPolicy",
        "roles",
        "workflow",
      ],
    ],
  ] as const)("declares every required %s provider exactly once", (name, requiredServices) => {
    const profile = profileForDump(name);
    expect(profile.production).toBe(true);
    expect(profile.hmr).toBe(false);
    expect(profile.requiredServices).toEqual(requiredServices);

    for (const service of requiredServices) {
      const providers = profile.rows.filter(
        (row) => !row.disabled && row.provides?.includes(service),
      );
      expect(providers.map((row) => row.id), `provider for ${name}.${service}`).toHaveLength(1);
    }
  });

  it.each(["host", "worker"] as const)(
    "keeps %s dump inspection usable while production boot fails loudly without providers",
    async (name) => {
      const profile = profileForDump(name);
      const dump = JSON.parse(dumpProfileConfig(profile)) as {
        profile: string;
        production: boolean;
        requiredServices: string[];
        rows: Array<{ id: string; provides: string[] }>;
      };

      expect(dump).toMatchObject({
        profile: name,
        production: true,
        requiredServices: profile.requiredServices,
      });
      expect(dump.rows.length).toBe(profile.rows.length);
      await expect(bootProfile(profile)).rejects.toThrow(
        new RegExp(
          `Failed to boot Cordis profile "${name}".*(required|service|implementation|unavailable)`,
          "i",
        ),
      );
    },
  );

  it("resolves only the configured immutable image digest", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const runtimePlugin = (ctx: Context) =>
      ctx.provide("containerRuntime", {
        ensureImage: async (reference: string) => ({ reference, digest }),
        createVolume: async () => undefined,
        start: async () => ({ containerId: "worker" }),
        stop: async () => undefined,
        removeContainer: async () => undefined,
        removeVolume: async () => undefined,
      });
    const booted = await bootProfile({
      name: "immutable-test",
      production: false,
      hmr: false,
      requiredServices: ["containerRuntime", "environment"],
      rows: [
        {
          id: "runtime",
          plugin: runtimePlugin,
          provides: ["containerRuntime"],
        },
        {
          id: "environment",
          plugin: immutableEnvironmentPlugin,
          config: { image: `agent-harness-worker@${digest}` },
          provides: ["environment"],
        },
      ],
    });
    await expect(booted.ctx.environment.resolve()).resolves.toEqual({
      reference: `agent-harness-worker@${digest}`,
      digest,
    });
    await booted.dispose();
  });
});
