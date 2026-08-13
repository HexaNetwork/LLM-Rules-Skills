import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import yaml from "js-yaml";
import { loadConfig, writeProjectSettings } from "../../src/config/io.js";
import { normalizeFrozenRunConfig } from "../../src/config/migrations.js";
import { fixtureRoot } from "../helpers.js";

describe("repository intelligence config migration", () => {
  it("maps CodeGraph-era live config to neutral providers and routes", async () => {
    const root = await fixtureRoot();
    const configPath = path.join(root, "agent-harness.config.yaml");
    await writeFile(configPath, [
      "version: 2",
      "repositoryRoot: .",
      "workflow:",
      "  codegraphCharacters: 2345",
      "knowledge:",
      "  codegraph:",
      "    enabled: false",
      "    command: codegraph-custom",
      "    maxFiles: 7",
      "commands:",
      "  verification:",
      "    - id: test",
      "      command: npm test",
      "",
    ].join("\n"), "utf8");

    const { config } = await loadConfig(configPath);

    expect(config.workflow.repositoryContextCharacters).toBe(2345);
    expect(config.knowledge.repositoryIntelligence).toMatchObject({
      enabled: false,
      providers: {
        gitnexus: { enabled: false },
        codegraph: { enabled: false, command: "codegraph-custom", maxResults: 7 },
      },
      routes: { search: ["codegraph"] },
    });
    expect(config.knowledge).not.toHaveProperty("codegraph");
  });

  it("normalizes Graphify-era frozen snapshots through the retained historical seam", () => {
    const config = normalizeFrozenRunConfig({
      repositoryRoot: ".",
      workflow: { graphifyCharacters: 1234 },
      knowledge: {
        graphify: {
          enabled: true,
          command: "codegraph",
          queryBudgetTokens: 4,
        },
      },
    });

    expect(config.workflow.repositoryContextCharacters).toBe(1234);
    expect(config.knowledge.repositoryIntelligence.providers.codegraph.maxResults).toBe(4);
    expect(config.knowledge).not.toHaveProperty("graphify");
  });

  it("writes only the neutral shape after reading a legacy config", async () => {
    const root = await fixtureRoot();
    const configPath = path.join(root, "agent-harness.config.yaml");
    await writeFile(configPath, [
      "version: 2",
      "repositoryRoot: .",
      "knowledge:",
      "  codegraph:",
      "    enabled: false",
      "commands:",
      "  verification:",
      "    - id: test",
      "      command: npm test",
      "",
    ].join("\n"), "utf8");

    await writeProjectSettings(configPath, {
      git: { autoCommitPreflight: true },
    });
    const written = await readFile(configPath, "utf8");
    const value = yaml.load(written) as {
      workflow?: Record<string, unknown>;
      knowledge?: Record<string, unknown>;
    };

    expect(written).toContain("repositoryIntelligence:");
    expect(value.knowledge).not.toHaveProperty("codegraph");
    expect(value.workflow ?? {}).not.toHaveProperty("codegraphCharacters");
  });
});
