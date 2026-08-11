import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

import {
  CONFIG_VERSION,
  DEFAULT_GUIDANCE_ASSIGNMENTS,
  HarnessConfigSchema,
  configurationHash,
  configurationPolicyDiff,
  defaultConfigYaml,
  deploymentConfigYaml,
  loadRunConfig,
  normalizeFrozenRunConfig,
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
    expect(config.knowledge.graphify.queryBudgetTokens).toBe(4_000);
    expect(config.workflow.generateCommitMessages).toBe(false);
    expect(config.workflow.maxRunTokens).toBe(0);
    expect(config.workflow.maxRunCostUsd).toBe(0);
    expect(config.models.pricing).toEqual({});
    expect(config.workflow.maxProviderRetries).toBe(2);
    expect(config.knowledge.guidance).toMatchObject({ enabled: true, maxResults: 6, maxCharacters: 6_000 });
    expect(config.knowledge.guidance.assignments).toEqual(DEFAULT_GUIDANCE_ASSIGNMENTS);
    expect(config.knowledge.guidance.assignments?.["test-writer"].skills).toEqual(["tdd"]);
    expect(HarnessConfigSchema.parse({
      knowledge: { guidance: { enabled: true } },
    }).knowledge.guidance.assignments).toEqual(DEFAULT_GUIDANCE_ASSIGNMENTS);
    expect(config.knowledge.embeddings.enabled).toBe(false);
    expect(config.knowledge.embeddings.model).toBe("text-embedding-3-small");
    expect(config.knowledge.embeddings.minSimilarity).toBe(0.3);
    expect(config.knowledge.embeddings.minSemanticOnlySimilarity).toBe(0.45);
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
    expect(defaultConfigYaml()).toContain("assignments:");
    expect(defaultConfigYaml()).toContain("scope: project");
    expect(defaultConfigYaml()).not.toContain("agent-harness/guidance/General");
    const deployed = HarnessConfigSchema.parse(yaml.load(deploymentConfigYaml({
      sources: [
        "README.md",
        "src",
      ],
      ollama: true,
    })));
    expect(deployed.knowledge.sources).toEqual([
      expect.objectContaining({ path: "README.md", scope: "project" }),
      expect.objectContaining({ path: "src", scope: "project" }),
    ]);
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

  it("requires assignments for every agent role when explicit guidance mapping is enabled", () => {
    const complete = {
      reflector: { rules: [], skills: [] },
      griller: { rules: [], skills: [] },
      planner: { rules: [], skills: [] },
      "issue-slicer": { rules: [], skills: [] },
      "prompt-builder": { rules: [], skills: [] },
      "test-writer": { rules: [], skills: ["tdd"] },
      implementer: { rules: ["no-legacy-fallback-code"], skills: [] },
      reviewer: { rules: [], skills: ["code-review"] },
      "message-writer": { rules: [], skills: [] },
      fixer: { rules: [], skills: ["diagnose"] },
      "config-fixer": { rules: [], skills: [] },
      "project-profiler": { rules: [], skills: [] },
    };
    expect(HarnessConfigSchema.parse({
      knowledge: { guidance: { assignments: complete } },
    }).knowledge.guidance.assignments).toEqual(complete);
    expect(() => HarnessConfigSchema.parse({
      knowledge: { guidance: { assignments: { implementer: complete.implementer } } },
    })).toThrow();
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
      workflow: {
        maxGrillQuestionsPerEpisode: 8,
        staleAnswerMinutes: 45,
        testPathPatterns: ["services/**/src/test/**", "**/*Test.java"],
      },
      commands: { test: "./gradlew test" },
    });

    expect(updated.config.workflow.maxGrillQuestionsPerEpisode).toBe(8);
    expect(updated.config.workflow.staleAnswerMinutes).toBe(45);
    expect(updated.config.workflow.testPathPatterns).toEqual(["services/**/src/test/**", "**/*Test.java"]);
    expect(updated.config.commands.test).toBe("./gradlew test");
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

  it("normalizes historical minimal YAML through schema defaults without bumping CONFIG_VERSION", () => {
    const minimal = yaml.load(`
version: 2
repositoryRoot: .
`) as unknown;
    const parsed = HarnessConfigSchema.parse(minimal);
    expect(CONFIG_VERSION).toBe(9);
    expect(parsed.agent.promptBuilder).toBe(false);
    expect(parsed.knowledge.guidance.enabled).toBe(true);
    expect(parsed.git.ignoredArtifactPatterns.length).toBeGreaterThan(0);
  });

  it("strips legacy maxStepsPerRun from workflow config without treating it as policy", () => {
    const parsed = HarnessConfigSchema.parse({
      repositoryRoot: ".",
      workflow: { maxStepsPerRun: 25, tdd: true },
    });
    expect("maxStepsPerRun" in parsed.workflow).toBe(false);
    expect(parsed.workflow.tdd).toBe(true);
  });

  it("migrates frozen-run snapshots missing knowledge.guidance via normalizeFrozenRunConfig", () => {
    const root = "C:/tmp/project";
    const project = HarnessConfigSchema.parse({ repositoryRoot: root });
    const { guidance: _guidance, ...legacyKnowledge } = project.knowledge;
    const frozen = normalizeFrozenRunConfig({
      ...project,
      configVersion: 3,
      knowledge: legacyKnowledge,
    });
    expect(frozen.knowledge.guidance.enabled).toBe(false);
    const modern = normalizeFrozenRunConfig({
      ...project,
      knowledge: { ...project.knowledge, guidance: { enabled: true, maxResults: 2, maxCharacters: 1_000 } },
    });
    expect(modern.knowledge.guidance).toMatchObject({
      enabled: true,
      maxResults: 2,
      maxCharacters: 1_000,
    });
  });

  it("strips legacy guidance sources from frozen configs and records sharedRoot", () => {
    const frozen = normalizeFrozenRunConfig({
      repositoryRoot: "C:/tmp/project",
      knowledge: {
        sources: [
          { path: "C:/Users/me/AppData/Local/agent-harness/guidance/General", scope: "global" },
          { path: "README.md", scope: "project" },
          "agent-harness/guidance/General",
          "docs",
        ],
      },
    });
    expect(frozen.knowledge.sources.map((source) => source.path)).toEqual(["README.md", "docs"]);
    expect(frozen.knowledge.guidance.sharedRoot?.replaceAll("\\", "/")).toBe(
      "C:/Users/me/AppData/Local/agent-harness/guidance",
    );
  });

  it("summarizes all policy changes that require an explicit run repair", () => {
    const base = HarnessConfigSchema.parse({});
    const liveOverlay = {
      ...base,
      workflow: { ...base.workflow, testPathPatterns: ["other/**"] },
      git: { ...base.git, ignoredArtifactPatterns: ["**/Generated/**"] },
    };
    expect(configurationPolicyDiff(base, liveOverlay)).toEqual(
      expect.arrayContaining(["workflow.testPathPatterns", "git.ignoredArtifactPatterns"]),
    );

    const hashedDrift = {
      ...base,
      commands: { ...base.commands, test: "./gradlew test" },
      git: { ...base.git, baseBranch: "develop" },
    };
    expect(configurationPolicyDiff(base, hashedDrift)).toEqual(
      expect.arrayContaining(["commands.test", "git.baseBranch"]),
    );
  });

  it("defaults ignoredArtifactPatterns and includes them in configurationHash", () => {
    const empty = HarnessConfigSchema.parse({});
    expect(empty.git.ignoredArtifactPatterns).toEqual([
      "**/obj/",
      "**/bin/",
      "*.pdb",
      "*.user",
      "**/*.cache",
      "**/GeneratedMSBuildEditorConfig.editorconfig",
      "**/AssemblyAttributes.cs",
    ]);
    expect(defaultConfigYaml()).toContain("ignoredArtifactPatterns:");
    expect(defaultConfigYaml()).toContain('"**/obj/"');
    const deployed = HarnessConfigSchema.parse(yaml.load(deploymentConfigYaml()));
    expect(deployed.git.ignoredArtifactPatterns).toContain("**/obj/");

    const before = configurationHash(empty);
    const after = configurationHash({
      ...empty,
      git: {
        ...empty.git,
        ignoredArtifactPatterns: [...empty.git.ignoredArtifactPatterns, "**/Generated/**"],
      },
    });
    expect(after).not.toBe(before);

    const drift = configurationHash({
      ...empty,
      git: { ...empty.git, baseBranch: "develop" },
    });
    expect(drift).not.toBe(before);
  });

  it("excludes every runtime path and workspace identity field from configurationHash", () => {
    const base = HarnessConfigSchema.parse({
      repositoryRoot: "D:/control/root",
      stateDirectory: "D:/state/root",
      knowledge: { sharedIndexDirectory: "D:/shared/index" },
    });
    const stamped = configurationHash(base);

    expect(
      configurationHash({
        ...base,
        repositoryRoot: "E:/other/control",
        stateDirectory: "E:/other/state",
        knowledge: {
          ...base.knowledge,
          sharedIndexDirectory: "E:/other/shared",
          guidance: {
            ...base.knowledge.guidance,
            projectRoot: "E:/other/project-guidance",
            sharedRoot: "E:/other/shared-guidance",
          },
        },
      }),
    ).toBe(stamped);

    // Workspace identity is runtime metadata; even if present on a snapshot it must not hash.
    expect(
      configurationHash({
        ...base,
        worktreePath: "D:/state/worktrees/run-1",
        controlRoot: "D:/control/root",
        gitCommonDir: "D:/control/root/.git",
        baseSha: "a".repeat(40),
        branchName: "agent/feature-run",
        headSha: "b".repeat(40),
      }),
    ).toBe(stamped);

    // Policy still hashes: git.baseBranch is an intentional run policy choice.
    expect(
      configurationHash({
        ...base,
        git: { ...base.git, baseBranch: "develop" },
      }),
    ).not.toBe(stamped);
  });

  it("persists ignoredArtifactPatterns via project settings without mutating frozen runs", async () => {
    const root = await fixtureRoot();
    const configPath = path.join(root, "agent-harness.config.yaml");
    await writeFile(
      configPath,
      "version: 2\nrepositoryRoot: .\ngit:\n  ignoredArtifactPatterns: []\n",
      "utf8",
    );

    const updated = await writeProjectSettings(configPath, {
      git: { ignoredArtifactPatterns: ["**/obj/", "*.pdb"] },
    });
    expect(updated.config.git.ignoredArtifactPatterns).toEqual(["**/obj/", "*.pdb"]);
    expect(await readFile(configPath, "utf8")).toContain("**/obj/");

    const runId = "live-artifacts";
    const runDirectory = path.join(root, ".agent-harness", "runs", runId);
    await mkdir(runDirectory, { recursive: true });
    const frozen = HarnessConfigSchema.parse({
      repositoryRoot: root,
      git: { ignoredArtifactPatterns: [] },
    });
    await writeFile(path.join(runDirectory, "config.json"), `${JSON.stringify(frozen)}\n`, "utf8");

    const loaded = await loadRunConfig(updated.config, runId);
    expect(loaded.git.ignoredArtifactPatterns).toEqual(frozen.git.ignoredArtifactPatterns);
  });

  it("keeps testPathPatterns frozen until a blocked run receives a reviewed repair", async () => {
    const root = await fixtureRoot();
    const configPath = path.join(root, "agent-harness.config.yaml");
    await writeFile(
      configPath,
      "version: 2\nrepositoryRoot: .\nworkflow:\n  testPathPatterns:\n    - tests/**\n",
      "utf8",
    );
    const initial = HarnessConfigSchema.parse({
      repositoryRoot: root,
      workflow: { testPathPatterns: ["tests/**"] },
    });
    const runId = "live-test-paths";
    const runDirectory = path.join(root, ".agent-harness", "runs", runId);
    await mkdir(runDirectory, { recursive: true });
    await writeFile(path.join(runDirectory, "config.json"), `${JSON.stringify(initial)}\n`, "utf8");

    const updated = await writeProjectSettings(configPath, {
      workflow: { testPathPatterns: ["**/src/main/test/**"] },
    });
    const loaded = await loadRunConfig(updated.config, runId);

    expect(loaded.workflow.testPathPatterns).toEqual(["tests/**"]);
    expect(configurationHash(updated.config)).not.toBe(configurationHash(initial));
  });

  it("keeps a frozen run stable across project-settings edits", async () => {
    const root = await fixtureRoot();
    const configPath = path.join(root, "agent-harness.config.yaml");
    await writeFile(
      configPath,
      [
        "version: 2",
        "repositoryRoot: .",
        "commands:",
        '  test: node -e "process.exit(0)"',
        "workflow:",
        "  testPathPatterns:",
        "    - tests/**",
        "",
      ].join("\n"),
      "utf8",
    );
    const initial = HarnessConfigSchema.parse({
      repositoryRoot: root,
      commands: { test: 'node -e "process.exit(0)"' },
      workflow: { testPathPatterns: ["tests/**"] },
    });
    const stamped = configurationHash(initial);
    const runId = "mid-run-test-paths";
    const runDirectory = path.join(root, ".agent-harness", "runs", runId);
    await mkdir(runDirectory, { recursive: true });
    await writeFile(path.join(runDirectory, "config.json"), `${JSON.stringify(initial)}\n`, "utf8");

    const afterPaths = await writeProjectSettings(configPath, {
      workflow: { testPathPatterns: ["modules/**/src/test/**"] },
    });
    const loadedAfterPaths = await loadRunConfig(afterPaths.config, runId);
    expect(configurationHash(loadedAfterPaths)).toBe(stamped);
    expect(loadedAfterPaths.workflow.testPathPatterns).toEqual(["tests/**"]);
    expect(loadedAfterPaths.commands.test).toBe('node -e "process.exit(0)"');

    const afterCommand = await writeProjectSettings(configPath, {
      commands: { test: "./gradlew test" },
    });
    const loadedAfterCommand = await loadRunConfig(afterCommand.config, runId);
    expect(configurationHash(loadedAfterCommand)).toBe(stamped);
    expect(loadedAfterCommand.commands.test).toBe('node -e "process.exit(0)"');
    expect(loadedAfterCommand.workflow.testPathPatterns).toEqual(["tests/**"]);
  });
});
