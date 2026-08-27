import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dumpHostConfig, redact } from "../../src/dump-config.js";
import { createTempDir } from "../helpers.js";

describe("dump-config", () => {
  it("renders the trusted host profile with live settings and redaction", async () => {
    const home = await createTempDir("dump-");
    await writeFile(
      path.join(home, "settings.json"),
      JSON.stringify({ models: { default: "secret-model" } }),
      "utf8",
    );
    const dumped = JSON.parse(await dumpHostConfig({ home })) as {
      profile: string;
      production: boolean;
      hmr: boolean;
      home: string;
      workflowBundles: string[];
      requiredServices: string[];
      settings: { models: { default: string }; budgets: { graphifyTokens: number } };
      rows: Array<{ id: string; trusted: boolean; provides: string[] }>;
    };
    expect(dumped.profile).toBe("host");
    expect(dumped.production).toBe(true);
    expect(dumped.hmr).toBe(false);
    expect(dumped.home).toBe(home);
    expect(dumped.workflowBundles).toEqual(["default", "ticket"]);
    expect(dumped.requiredServices).toContain("store");
    expect(dumped.requiredServices).toContain("runLifecycle");
    expect(dumped.settings.models.default).toBe("secret-model");
    expect(dumped.settings.budgets.graphifyTokens).toBe(1500);
    expect(redact({ CURSOR_API_KEY: "abc", nested: { token: "x" } })).toEqual({
      CURSOR_API_KEY: "[REDACTED]",
      nested: { token: "[REDACTED]" },
    });
    expect(dumped.rows.every((row) => row.trusted)).toBe(true);
    expect(dumped.rows.some((row) => row.id === "host.store")).toBe(true);
    expect(dumped.rows.some((row) => row.id === "host.phase.reflect")).toBe(true);
  });
});
