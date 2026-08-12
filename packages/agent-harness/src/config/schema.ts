import { createHash } from "node:crypto";
import { z } from "zod";
import { AgentRoleSchema, type AgentRole } from "../domain.js";

/** Structural Graphify lookup is valuable for workers that edit or review code. */
const REPOSITORY_LOOKUP_ROLES: AgentRole[] = [
  "planner",
  "scenario-planner",
  "issue-slicer",
  "scenario-writer",
  "unit-test-writer",
  "implementer",
  "reviewer",
  "task-reviewer",
];

/**
 * Bumped when the frozen run-config shape or configuration-hash algorithm changes
 * in a way that needs migration (ensureCompatibleConfiguration re-stamps the hash).
 */
export const CONFIG_VERSION = 14;

export const VerificationCommandSchema = z.object({
  id: z.string().min(1),
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().default(10 * 60 * 1000),
});
export type VerificationCommand = z.infer<typeof VerificationCommandSchema>;

/** Environment paths / workspace identity — omitted from configurationHash. */
const CONFIG_HASH_OMIT_PATHS = new Set([
  "repositoryRoot",
  "stateDirectory",
  "worktreeRoot",
  "knowledge.sharedIndexDirectory",
  // Machine-local guidance trees (resolved from harness home / project registration).
  "knowledge.guidance.projectRoot",
  "knowledge.guidance.sharedRoot",
  // Runtime workspace metadata (lives in workspace.json; omitted if present on a snapshot).
  "worktreePath",
  "controlRoot",
  "gitCommonDir",
  "baseSha",
  "branchName",
  "headSha",
]);

/** Default build/generated globs ignored when deciding dirty / unreported paths. */
export const DEFAULT_IGNORED_ARTIFACT_PATTERNS = [
  "**/obj/",
  "**/bin/",
  "*.pdb",
  "*.user",
  "**/*.cache",
  "**/GeneratedMSBuildEditorConfig.editorconfig",
  "**/AssemblyAttributes.cs",
] as const;

export const PreflightCommitOrderSchema = z.enum(["branch-then-commit", "commit-then-branch"]);
export type PreflightCommitOrder = z.infer<typeof PreflightCommitOrderSchema>;

export const KnowledgeScopeSchema = z.enum(["global", "project"]);
export type KnowledgeScope = z.infer<typeof KnowledgeScopeSchema>;

export const KnowledgeVisibilitySchema = z.enum(["private", "shared", "restricted"]);
export type KnowledgeVisibility = z.infer<typeof KnowledgeVisibilitySchema>;

const GuidanceAssignmentSchema = z.object({
  rules: z.array(z.string().min(1)).default([]),
  skills: z.array(z.string().min(1)).default([]),
}).strict();

const GuidanceAssignmentsObjectSchema = z.object({
  reflector: GuidanceAssignmentSchema,
  griller: GuidanceAssignmentSchema,
  planner: GuidanceAssignmentSchema,
  "scenario-planner": GuidanceAssignmentSchema.default({ rules: [], skills: [] }),
  "issue-slicer": GuidanceAssignmentSchema.default({
    rules: [],
    skills: ["prd-to-issues", "domain-modeling", "improve-codebase-architecture"],
  }),
  "prompt-builder": GuidanceAssignmentSchema,
  "scenario-writer": GuidanceAssignmentSchema.default({ rules: [], skills: [] }),
  "unit-test-writer": GuidanceAssignmentSchema.default({ rules: [], skills: [] }),
  implementer: GuidanceAssignmentSchema,
  reviewer: GuidanceAssignmentSchema,
  // Default keeps older assignment maps valid when this role is introduced.
  "task-reviewer": GuidanceAssignmentSchema.default({ rules: [], skills: ["task-review"] }),
  "message-writer": GuidanceAssignmentSchema,
  fixer: GuidanceAssignmentSchema,
  // Default keeps older assignment maps valid when this role is introduced.
  "config-fixer": GuidanceAssignmentSchema.default({ rules: [], skills: [] }),
  "project-profiler": GuidanceAssignmentSchema.default({ rules: [], skills: [] }),
}).strict();

/** Strip deleted roles from legacy assignment maps before strict parse. */
const GuidanceAssignmentsSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const {
    ["test-writer"]: _testWriter,
    ["red-writer"]: _redWriter,
    ...rest
  } = value as Record<string, unknown>;
  return rest;
}, GuidanceAssignmentsObjectSchema);

