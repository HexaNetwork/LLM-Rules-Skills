import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import yaml from "js-yaml";
import { z } from "zod";
import { AgentRoleSchema, type AgentRole } from "./domain.js";

/** Structural Graphify lookup is valuable for workers that edit or review code. */
const REPOSITORY_LOOKUP_ROLES: AgentRole[] = [
  "planner",
  "test-writer",
  "implementer",
  "reviewer",
];

/** Bumped when the frozen run-config shape changes in a way that needs migration. */
export const CONFIG_VERSION = 4;

export const PreflightCommitOrderSchema = z.enum(["branch-then-commit", "commit-then-branch"]);
export type PreflightCommitOrder = z.infer<typeof PreflightCommitOrderSchema>;

export const KnowledgeScopeSchema = z.enum(["global", "project"]);
export type KnowledgeScope = z.infer<typeof KnowledgeScopeSchema>;

export const KnowledgeVisibilitySchema = z.enum(["private", "shared", "restricted"]);
export type KnowledgeVisibility = z.infer<typeof KnowledgeVisibilitySchema>;

export const KnowledgeSourceSchema = z
  .union([
    z.string().min(1),
    z.object({
      path: z.string().min(1),
      scope: KnowledgeScopeSchema.default("project"),
      projectId: z.string().min(1).optional(),
      visibility: KnowledgeVisibilitySchema.default("private"),
    }),
  ])
  .transform((source) =>
    typeof source === "string"
      ? { path: source, scope: "project" as const, visibility: "private" as const }
      : source,
  );
export type KnowledgeSource = z.infer<typeof KnowledgeSourceSchema>;

