import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

import {
  HarnessConfigSchema,
  defaultConfigYaml,
  deploymentConfigYaml,
  loadRunConfig,
  writeProjectSettings,
} from "../../src/config.js";
import { fixtureRoot } from "../helpers.js";

describe("token-conscious defaults", () => {
  it("uses deterministic prompts and bounded wayfinding episodes by default", () => {
    const config = HarnessConfigSchema.parse({});

    expect(config.agent.promptBuilder).toBe(false);
    expect(config.workflow.maxWayfindingTurnsPerEpisode).toBe(1);
    expect(config.knowledge.graphify.enabled).toBe(false);
    expect(config.knowledge.graphify.roles).toContain("implementer");
    expect(config.knowledge.graphify.roles).not.toContain("message-writer");
    expect(config.workflow.contextCharacters).toBe(12_000);
    expect(config.knowledge.guidance).toMatchObject({ enabled: true, maxResults: 6, maxCharacters: 6_000 });
    expect(config.knowledge.embeddings.enabled).toBe(false);
    expect(config.knowledge.embeddings.model).toBe("text-embedding-3-small");
    expect(defaultConfigYaml()).toContain("promptBuilder: false");
    expect(defaultConfigYaml()).toContain("maxWayfindingTurnsPerEpisode: 1");
    expect(defaultConfigYaml()).toContain("enabled: false");
    const deployed = HarnessConfigSchema.parse(yaml.load(deploymentConfigYaml({
      sources: ["README.md", "src"],
      ollama: true,
    })));
    expect(deployed.knowledge.sources.map((source) => source.path)).toEqual(["README.md", "src"]);
    expect(deployed.knowledge.embeddings).toMatchObject({
      enabled: true,
      provider: "ollama",
      model: "qwen3-embedding",
    });
    expect(deployed.knowledge.graphify).toMatchObject({
      enabled: true,
      updateOnRefresh: false,
    });
    const documentOnly = HarnessConfigSchema.parse(yaml.load(deploymentConfigYaml({ graphify: false })));
    expect(documentOnly.knowledge.graphify).toMatchObject({
      enabled: false,
      updateOnRefresh: false,
    });
  });

  it("persists editable settings without expanding the resolved repository path", async () => {
    const root = await fixtureRoot();
    const configPath = path.join(root, "agent-harness.config.yaml");
    await writeFile(
      configPath,
      "version: 2\nrepositoryRoot: .\nworkflow:\n  maxWayfindingTurnsPerEpisode: 6\n",
      "utf8",
    );

    const updated = await writeProjectSettings(configPath, {
      workflow: { maxWayfindingTurnsPerEpisode: 12 },
    });

    expect(updated.config.workflow.maxWayfindingTurnsPerEpisode).toBe(12);
    expect(updated.config.repositoryRoot).toBe(root);
    expect(await readFile(configPath, "utf8")).not.toContain(root);
  });

  it("keeps legacy frozen runs on generic retrieval", async () => {
    const root = await fixtureRoot();
    const project = HarnessConfigSchema.parse({ repositoryRoot: root });
    const runId = "legacy-run";
    const runDirectory = path.join(root, ".agent-harness", "runs", runId);
    await mkdir(runDirectory, { recursive: true });
    const { guidance: _guidance, ...legacyKnowledge } = project.knowledge;
    await writeFile(
      path.join(runDirectory, "config.json"),
      `${JSON.stringify({ ...project, knowledge: legacyKnowledge })}\n`,
      "utf8",
    );

    const loaded = await loadRunConfig(project, runId);

    expect(loaded.knowledge.guidance.enabled).toBe(false);
  });
});