/** Authoritative guidance map applied when `knowledge.guidance.assignments` is omitted. */
export const DEFAULT_GUIDANCE_ASSIGNMENTS: z.infer<typeof GuidanceAssignmentsObjectSchema> = {
  reflector: { rules: [], skills: ["domain-modeling"] },
  griller: { rules: [], skills: ["grill-me", "domain-modeling"] },
  planner: { rules: [], skills: ["domain-modeling", "to-prd"] },
  "scenario-planner": { rules: [], skills: [] },
  "issue-slicer": {
    rules: [],
    skills: ["prd-to-issues", "domain-modeling", "improve-codebase-architecture"],
  },
  "prompt-builder": { rules: [], skills: [] },
  "scenario-writer": { rules: [], skills: [] },
  "unit-test-writer": { rules: [], skills: [] },
  implementer: { rules: [], skills: [] },
  reviewer: { rules: [], skills: ["code-review"] },
  "task-reviewer": { rules: [], skills: ["task-review"] },
  "message-writer": { rules: [], skills: [] },
  fixer: { rules: [], skills: ["diagnose"] },
  "config-fixer": { rules: [], skills: [] },
  "project-profiler": { rules: [], skills: [] },
};

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
  /**
   * Optional external worktree parent. When omitted, external state uses the
   * sibling `<repository-name>-worktrees` convention; legacy state nests under
   * `<stateRoot>/worktrees`.
   */
  worktreeRoot: z.string().min(1).optional(),
  models: z
    .object({
      small: z.string().min(1),
      capable: z.string().min(1),
      roles: z.record(z.string()).default({}),
      // Opt-in $/MTok rates; unpriced models contribute tokens but 0 cost.
      pricing: z
        .record(
          z.object({
            inputPerMillion: z.number().nonnegative(),
            outputPerMillion: z.number().nonnegative(),
            cacheReadPerMillion: z.number().nonnegative().default(0),
            cacheWritePerMillion: z.number().nonnegative().default(0),
          }),
        )
        .default({}),
    })
    .default({ small: "composer-2.5", capable: "composer-2.5", roles: {}, pricing: {} }),
  agent: z
    .object({
      provider: z.enum(["cursor"]).default("cursor"),
      timeoutMs: z.number().int().positive().default(20 * 60 * 1000),
      promptBuilder: z.boolean().default(false),
      schemaRepairAttempts: z.number().int().min(0).max(3).default(1),
      /**
       * When true, refuse providers that cannot restrict the writable workspace
       * to the run worktree (see workspaceCapabilities).
       */
      strictIsolation: z.boolean().default(false),
    })
    .default({}),
  workflow: z
    .object({
      /** Document RAG into work packets; independent of Graphify and guidance. */
      rag: z.boolean().default(true),
      // Hard spend ceilings enforced between steps; 0 = unlimited.
      maxRunTokens: z.number().int().nonnegative().default(0),
      maxRunCostUsd: z.number().nonnegative().default(0),
      // Per-invocation / per-task token ceilings (0 = unlimited). Circuit-breaker only.
      maxInvocationTokens: z.number().int().nonnegative().default(0),
      maxTaskTokens: z.number().int().nonnegative().default(0),
      // Release a reused provider context after this many turns (0 = unlimited).
      maxContextTurns: z.number().int().nonnegative().default(0),
      // Automatic in-place retries for transient provider failures inside advance().
      maxProviderRetries: z.number().int().min(0).max(5).default(2),
      // Implementation attempt limit per task during executing.
      maxImplementationAttempts: z.number().int().positive().max(10).default(3),
      maxReviewAttempts: z.number().int().positive().max(10).default(2),
      // Holistic final-review attempts after crystallizing (separate from per-task budgets).
      maxFinalReviewAttempts: z.number().int().positive().max(10).default(2),
      coverage: z
        .object({
          enabled: z.boolean().default(false),
          threshold: z.number().min(0).max(1).default(0.9),
          scope: z.enum(["changed", "all"]).default("changed"),
          maxAttempts: z.number().int().positive().max(10).default(3),
        })
        .default({}),
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
      // Reviewer diff budget; defaults to Math.min(20_000, inputCharacters/2) so
      // a full-size diff survives buildWorkPacket without input-budget truncation.
      reviewDiffCharacters: z.number().int().positive().optional(),
      // Graphify excerpt sub-budget within the context ceiling.
      graphifyCharacters: z.number().int().positive().default(3_000),
      // Per-task commit subjects use the deterministic fallback unless enabled.
      generateCommitMessages: z.boolean().default(false),
      // Globs that mark paths as test files for test-writer path validation.
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
    .default({})
    .transform((workflow) => ({
      ...workflow,
      reviewDiffCharacters:
        workflow.reviewDiffCharacters ??
        Math.min(20_000, Math.floor(workflow.inputCharacters / 2)),
    })),
  commands: z
    .object({
      /** Authoritative ordered commands used at baseline and after implementation. */
      verification: z.array(VerificationCommandSchema).min(1),
      /** Config-owned targeted-test command. `{filter}` is replaced by the task filter. */
      testTargetTemplate: z.string().min(1).optional(),
      /** Optional coverage measurement; required when workflow.coverage.enabled. */
      coverage: z
        .object({
          command: z.string().min(1),
          reportPath: z.string().min(1),
          format: z.enum(["lcov", "cobertura", "clover"]),
          timeoutMs: z.number().int().positive().default(10 * 60 * 1000),
        })
        .optional(),
      // Child processes intentionally start with a minimal environment. Projects
      // can opt individual non-secret variables back in when their test/build
      // command needs them.
      passEnv: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).default([]),
    })
    .strict()
    .default({
      verification: [
        { id: "test", command: "npm test -- --run", timeoutMs: 10 * 60 * 1000 },
      ],
    }),
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
      // commit-then-branch commits on the current checkout; start()/preflight then cuts
      // the run branch from baseBranch before indexing and interview.
      preflightCommitOrder: PreflightCommitOrderSchema.default("branch-then-commit"),
      // Globs ignored when deciding whether the tree is dirty / a path is unreported.
      ignoredArtifactPatterns: z
        .array(z.string().min(1))
        .default([...DEFAULT_IGNORED_ARTIFACT_PATTERNS]),
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
      relevanceFloor: z.number().min(0).max(1).default(0.72),
      minLexicalScore: z.number().min(0).default(0.05),
      maxChunksPerSource: z.number().int().min(1).max(20).default(1),
      // Highest-ranked source may contribute this many chunks; others use maxChunksPerSource.
      maxForTopSource: z.number().int().min(1).max(20).default(2),
      guidance: z
        .object({
          enabled: z.boolean().default(true),
          maxResults: z.number().int().min(0).max(20).default(6),
          maxCharacters: z.number().int().positive().default(6_000),
          // Optional absolute/relative roots used by GuidanceLoader (not knowledge.sources).
          // Runtime prefers frozen run copy > projectRoot > sharedRoot.
          projectRoot: z.string().min(1).optional(),
          sharedRoot: z.string().min(1).optional(),
          // When present, this complete map is authoritative. A listed name resolves
          // to active-project guidance first and General/ guidance second.
          // Omitted assignments use DEFAULT_GUIDANCE_ASSIGNMENTS (not free lexical ranking).
          assignments: GuidanceAssignmentsSchema.default(DEFAULT_GUIDANCE_ASSIGNMENTS),
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
          minSimilarity: z.number().min(-1).max(1).default(0.3),
          // Stricter floor for chunks that enter ranking with no lexical evidence.
          minSemanticOnlySimilarity: z.number().min(-1).max(1).default(0.45),
          lexicalWeight: z.number().positive().default(1),
          semanticWeight: z.number().positive().default(1),
        })
        .default({}),
      graphify: z
        .object({
          enabled: z.boolean().default(false),
          command: z.string().min(1).default("graphify"),
          updateOnRefresh: z.boolean().default(false),
          // First `graphify update` on a large repo often needs longer than 2 minutes.
          updateTimeoutMs: z.number().int().positive().default(600_000),
          queryTimeoutMs: z.number().int().positive().default(15_000),
          queryBudgetTokens: z.number().int().positive().max(10_000).default(4_000),
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
}).superRefine((config, ctx) => {
  if (config.workflow.coverage.enabled && !config.commands.coverage) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "commands.coverage is required when workflow.coverage.enabled is true",
      path: ["commands", "coverage"],
    });
  }
});

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;