export const HarnessConfigSchema = z.object({
  version: z.literal(2).default(2),
  repositoryRoot: z.string().default("."),
  stateDirectory: z.string().default(".agent-harness"),
  models: z
    .object({
      small: z.string().min(1),
      capable: z.string().min(1),
      roles: z.record(z.string()).default({}),
    })
    .default({ small: "composer-2.5", capable: "composer-2.5", roles: {} }),
  agent: z
    .object({
      provider: z.enum(["cursor"]).default("cursor"),
      timeoutMs: z.number().int().positive().default(20 * 60 * 1000),
      promptBuilder: z.boolean().default(false),
      schemaRepairAttempts: z.number().int().min(0).max(3).default(1),
    })
    .default({}),
  workflow: z
    .object({
      tdd: z.boolean().default(true),
      // Counts expensive steps (agent invocations / shell commands), not free transitions.
      maxStepsPerRun: z.number().int().positive().max(100).default(40),
      maxTestAttempts: z.number().int().positive().max(10).default(2),
      maxImplementationAttempts: z.number().int().positive().max(10).default(3),
      maxReviewAttempts: z.number().int().positive().max(10).default(2),
      // Grill-me reuses one provider session for this many Q→A turns, then
      // rolls to a fresh agent with a compact brief of resolutions so far.
      maxGrillQuestionsPerEpisode: z.number().int().positive().max(50).default(5),
      // Answers older than this force a cold agent with only question+answer.
      staleAnswerMinutes: z.number().int().positive().max(24 * 60).default(30),
      // Ceiling on questions per griller turn, not a target: only mutually independent questions may be batched.
      grillQuestionsPerBatch: z.number().int().min(1).max(6).default(3),
      contextResults: z.number().int().min(0).max(20).default(6),
      // Guidance + retrieved context ceiling for each work packet.
      contextCharacters: z.number().int().positive().default(12_000),
      // Serialized packet.input ceiling (longest string leaf truncated first).
      inputCharacters: z.number().int().positive().default(24_000),
      // Graphify excerpt sub-budget within the context ceiling.
      graphifyCharacters: z.number().int().positive().default(3_000),
      // Per-task commit subjects use the deterministic fallback unless enabled.
      generateCommitMessages: z.boolean().default(false),
      // Globs that mark paths as test-only for the test-writer legality check.
      testPathPatterns: z.array(z.string().min(1)).default([
        "tests/**",
        "test/**",
        "**/__tests__/**",
        "**/*.test.*",
        "**/*.spec.*",
        "**/*_test.*",
        "src/test/**",
      ]),
    })
    .default({}),
  commands: z
    .object({
      test: z.string().min(1).default("npm test -- --run"),
      gates: z
        .array(
          z.object({
            id: z.string().min(1),
            command: z.string().min(1),
            timeoutMs: z.number().int().positive().default(10 * 60 * 1000),
          }),
        )
        .default([]),
    })
    .default({}),
  git: z
    .object({
      enabled: z.boolean().default(true),
      baseBranch: z.string().min(1).default("main"),
      branchPrefix: z.string().min(1).default("harness"),
      remote: z.string().min(1).default("origin"),
      push: z.boolean().default(false),
      openPullRequest: z.boolean().default(false),
      // Explicit action (dashboard/CLI) is the default path; this makes start() sweep a dirty tree itself.
      autoCommitPreflight: z.boolean().default(false),
      // branch-then-commit deviates from baseBranch branching: the run branch is cut from
      // current HEAD so the dirty tree rides onto it, not from config.git.baseBranch.
      preflightCommitOrder: PreflightCommitOrderSchema.default("branch-then-commit"),
    })
    .default({}),
  knowledge: z
    .object({
      // A stable id makes this collection safe to share with other project roots.
      projectId: z.string().min(1).default("default"),
      // When configured, multiple projects can index into one directory. Access is
      // still filtered by projectId before any retrieval scoring occurs.
      sharedIndexDirectory: z.string().min(1).optional(),
      sources: z.array(KnowledgeSourceSchema).default(["README.md", "docs"]),
      chunkCharacters: z.number().int().positive().default(2_000),
      // Refuse weak lexical hits before hybrid fusion so embeddings cannot
      // resurrect near-zero accidental term matches into the packet.
      relevanceFloor: z.number().min(0).max(1).default(0.55),
      minLexicalScore: z.number().min(0).default(0.05),
      maxChunksPerSource: z.number().int().min(1).max(20).default(1),
      // Highest-ranked source may contribute this many chunks; others use maxChunksPerSource.
      maxForTopSource: z.number().int().min(1).max(20).default(2),
      guidance: z
        .object({
          enabled: z.boolean().default(true),
          maxResults: z.number().int().min(0).max(20).default(6),
          maxCharacters: z.number().int().positive().default(6_000),
        })
        .default({}),
      embeddings: z
        .object({
          // Kept opt-in: the lexical index remains the offline baseline.
          enabled: z.boolean().default(false),
          provider: z.enum(["openai-compatible", "ollama"]).default("openai-compatible"),
          endpoint: z.string().url().default("https://api.openai.com/v1/embeddings"),
          model: z.string().min(1).default("text-embedding-3-small"),
          apiKeyEnv: z.string().min(1).default("OPENAI_API_KEY"),
          batchSize: z.number().int().min(1).max(256).default(32),
          timeoutMs: z.number().int().positive().default(30_000),
          minSimilarity: z.number().min(-1).max(1).default(0.2),
          lexicalWeight: z.number().positive().default(1),
          semanticWeight: z.number().positive().default(1),
        })
        .default({}),
      graphify: z
        .object({
          enabled: z.boolean().default(false),
          command: z.string().min(1).default("graphify"),
          updateOnRefresh: z.boolean().default(false),
          updateTimeoutMs: z.number().int().positive().default(120_000),
          queryTimeoutMs: z.number().int().positive().default(15_000),
          queryBudgetTokens: z.number().int().positive().max(10_000).default(1_200),
          roles: z.array(AgentRoleSchema).default(REPOSITORY_LOOKUP_ROLES),
          // Project-specific noise merged over the built-in English + harness lists.
          stopwords: z.array(z.string().min(1)).default([]),
          // Extensions that count as source for post-commit graphify rebuild.
          sourceExtensions: z.array(z.string().min(1)).default([
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
          ]),
        })
        .default({}),
    })
    .default({}),
  tracker: z.object({ kind: z.literal("local").default("local") }).default({}),
});

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;

