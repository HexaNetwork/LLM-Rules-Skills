import yaml from "js-yaml";
import type { AgentRole } from "../domain.js";
import {
  HarnessConfigSchema,
  type HarnessConfig,
  type KnowledgeScope,
  type KnowledgeVisibility,
} from "./schema.js";

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
  # Opt-in $/MTok rates keyed by model id; unpriced models contribute 0 cost.
  pricing: {}

agent:
  provider: cursor
  timeoutMs: 1200000
  promptBuilder: false
  schemaRepairAttempts: 1

workflow:
  tdd: true
  # Expensive steps only (agent invocations and shell commands).
  maxStepsPerRun: 40
  # Hard spend ceilings (0 = unlimited); enforced between steps, never mid-step.
  maxRunTokens: 0
  maxRunCostUsd: 0
  # Transient provider failures retry in-place (backoff 1s/4s/16s); does not consume step budget.
  maxProviderRetries: 2
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
  # Reviewer diff budget (defaults to min(20000, inputCharacters/2) when omitted).
  reviewDiffCharacters: 12000
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
  # Child commands receive only runtime variables by default. Add only the
  # non-secret environment variable names a project command genuinely needs.
  passEnv: []
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
  # Build/generated paths ignored for dirty-tree and unreported-path checks (not .gitignore).
  # Live project policy — changes apply to in-progress runs without config-drift blocks.
  ignoredArtifactPatterns:
    - "**/obj/"
    - "**/bin/"
    - "*.pdb"
    - "*.user"
    - "**/*.cache"
    - "**/GeneratedMSBuildEditorConfig.editorconfig"
    - "**/AssemblyAttributes.cs"

tracker:
  kind: local

knowledge:
  projectId: my-project
  # Optional shared directory used by several project configs.
  # sharedIndexDirectory: ../shared-rag-index
  sources:
    # Seeded by init/deploy from package templates (use --no-seed-guidance to skip).
    - path: agent-harness/guidance/General
      scope: global
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
    # Complete, authoritative guidance map. Empty lists intentionally inject nothing.
    # Project rules/skills with the same name override General/; otherwise General/ is used.
    assignments:
      reflector:
        rules: []
        skills: [domain-modeling]
      griller:
        rules: []
        skills: [grill-me, domain-modeling]
      planner:
        rules: []
        skills: [domain-modeling, improve-codebase-architecture]
      prompt-builder:
        rules: []
        skills: []
      test-writer:
        rules: []
        skills: [tdd]
      implementer:
        rules: []
        skills: [tdd]
      reviewer:
        rules: []
        skills: [code-review]
      message-writer:
        rules: []
        skills: []
      fixer:
        rules: []
        skills: [diagnose, tdd]
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
  sources?: Array<string | { path: string; scope?: KnowledgeScope; visibility?: KnowledgeVisibility }>;
  ollama?: boolean;
  model?: string;
  graphify?: boolean;
} = {}): string {
  const value: unknown = yaml.load(defaultConfigYaml());
  if (!isRecord(value) || !isRecord(value.knowledge)) {
    throw new Error("Default harness configuration is invalid");
  }
  const sources = options.sources?.map((source) =>
    typeof source === "string"
      ? { path: source, scope: "project" as const, visibility: "private" as const }
      : {
          path: source.path,
          scope: source.scope ?? ("project" as const),
          visibility: source.visibility ?? ("private" as const),
        },
  );
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