export const ProjectSettingsPatchSchema = z
  .object({
    workflow: z
      .object({
        maxGrillQuestionsPerEpisode: z.number().int().positive().max(50).optional(),
        staleAnswerMinutes: z.number().int().positive().max(24 * 60).optional(),
        grillQuestionsPerBatch: z.number().int().min(1).max(6).optional(),
        testPathPatterns: z.array(z.string().min(1)).max(500).optional(),
      })
      .strict()
      .optional(),
    commands: z
      .object({
        verification: z.array(VerificationCommandSchema).min(1).optional(),
        testTargetTemplate: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    git: z
      .object({
        autoCommitPreflight: z.boolean().optional(),
        preflightCommitOrder: PreflightCommitOrderSchema.optional(),
        ignoredArtifactPatterns: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ProjectSettingsPatch = z.infer<typeof ProjectSettingsPatchSchema>;

/**
 * Permitted frozen run-policy mutations (project-settings repairs plus budget/TDD).
 * Paths and workspace identity are not patchable here.
 */
export const RunPolicyPatchSchema = z
  .object({
    workflow: z
      .object({
        maxGrillQuestionsPerEpisode: z.number().int().positive().max(50).optional(),
        staleAnswerMinutes: z.number().int().positive().max(24 * 60).optional(),
        grillQuestionsPerBatch: z.number().int().min(1).max(6).optional(),
        testPathPatterns: z.array(z.string().min(1)).max(500).optional(),
        maxRunTokens: z.number().int().nonnegative().optional(),
        maxRunCostUsd: z.number().nonnegative().optional(),
        rag: z.boolean().optional(),
        maxFinalReviewAttempts: z.number().int().positive().max(10).optional(),
        coverage: z
          .object({
            enabled: z.boolean().optional(),
            threshold: z.number().min(0).max(1).optional(),
            scope: z.enum(["changed", "all"]).optional(),
            maxAttempts: z.number().int().positive().max(10).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    commands: z
      .object({
        verification: z.array(VerificationCommandSchema).min(1).optional(),
        testTargetTemplate: z.string().min(1).optional(),
        coverage: z
          .object({
            command: z.string().min(1),
            reportPath: z.string().min(1),
            format: z.enum(["lcov", "cobertura", "clover"]),
            timeoutMs: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    git: z
      .object({
        autoCommitPreflight: z.boolean().optional(),
        preflightCommitOrder: PreflightCommitOrderSchema.optional(),
        ignoredArtifactPatterns: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    knowledge: z
      .object({
        graphify: z
          .object({
            enabled: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type RunPolicyPatch = z.infer<typeof RunPolicyPatchSchema>;

export const CONFIG_NAMES = [
  "agent-harness.config.yaml",
  "agent-harness.config.yml",
  "agent-harness.config.json",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Canonical policy view for hashing: keys sorted recursively; environment paths omitted.
 */
function canonicalConfigForHash(config: unknown): unknown {
  return canonicalizeForHash(config, "");
}

/** Stable sha256 over the canonical policy view of a harness config. */
export function configurationHash(config: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalConfigForHash(config)))
    .digest("hex");
}

/**
 * Short list of hashed-policy paths that differ between two configs.
 * Omits machine-local paths only.
 */
export function configurationPolicyDiff(
  left: unknown,
  right: unknown,
  maxEntries = 12,
): string[] {
  const diffs: string[] = [];
  collectPolicyDiffs(canonicalConfigForHash(left), canonicalConfigForHash(right), "", diffs, maxEntries);
  return diffs;
}

function collectPolicyDiffs(
  left: unknown,
  right: unknown,
  keyPath: string,
  out: string[],
  maxEntries: number,
): void {
  if (out.length >= maxEntries) return;
  if (left === right) return;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      out.push(keyPath || "(root)");
    }
    return;
  }
  if (!isRecord(left) || !isRecord(right)) {
    out.push(keyPath || "(root)");
    return;
  }
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of [...keys].sort()) {
    if (out.length >= maxEntries) return;
    const childPath = keyPath ? `${keyPath}.${key}` : key;
    if (!(key in left) || !(key in right)) {
      out.push(childPath);
      continue;
    }
    collectPolicyDiffs(left[key], right[key], childPath, out, maxEntries);
  }
}

function canonicalizeForHash(value: unknown, keyPath: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeForHash(item, keyPath));
  }
  if (!isRecord(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const childPath = keyPath ? `${keyPath}.${key}` : key;
    if (CONFIG_HASH_OMIT_PATHS.has(childPath)) {
      continue;
    }
    out[key] = canonicalizeForHash(value[key], childPath);
  }
  return out;
}