export const ProjectSettingsPatchSchema = z
  .object({
    workflow: z
      .object({
        maxGrillQuestionsPerEpisode: z.number().int().positive().max(50).optional(),
        staleAnswerMinutes: z.number().int().positive().max(24 * 60).optional(),
        grillQuestionsPerBatch: z.number().int().min(1).max(6).optional(),
      })
      .strict()
      .optional(),
    git: z
      .object({
        autoCommitPreflight: z.boolean().optional(),
        preflightCommitOrder: PreflightCommitOrderSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ProjectSettingsPatch = z.infer<typeof ProjectSettingsPatchSchema>;

export const CONFIG_NAMES = [
  "agent-harness.config.yaml",
  "agent-harness.config.yml",
  "agent-harness.config.json",
] as const;

export async function loadConfig(
  configPath?: string,
  cwd = process.cwd(),
): Promise<{ config: HarnessConfig; path: string }> {
  let resolved: string | undefined;
  if (configPath) {
    resolved = path.resolve(cwd, configPath);
  } else {
    for (const name of CONFIG_NAMES) {
      const candidate = path.join(cwd, name);
      try {
        await readFile(candidate, "utf8");
        resolved = candidate;
        break;
      } catch {
        // Try the next conventional filename.
      }
    }
  }
  if (!resolved) {
    throw new Error("No harness config found. Run `agent-harness init` first.");
  }
  const raw = await readFile(resolved, "utf8");
  const value: unknown = resolved.endsWith(".json") ? JSON.parse(raw) : yaml.load(raw);
  const parsed = HarnessConfigSchema.parse(value);
  return {
    path: resolved,
    config: {
      ...parsed,
      repositoryRoot: path.resolve(path.dirname(resolved), parsed.repositoryRoot),
    },
  };
}

export async function writeProjectSettings(
  configPath: string,
  patch: ProjectSettingsPatch,
): Promise<{ config: HarnessConfig; path: string }> {
  const resolved = path.resolve(configPath);
  const raw = await readFile(resolved, "utf8");
  const value: unknown = resolved.endsWith(".json") ? JSON.parse(raw) : yaml.load(raw);
  if (!isRecord(value)) throw new Error("Harness config must contain an object");

  const parsedPatch = ProjectSettingsPatchSchema.parse(patch);
  const workflow = isRecord(value.workflow) ? value.workflow : {};
  const git = isRecord(value.git) ? value.git : {};
  const candidate = {
    ...value,
    ...(parsedPatch.workflow
      ? { workflow: { ...workflow, ...parsedPatch.workflow } }
      : {}),
    ...(parsedPatch.git ? { git: { ...git, ...parsedPatch.git } } : {}),
  };
  HarnessConfigSchema.parse(candidate);

  const serialized = resolved.endsWith(".json")
    ? `${JSON.stringify(candidate, null, 2)}\n`
    : yaml.dump(candidate, { noRefs: true, lineWidth: -1 });
  await writeFile(resolved, serialized, "utf8");
  return loadConfig(resolved);
}

export async function loadRunConfig(
  projectConfig: HarnessConfig,
  runId: string,
): Promise<HarnessConfig> {
  const snapshot = path.resolve(
    projectConfig.repositoryRoot,
    projectConfig.stateDirectory,
    "runs",
    runId,
    "config.json",
  );
  const raw: unknown = JSON.parse(await readFile(snapshot, "utf8"));
  const { configVersion: _configVersion, ...withoutVersion } = isRecord(raw)
    ? raw
    : { configVersion: undefined };
  // Frozen runs predate smart guidance. Preserve their exact retrieval
  // behavior instead of silently changing an in-progress delivery.
  if (
    isRecord(withoutVersion) &&
    isRecord(withoutVersion.knowledge) &&
    !Object.hasOwn(withoutVersion.knowledge, "guidance")
  ) {
    return HarnessConfigSchema.parse({
      ...withoutVersion,
      knowledge: { ...withoutVersion.knowledge, guidance: { enabled: false } },
    });
  }
  return HarnessConfigSchema.parse(withoutVersion);
}

const SMALL_ROLES = new Set<AgentRole>(["prompt-builder", "message-writer"]);

export function modelForRole(config: HarnessConfig, role: AgentRole): string {
  return config.models.roles[role] ??
    (SMALL_ROLES.has(role) ? config.models.small : config.models.capable);
}

export function defaultConfigYaml(): string {
  return `version: 2
repositoryRoot: .
stateDirectory: .agent-harness

models:
  small: composer-2.5
  capable: composer-2.5
  roles: {}

agent:
  provider: cursor
  timeoutMs: 1200000
  promptBuilder: false
  schemaRepairAttempts: 1

workflow:
  tdd: true
  # Expensive steps only (agent invocations and shell commands).
  maxStepsPerRun: 40
  maxTestAttempts: 2
  maxImplementationAttempts: 3
  maxReviewAttempts: 2
  maxGrillQuestionsPerEpisode: 5
  staleAnswerMinutes: 30
  grillQuestionsPerBatch: 3
  contextResults: 6
  # Guidance + retrieved context ceiling.
  contextCharacters: 12000
  # Serialized packet.input ceiling.
  inputCharacters: 24000
  # Graphify excerpt sub-budget inside contextCharacters.
  graphifyCharacters: 3000
  # Deterministic commit subjects by default; PR bodies still use the model.
  generateCommitMessages: false
  # Paths the test-writer may edit; tune for Go (_test.go), Maven (src/test), etc.
  testPathPatterns:
    - tests/**
    - test/**
    - "**/__tests__/**"
    - "**/*.test.*"
    - "**/*.spec.*"
    - "**/*_test.*"
    - src/test/**

commands:
  test: npm test -- --run
  gates:
    - id: typecheck
      command: npm run typecheck
    - id: test
      command: npm test -- --run

git:
  enabled: true
  baseBranch: main
  branchPrefix: harness
  remote: origin
  push: false
  openPullRequest: false
  # A dirty tree blocks by default; the dashboard/CLI offer an explicit commit-and-retry.
  autoCommitPreflight: false
  # branch-then-commit cuts the run branch from current HEAD (not baseBranch) so a dirty
  # tree rides onto it. commit-then-branch commits on the current branch first instead.
  preflightCommitOrder: branch-then-commit

tracker:
  kind: local

knowledge:
  projectId: my-project
  # Optional shared directory used by several project configs.
  # sharedIndexDirectory: ../shared-rag-index
  sources:
    - path: README.md
      scope: project
    - path: docs
      scope: project
  chunkCharacters: 2000
  # Keep lexical hits within a band of the top score; refuse crumbs.
  relevanceFloor: 0.55
  minLexicalScore: 0.05
  maxChunksPerSource: 1
  # Top-ranked source may contribute two chunks; every other source one.
  maxForTopSource: 2
  guidance:
    enabled: true
    maxResults: 6
    maxCharacters: 6000
  # Optional semantic document retrieval. Vectors remain in the local index;
  # the API key is read from the named environment variable, never this file.
  embeddings:
    enabled: false
    provider: openai-compatible
    endpoint: https://api.openai.com/v1/embeddings
    model: text-embedding-3-small
    apiKeyEnv: OPENAI_API_KEY
    batchSize: 32
    timeoutMs: 30000
    minSimilarity: 0.2
    lexicalWeight: 1
    semanticWeight: 1
  graphify:
    # Structural code retrieval is on for new harnesses. Use --no-graphify
    # during deploy, or set enabled: false, for document-only projects.
    enabled: true
    command: graphify
    # Initial setup happens before the first new run; later rebuilds happen
    # after each verified source-file commit. Keep this false so a document
    # index refresh does not needlessly rebuild the repository graph.
    updateOnRefresh: false
    updateTimeoutMs: 120000
    queryTimeoutMs: 15000
    queryBudgetTokens: 1200
    # Extra stopwords merged over the built-in English + harness lists.
    stopwords: []
    # File extensions that trigger a graphify rebuild after a verified commit.
    sourceExtensions:
      - .ts
      - .tsx
      - .js
      - .jsx
      - .mjs
      - .cjs
      - .py
      - .go
      - .rs
      - .java
      - .kt
      - .kts
      - .cs
      - .cpp
      - .c
      - .h
      - .hpp
      - .rb
      - .php
      - .swift
`;
}

export function deploymentConfigYaml(options: {
  sources?: string[];
  ollama?: boolean;
  model?: string;
  graphify?: boolean;
} = {}): string {
  const value: unknown = yaml.load(defaultConfigYaml());
  if (!isRecord(value) || !isRecord(value.knowledge)) {
    throw new Error("Default harness configuration is invalid");
  }
  const sources = options.sources?.map((source) => ({ path: source, scope: "project" }));
  const knowledge = {
    ...value.knowledge,
    ...(sources ? { sources } : {}),
    ...(options.ollama
      ? {
          embeddings: {
            enabled: true,
            provider: "ollama",
            endpoint: "http://localhost:11434/api/embed",
            model: options.model || "qwen3-embedding",
            batchSize: 16,
            timeoutMs: 120_000,
            minSimilarity: 0.2,
            lexicalWeight: 1,
            semanticWeight: 1,
          },
        }
      : {}),
    ...(options.graphify === false
      ? {
          graphify: {
            enabled: false,
            updateOnRefresh: false,
          },
        }
      : {}),
  };
  HarnessConfigSchema.parse({ ...value, knowledge });
  return yaml.dump({ ...value, knowledge }, { noRefs: true, lineWidth: -1 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
