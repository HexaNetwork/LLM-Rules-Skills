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
import { isTestPath } from "../../src/engine.js";
import { fixtureRoot } from "../helpers.js";

describe("token-conscious defaults", () => {
  it("uses deterministic prompts and bounded grill episodes by default", () => {
    const config = HarnessConfigSchema.parse({});

    expect(config.agent.promptBuilder).toBe(false);
    expect(config.workflow.maxGrillQuestionsPerEpisode).toBe(5);
    expect(config.workflow.staleAnswerMinutes).toBe(30);
    expect(config.knowledge.graphify.enabled).toBe(false);
    expect(config.knowledge.graphify.roles).toContain("implementer");
    expect(config.knowledge.graphify.roles).not.toContain("message-writer");
    expect(config.knowledge.graphify.roles).not.toContain("reflector");
    expect(config.knowledge.graphify.roles).not.toContain("griller");
    expect(config.workflow.contextCharacters).toBe(12_000);
    expect(config.workflow.inputCharacters).toBe(24_000);
    // Prefer Math.min(20_000, inputCharacters/2) so a full-size diff fits inputCharacters.
    expect(config.workflow.reviewDiffCharacters).toBe(12_000);
    expect(config.workflow.graphifyCharacters).toBe(3_000);
    expect(config.workflow.generateCommitMessages).toBe(false);
    expect(config.workflow.maxStepsPerRun).toBe(40);
    expect(config.workflow.maxRunTokens).toBe(0);
    expect(config.workflow.maxRunCostUsd).toBe(0);
    expect(config.models.pricing).toEqual({});
    expect(config.workflow.maxProviderRetries).toBe(2);
    expect(config.knowledge.guidance).toMatchObject({ enabled: true, maxResults: 6, maxCharacters: 6_000 });
    expect(config.knowledge.embeddings.enabled).toBe(false);
    expect(config.knowledge.embeddings.model).toBe("text-embedding-3-small");
    expect(config.knowledge.relevanceFloor).toBe(0.55);
    expect(config.knowledge.minLexicalScore).toBe(0.05);
    expect(config.knowledge.maxChunksPerSource).toBe(1);
    expect(config.knowledge.maxForTopSource).toBe(2);
    expect(config.knowledge.graphify.stopwords).toEqual([]);
    expect(config.workflow.testPathPatterns).toEqual([
      "tests/**",
      "test/**",
      "**/__tests__/**",
      "**/*.test.*",
      "**/*.spec.*",
      "**/*_test.*",
      "src/test/**",
    ]);
    expect(config.knowledge.graphify.sourceExtensions).toEqual([
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".py",
      ".go",
      ".rs",
      ".java",
      ".kt",
      ".kts",
      ".cs",
      ".cpp",
      ".c",
      ".h",
      ".hpp",
      ".rb",
      ".php",
      ".swift",
    ]);
    expect(defaultConfigYaml()).toContain("promptBuilder: false");
    expect(defaultConfigYaml()).toContain("relevanceFloor: 0.55");
    expect(defaultConfigYaml()).toContain("maxGrillQuestionsPerEpisode: 5");
    expect(defaultConfigYaml()).toContain("staleAnswerMinutes: 30");
    expect(defaultConfigYaml()).toContain("maxRunTokens: 0");
    expect(defaultConfigYaml()).toContain("maxRunCostUsd: 0");
    expect(defaultConfigYaml()).toContain("pricing: {}");
    expect(defaultConfigYaml()).toContain("enabled: false");
    expect(defaultConfigYaml()).toContain("testPathPatterns:");
    expect(defaultConfigYaml()).toContain("sourceExtensions:");
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

  it("classifies Go and Maven test paths with default patterns", () => {
    const patterns = HarnessConfigSchema.parse({}).workflow.testPathPatterns;

    expect(isTestPath("foo_test.go", patterns)).toBe(true);
    expect(isTestPath("src/test/java/FooTest.java", patterns)).toBe(true);
  });

  it("persists editable settings without expanding the resolved repository path", async () => {
    const root = await fixtureRoot();
    const configPath = path.join(root, "agent-harness.config.yaml");
    await writeFile(
      configPath,
      "version: 2\nrepositoryRoot: .\nworkflow:\n  maxGrillQuestionsPerEpisode: 4\n",
      "utf8",
    );

    const updated = await writeProjectSettings(configPath, {
      workflow: { maxGrillQuestionsPerEpisode: 8, staleAnswerMinutes: 45 },
    });

    expect(updated.config.workflow.maxGrillQuestionsPerEpisode).toBe(8);
    expect(updated.config.workflow.staleAnswerMinutes).toBe(45);
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
