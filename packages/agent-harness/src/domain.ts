import { z } from "zod";
import type { DomainArtifacts } from "./domain/domain-artifacts.js";
import { WorkspaceEvidenceSchema } from "./domain/workspace.js";


export const CONTRACT_VERSION = "2" as const;

export const QuestionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
});
export type QuestionOption = z.infer<typeof QuestionOptionSchema>;

export const HumanQuestionDraftSchema = z
  .object({
    prompt: z.string().min(1),
    context: z.string().min(1),
    options: z.array(QuestionOptionSchema).min(2).max(4),
    recommendedOptionId: z.string().min(1),
    recommendation: z.string().min(1),
    unknownId: z.string().optional(),
  })
  .superRefine((question, context) => {
    const optionIds = question.options.map((option) => option.id);
    if (new Set(optionIds).size !== optionIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "Question option ids must be unique",
      });
    }
    if (!optionIds.includes(question.recommendedOptionId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recommendedOptionId"],
        message: "The recommended option must reference one of the question options",
      });
    }
  });
export type HumanQuestionDraft = z.infer<typeof HumanQuestionDraftSchema>;

export const QuestionPurposeSchema = z.enum(["reflect", "grill"]);
export type QuestionPurpose = z.infer<typeof QuestionPurposeSchema>;

export const QuestionSchema = z.object({
  id: z.string().min(1),
  purpose: QuestionPurposeSchema.default("grill"),
  prompt: z.string().min(1),
  // Defaults keep run files created before rich HITL questions readable.
  context: z.string().default(""),
  options: z.array(QuestionOptionSchema).default([]),
  recommendedOptionId: z.string().optional(),
  recommendation: z.string().optional(),
  // Prefill for editable confirmations (reflect brief).
  draftAnswer: z.string().optional(),
  // Shared id for every question asked in the same griller turn.
  batchId: z.string().optional(),
  unknownId: z.string().optional(),
  answerOptionId: z.string().optional(),
  status: z.enum(["open", "answered", "parked"]),
  answer: z.string().optional(),
  askedAt: z.string(),
  answeredAt: z.string().optional(),
});
export type Question = z.infer<typeof QuestionSchema>;

// The register of things still unknown to the interview.
export const OpenUnknownSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  whyItMatters: z.string().default(""),
  impact: z.enum(["blocking", "shaping", "minor"]).default("shaping"),
  status: z.enum(["fog", "asked", "parked", "resolved", "dropped"]).default("fog"),
});
export type OpenUnknown = z.infer<typeof OpenUnknownSchema>;

// The griller's per-turn draft of the register; the engine owns `status`.
export const OpenUnknownDraftSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  whyItMatters: z.string().default(""),
  impact: z.enum(["blocking", "shaping", "minor"]).default("shaping"),
});
export type OpenUnknownDraft = z.infer<typeof OpenUnknownDraftSchema>;

export const OperatorNoteSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  // Set only when the note also seeded a new fog entry.
  title: z.string().optional(),
  at: z.string(),
  consumedAt: z.string().optional(),
});
export type OperatorNote = z.infer<typeof OperatorNoteSchema>;

export const REFLECT_EXPECTED_OUTPUT =
  "{proposedTitle:string,summary:string,restatement:string,goal:string,users:[string],inScope:[string],outOfScope:[string],assumptions:[string],unknowns:[string]}";

export const ReflectOutputSchema = z.object({
  proposedTitle: z.string().min(1).optional(),
  summary: z.string().min(1),
  restatement: z.string().min(1),
  goal: z.string().min(1),
  users: z.array(z.string()),
  inScope: z.array(z.string()),
  outOfScope: z.array(z.string()),
  assumptions: z.array(z.string()),
  unknowns: z.array(z.string()),
});
export type ReflectOutput = z.infer<typeof ReflectOutputSchema>;

export const ReflectBriefSchema = z.object({
  draft: z.string().min(1),
  // The flat draft/confirmed strings stay authoritative for the griller.
  structured: ReflectOutputSchema.optional(),
  confirmed: z.string().optional(),
  confirmedStructured: ReflectOutputSchema.optional(),
  confirmedAt: z.string().optional(),
});
export type ReflectBrief = z.infer<typeof ReflectBriefSchema>;

export const GrillResolutionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  answer: z.string().min(1),
  summary: z.string().min(1),
  resolvedAt: z.string(),
});
export type GrillResolution = z.infer<typeof GrillResolutionSchema>;

export const GrillEpisodeSchema = z.object({
  number: z.number().int().positive(),
  providerSessionId: z.string().min(1).optional(),
  questionsAnswered: z.number().int().nonnegative(),
  // Hash of selected guidance sources so continuations can skip unchanged blocks.
  guidanceFingerprint: z.string().optional(),
  // Batch awaiting a human response; used to send exactly one warm-turn delta.
  pendingBatchId: z.string().min(1).optional(),
  startedAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().optional(),
});
export type GrillEpisode = z.infer<typeof GrillEpisodeSchema>;

/** Operator gate after the griller returns ready_to_plan; absent when not pending. */
export const GrillReadyGateSchema = z.object({
  summary: z.string().min(1),
  readyAt: z.string(),
});
export type GrillReadyGate = z.infer<typeof GrillReadyGateSchema>;

/** Retained planner provider session for high-level plan → to-prd continuation. */
export const PlannerEpisodeSchema = z.object({
  number: z.number().int().positive(),
  providerSessionId: z.string().min(1).optional(),
  guidanceFingerprint: z.string().optional(),
  startedAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().optional(),
});
export type PlannerEpisode = z.infer<typeof PlannerEpisodeSchema>;

/** Operator gate after the planner returns a high-level plan; absent when not pending. */
export const PlanReadyGateSchema = z.object({
  summary: z.string().min(1),
  readyAt: z.string(),
});
export type PlanReadyGate = z.infer<typeof PlanReadyGateSchema>;

export const TestScenarioSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum(["happy-path", "error-path"]),
  intent: z.string().min(1),
  given: z.string().min(1),
  when: z.string().min(1),
  then: z.string().min(1),
  taskIds: z.array(z.string()).default([]),
  status: z.enum(["pending", "active", "passing", "failed"]).default("pending"),
  attempts: z.number().int().nonnegative().default(0),
  writerAttempts: z.number().int().nonnegative().default(0),
  repairAttempts: z.number().int().nonnegative().default(0),
  testPaths: z.array(z.string()).default([]),
  evidenceFingerprint: z.string().optional(),
  seenEvidenceFingerprints: z.array(z.string()).default([]),
  seenRepairEdges: z.array(z.string()).default([]),
  /** Findings handed back from final_review for scenario-intent repairs. */
  reviewFindings: z.array(z.string()).default([]),
});
export type TestScenario = z.infer<typeof TestScenarioSchema>;

/** High-level plan the operator reviews before PRD + issue slicing. */
export const HighLevelPlanSchema = z.object({
  summary: z.string().min(1),
  problemStatement: z.string().min(1),
  solution: z.string().min(1),
  approach: z.string().min(1),
  constraints: z.array(z.string()).default([]),
  outOfScope: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
});
export type HighLevelPlan = z.infer<typeof HighLevelPlanSchema>;

/** Local PRD authored from the retained planner session after plan approval. */
export const PrdSchema = z.object({
  summary: z.string().min(1),
  problemStatement: z.string().min(1),
  solution: z.string().min(1),
  userStories: z.array(z.string().min(1)).min(1),
  implementationDecisions: z.array(z.string().min(1)).default([]),
  testingDecisions: z.array(z.string().min(1)).default([]),
  outOfScope: z.array(z.string()).default([]),
  furtherNotes: z.string().default(""),
});
export type Prd = z.infer<typeof PrdSchema>;

/** Verification-only settings patch. */
const VerificationCommandSettingSchema = z.object({
  id: z.string().min(1),
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().default(10 * 60 * 1000),
});

export const VerificationSettingsPatchSchema = z
  .object({
    workflow: z
      .object({
        testPathPatterns: z.array(z.string().min(1)).max(500).optional(),
      })
      .strict()
      .optional(),
    commands: z
      .object({
        verification: z.array(VerificationCommandSettingSchema).min(1).optional(),
        testTargetTemplate: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type VerificationSettingsPatch = z.infer<typeof VerificationSettingsPatchSchema>;

export const VerificationSettingsSnapshotSchema = z.object({
  workflow: z.object({
    testPathPatterns: z.array(z.string().min(1)),
  }),
  commands: z.object({
    verification: z.array(VerificationCommandSettingSchema).min(1),
    testTargetTemplate: z.string().min(1).optional(),
  }),
});
export type VerificationSettingsSnapshot = z.infer<typeof VerificationSettingsSnapshotSchema>;

export const VerificationEvidenceSchema = z.object({
  manifests: z.array(
    z.object({
      path: z.string().min(1),
      present: z.boolean(),
      excerpt: z.string().optional(),
    }),
  ),
  sampleTestPaths: z.array(z.string().min(1)).default([]),
  currentSettings: VerificationSettingsSnapshotSchema,
  host: z.object({
    platform: z.string().min(1), // Node process.platform
    isWindows: z.boolean(),
  }),
});
export type VerificationEvidence = z.infer<typeof VerificationEvidenceSchema>;

/** Operator gate after project-profiler proposes verification settings; absent when not pending. */
export const VerificationReadyGateSchema = z.object({
  summary: z.string().min(1),
  proposedPatch: VerificationSettingsPatchSchema,
  currentSettings: VerificationSettingsSnapshotSchema,
  evidence: VerificationEvidenceSchema.optional(),
  readyAt: z.string(),
});
export type VerificationReadyGate = z.infer<typeof VerificationReadyGateSchema>;

export const ProjectProfilerOutputSchema = z.object({
  summary: z.string().min(1),
  configPatch: VerificationSettingsPatchSchema,
});
export type ProjectProfilerOutput = z.infer<typeof ProjectProfilerOutputSchema>;

/** Example shape for project-profiler; must stay valid against ProjectProfilerOutputSchema (no commands.test). */
export const PROJECT_PROFILER_EXPECTED_OUTPUT =
  '{"summary":"concise explanation","configPatch":{"workflow":{"testPathPatterns":[]},"commands":{"verification":[{"id":"test","command":"…","timeoutMs":600000}],"testTargetTemplate":"… {filter}"}}}';

export const CommandEvidenceSchema = z.object({
  purpose: z.string(),
  command: z.string(),
  exitCode: z.number().int(),
  passed: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().nonnegative(),
  at: z.string(),
});
export type CommandEvidence = z.infer<typeof CommandEvidenceSchema>;

/** Operator gate when the pre-planner verification baseline fails; absent when not pending. */
export const VerificationBaselineReadyGateSchema = z.object({
  summary: z.string().min(1),
  evidence: CommandEvidenceSchema,
  readyAt: z.string(),
});
export type VerificationBaselineReadyGate = z.infer<typeof VerificationBaselineReadyGateSchema>;

export const PackageManagerSchema = z.enum([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "pip",
  "uv",
  "cargo",
]);
export type PackageManager = z.infer<typeof PackageManagerSchema>;

export const ProposedInstallSchema = z.object({
  id: z.string().min(1),
  manager: PackageManagerSchema,
  packages: z.array(z.string().min(1)).min(1),
  reason: z.string().min(1),
  // Optional hint from the planner; the harness rebuilds the allowlisted command.
  command: z.string().optional(),
  decision: z.enum(["accepted", "denied"]).optional(),
  decidedAt: z.string().optional(),
  evidence: CommandEvidenceSchema.optional(),
});
export type ProposedInstall = z.infer<typeof ProposedInstallSchema>;

export const InstallLogEntrySchema = z.object({
  at: z.string(),
  role: z.string().min(1),
  taskId: z.string().optional(),
  manager: PackageManagerSchema,
  commandSummary: z.string().min(1),
  packages: z.array(z.string()).default([]),
  source: z.enum(["agent", "harness"]).default("agent"),
});
export type InstallLogEntry = z.infer<typeof InstallLogEntrySchema>;

/**
 * Active task steps for the intent-first workflow.
 */
export const ActiveTaskStepSchema = z.enum([
  "pending",
  "implementing",
  "verifying",
  "reviewing",
  "committing",
  "done",
  "failed",
]);
export const TaskStepSchema = ActiveTaskStepSchema;
export type TaskStep = z.infer<typeof TaskStepSchema>;

export const BuildTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  // Planned paths let the harness apply file-scoped guidance before a worker
  // has made its first edit. Defaults preserve old task artifacts.
  affectedPaths: z.array(z.string().min(1)).default([]),
  blockedBy: z.array(z.string()).default([]),
  status: z.enum(["pending", "active", "done", "failed"]),
  step: TaskStepSchema,
  attempts: z.object({
    implementation: z.number().int().nonnegative(),
    review: z.number().int().nonnegative(),
  }),
  evidence: z.array(CommandEvidenceSchema).default([]),
  // Scenario / unit test paths recorded after writing phases (not during executing).
  testPaths: z.array(z.string()).default([]),
  changedFiles: z.array(z.string()).default([]),
  reviewSummary: z.string().optional(),
  /** Retained provider context so verification and task-review repairs return to the implementer. */
  implementerSession: z
    .object({
      providerSessionId: z.string().min(1),
    })
    .optional(),
  commitSha: z.string().optional(),
  failure: z.string().optional(),
  // Last failed-transition fingerprint; identical evidence blocks another model call.
  evidenceFingerprint: z.string().optional(),
  seenEvidenceFingerprints: z.array(z.string()).default([]),
  // Role-transition edges already taken for a fingerprint (prevents ping-pong).
  seenRepairEdges: z.array(z.string()).default([]),
  // Scenario ids this task is tagged to cover (populated by the issue-slicer).
  scenarioIds: z.array(z.string()).default([]),
});
export type BuildTask = z.infer<typeof BuildTaskSchema>;

/** Defaults for newly introduced task-tracking fields (safe for manual test fixtures). */
export const BUILD_TASK_TRACKING_DEFAULTS = {
  seenEvidenceFingerprints: [] as string[],
  seenRepairEdges: [] as string[],
  scenarioIds: [] as string[],
};

export const RunPhaseSchema = z.enum([
  "new",
  "reflecting",
  "awaiting_input",
  "grilling",
  "planning",
  "executing",
  "scenario_testing",
  "crystallizing",
  "final_review",
  "publishing",
  "completed",
  "blocked",
  "cancelled",
]);
export type RunPhase = z.infer<typeof RunPhaseSchema>;

export const FixerPlanSchema = z.object({
  summary: z.string().min(1),
  steps: z.array(z.object({ title: z.string().min(1), description: z.string().min(1) })).min(1),
  risks: z.array(z.string().min(1)).default([]),
  // An approved recovery plan is also an execution boundary. Defaults preserve
  // readability of old run state; old unscoped plans must be regenerated before apply.
  allowedPaths: z.array(z.string().min(1)).default([]),
  validationCommands: z.array(z.string().min(1)).default([]),
});
export type FixerPlan = z.infer<typeof FixerPlanSchema>;

/** Small settings-only recovery plan; approval applies its validated recommendation. */
export const ConfigFixerPlanSchema = z.object({
  summary: z.string().min(1),
  // Validated against ProjectSettingsPatchSchema at the recovery boundary.
  configPatch: z.record(z.unknown()),
});
export type ConfigFixerPlan = z.infer<typeof ConfigFixerPlanSchema>;

const FixerRecoveryBaseSchema = {
  guidance: z.string().min(1),
  failure: z.string().min(1),
  status: z.enum(["proposed", "applied"]),
  proposedAt: z.string(),
  appliedAt: z.string().optional(),
  result: z.string().optional(),
  changedFiles: z.array(z.string()).default([]),
  /** Retained file-fixer provider context for approve-without-revise apply. */
  providerSessionId: z.string().min(1).optional(),
};

export const FixerRecoverySchema = z.preprocess(
  (raw) => {
    if (raw && typeof raw === "object" && !Array.isArray(raw) && !("role" in raw)) {
      return { ...(raw as Record<string, unknown>), role: "fixer" };
    }
    return raw;
  },
  z.discriminatedUnion("role", [
    z.object({
      role: z.literal("fixer"),
      plan: FixerPlanSchema,
      ...FixerRecoveryBaseSchema,
    }),
    z.object({
      role: z.literal("config-fixer"),
      plan: ConfigFixerPlanSchema,
      ...FixerRecoveryBaseSchema,
    }),
  ]),
);
export type FixerRecovery = z.infer<typeof FixerRecoverySchema>;

export const RunStateSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  runId: z.string().min(1),
  configurationHash: z.string().min(1),
  // Bumped on frozen-config shape migrations; older runs resume via their snapshot.
  configVersion: z.number().int().nonnegative().default(0),
  // Monotonic revision of the frozen run policy; used for optimistic config updates.
  configRevision: z.number().int().nonnegative().default(0),
  idea: z.string().min(1),
  phase: RunPhaseSchema,
  reflectBrief: ReflectBriefSchema.optional(),
  grillResolutions: z.array(GrillResolutionSchema).default([]),
  questions: z.array(QuestionSchema).default([]),
  // Never deleted, only transitioned, so the UI can show a stable history.
  openUnknowns: z.array(OpenUnknownSchema).default([]),
  // Unprompted human input the griller has not yet consumed.
  operatorNotes: z.array(OperatorNoteSchema).default([]),
  tasks: z.array(BuildTaskSchema).default([]),
  // Issue-slicer-proposed dependency installs gated before executing.
  proposedInstalls: z.array(ProposedInstallSchema).default([]),
  // High-level plan (operator-edited copy is what to-prd consumes).
  plan: HighLevelPlanSchema.optional(),
  // Local PRD authored after plan approval (synced to prd.md).
  prd: PrdSchema.optional(),
  // Intent scenarios authored after the PRD; approved with the plan gate.
  scenarios: z.array(TestScenarioSchema).default([]),
  // Coverage measurement from the crystallizing phase (optional).
  coverage: z
    .object({
      percentage: z.number().min(0).max(1),
      scope: z.enum(["changed", "all"]),
      fallback: z.boolean().default(false),
      measuredAt: z.string(),
      attempts: z.number().int().nonnegative().default(0),
    })
    .optional(),
  // Holistic final-review attempt counter (separate from per-task budgets).
  finalReviewAttempts: z.number().int().nonnegative().default(0),
  // Feedback that reopens planning; consumed on the next planner invoke.
  planFeedback: z.string().optional(),
  activeQuestionId: z.string().optional(),
  branchName: z.string().optional(),
  pullRequestUrl: z.string().optional(),
  failure: z.string().optional(),
  blockedFrom: RunPhaseSchema.optional(),
  // Structured failure classification (absent on runs blocked before Task 7).
  blockedKind: z.string().optional(),
  blockedRetriable: z.boolean().optional(),
  fixerRecovery: FixerRecoverySchema.optional(),
  // Last known working-tree fingerprint; divergence blocks advance.
  // Legacy runs may hold an opaque sha256; new stamps use evidence.fingerprint (`vN:…`).
  treeFingerprint: z.string().optional(),
  // Structured run-local workspace evidence (preferred over scalar treeFingerprint).
  workspaceEvidence: WorkspaceEvidenceSchema.optional(),
  grillEpisode: GrillEpisodeSchema.optional(),
  // Set when grilling finished; cleared by confirmGrill (continue or reopen).
  grillReady: GrillReadyGateSchema.optional(),
  plannerEpisode: PlannerEpisodeSchema.optional(),
  // Set when the planner finished a high-level plan; cleared by confirmPlan.
  planReady: PlanReadyGateSchema.optional(),
  // Set when the operator approves the bundled plan/PRD/scenarios gate; cleared on feedback.
  planConfirmedAt: z.string().optional(),
  // Set when project-profiler proposes verification settings; cleared on confirm.
  verificationReady: VerificationReadyGateSchema.optional(),
  // Set once the operator confirms verification; skips re-proposal on resume.
  verificationConfirmedAt: z.string().optional(),
  // Set when the pre-planner verification baseline fails; cleared on retry/pass.
  verificationBaselineReady: VerificationBaselineReadyGateSchema.optional(),
  // Set once the baseline test run is acceptable; skips re-run on resume.
  verificationBaselinePassedAt: z.string().optional(),
  // Finish the active task, then halt before starting the next frontier task.
  stopAfterTask: z.boolean().optional(),
  stoppedAfterTaskAt: z.string().optional(),
  // Recomputed from sessions/*.json after budget-consuming steps (not incremented).
  usage: z
    .object({
      inputTokens: z.number().nonnegative().default(0),
      outputTokens: z.number().nonnegative().default(0),
      cacheReadTokens: z.number().nonnegative().default(0),
      cacheWriteTokens: z.number().nonnegative().default(0),
      totalTokens: z.number().nonnegative().default(0),
      costUsd: z.number().nonnegative().default(0),
      // True when any session used a model missing from models.pricing.
      costIsLowerBound: z.boolean().default(false),
      invocations: z.number().int().nonnegative().default(0),
      sessionsRead: z.number().int().nonnegative().default(0),
    })
    .default({}),
  revision: z.number().int().nonnegative(),
  lastEventSequence: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RunState = z.infer<typeof RunStateSchema>;

export const RunEventSchema = z.object({
  sequence: z.number().int().positive(),
  type: z.string().min(1),
  at: z.string(),
  detail: z.record(z.unknown()).default({}),
});
export type RunEvent = z.infer<typeof RunEventSchema>;

export const AgentRoleSchema = z.enum([
  "reflector",
  "griller",
  "docs-writer",
  "planner",
  "scenario-planner",
  "issue-slicer",
  "prompt-builder",
  "scenario-writer",
  "unit-test-writer",
  "implementer",
  "reviewer",
  "task-reviewer",
  "message-writer",
  "fixer",
  "config-fixer",
  "project-profiler",
  "run-analysis-prompt-writer",
]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const GRILL_EXPECTED_OUTPUT =
  "either {status:'needs_input',summary:string,resolutionSummaries:[{questionId,summary}] (one per answered questionId this turn; omit or [] when none),questions:[{prompt,context,options:[{id,label,description}] (2-4),recommendedOptionId,recommendation,unknownId?}] (1-N, N is a ceiling not a target; only mutually independent questions may share a turn),openUnknowns:[{id,title,whyItMatters,impact:'blocking'|'shaping'|'minor'}]} or {status:'ready_to_plan',summary:string,resolutionSummaries:[{questionId,summary}] (one per answered questionId this turn; omit or [] when none),resolutions:[{id,question,answer,summary}],openUnknowns:[{id,title,whyItMatters,impact}]}";

const GrillResolutionSummarySchema = z.object({
  questionId: z.string().min(1),
  summary: z.string().min(1),
});

export const GrillOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("needs_input"),
    summary: z.string().min(1),
    resolutionSummaries: z.array(GrillResolutionSummarySchema).default([]),
    questions: z.array(HumanQuestionDraftSchema).min(1).max(6),
    openUnknowns: z.array(OpenUnknownDraftSchema).default([]),
  }),
  z.object({
    status: z.literal("ready_to_plan"),
    summary: z.string().min(1),
    resolutionSummaries: z.array(GrillResolutionSummarySchema).default([]),
    resolutions: z.array(
      z.object({
        id: z.string().min(1),
        question: z.string().min(1),
        answer: z.string().min(1),
        summary: z.string().min(1),
      }),
    ),
    openUnknowns: z.array(OpenUnknownDraftSchema).default([]),
  }),
]);
export type GrillOutput = z.infer<typeof GrillOutputSchema>;

export const PLANNER_EXPECTED_OUTPUT =
  "{summary,problemStatement,solution,approach,constraints?,outOfScope?,openQuestions?}";

export const PRD_EXPECTED_OUTPUT =
  "{summary:string,problemStatement:string,solution:string,userStories:[string],implementationDecisions:[string]?,testingDecisions:[string]?,outOfScope:[string]?,furtherNotes:string?}";

export const ScenarioPlannerOutputSchema = z.object({
  summary: z.string().min(1),
  scenarios: z
    .array(
      z.object({
        id: z.string().min(1),
        title: z.string().min(1),
        kind: z.enum(["happy-path", "error-path"]),
        intent: z.string().min(1),
        given: z.string().min(1),
        when: z.string().min(1),
        then: z.string().min(1),
      }),
    )
    .min(1),
});
export type ScenarioPlannerOutput = z.infer<typeof ScenarioPlannerOutputSchema>;

export const SCENARIO_PLANNER_EXPECTED_OUTPUT =
  "{summary,scenarios:[{id,title,kind:'happy-path'|'error-path',intent,given,when,then}]}";

/** Fresh issue-slicer output: executable BuildTasks (+ optional installs). */
export const IssueSlicerOutputSchema = z.object({
  summary: z.string().min(1),
  tasks: z
    .array(
      z.object({
        id: z.string().min(1),
        title: z.string().min(1),
        description: z.string().min(1),
        acceptanceCriteria: z.array(z.string().min(1)).min(1),
        affectedPaths: z.array(z.string().min(1)).default([]),
        blockedBy: z.array(z.string()),
        scenarioIds: z.array(z.string().min(1)).default([]),
      }),
    )
    .min(1),
  // Packages the operator should approve before implementation starts.
  proposedInstalls: z
    .array(
      z.object({
        id: z.string().min(1),
        manager: PackageManagerSchema,
        packages: z.array(z.string().min(1)).min(1),
        reason: z.string().min(1),
        command: z.string().optional(),
      }),
    )
    .default([]),
});
export type IssueSlicerOutput = z.infer<typeof IssueSlicerOutputSchema>;

export const ISSUE_SLICER_EXPECTED_OUTPUT =
  "{summary,tasks:[{id,title,description,acceptanceCriteria,affectedPaths?,blockedBy,scenarioIds?}],proposedInstalls?:[{id,manager,packages,reason,command?}]}";

export const PromptBuilderOutputSchema = z.object({
  prompt: z.string().min(1),
});

export const WorkerOutputSchema = z.object({
  summary: z.string().min(1),
  changedFiles: z.array(z.string()),
});
export type WorkerOutput = z.infer<typeof WorkerOutputSchema>;

export const ReviewFindingKindSchema = z.enum([
  "production",
  "test-coverage",
  "test-design",
  "scenario-intent",
  "advisory",
]);
export type ReviewFindingKind = z.infer<typeof ReviewFindingKindSchema>;

export const ReviewOutputSchema = z.object({
  approved: z.boolean(),
  summary: z.string().min(1),
  findings: z
    .array(
      z.object({
        severity: z.enum(["blocking", "advisory"]),
        kind: ReviewFindingKindSchema,
        message: z.string().min(1),
        taskIds: z.array(z.string().min(1)).default([]),
      }),
    ),
});
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

export const REVIEW_EXPECTED_OUTPUT =
  "{approved,summary,findings:[{severity:'blocking'|'advisory',kind:'production'|'test-coverage'|'test-design'|'scenario-intent'|'advisory',message,taskIds?:[string]}]}";

export const ScenarioWriterOutputSchema = z.object({
  status: z.literal("implemented"),
  summary: z.string().min(1),
  scenarios: z
    .array(
      z.object({
        scenarioId: z.string().min(1),
        testPaths: z.array(z.string().min(1)).min(1),
      }),
    )
    .default([]),
  /** Legacy single-scenario shape retained for old scripted backends and run fixtures. */
  testPaths: z.array(z.string().min(1)).default([]),
  changedFiles: z.array(z.string()).default([]),
}).superRefine((output, ctx) => {
  if (output.scenarios.length === 0 && output.testPaths.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "scenario-writer must return scenarios or testPaths",
    });
  }
});
export type ScenarioWriterOutput = z.infer<typeof ScenarioWriterOutputSchema>;

export const SCENARIO_WRITER_EXPECTED_OUTPUT =
  "{status:'implemented',summary,scenarios:[{scenarioId,testPaths:[string] (min 1)}] (one per requested scenario),changedFiles?:[string]}";

export const UnitTestWriterOutputSchema = z.object({
  status: z.literal("implemented"),
  summary: z.string().min(1),
  testPaths: z.array(z.string().min(1)).min(1),
  changedFiles: z.array(z.string()).default([]),
});
export type UnitTestWriterOutput = z.infer<typeof UnitTestWriterOutputSchema>;

export const UNIT_TEST_WRITER_EXPECTED_OUTPUT =
  "{status:'implemented',summary,testPaths:[string] (min 1),changedFiles?:[string]}";

export const MessageOutputSchema = z.object({
  subject: z.string().min(1).max(100),
  body: z.string(),
});
export type MessageOutput = z.infer<typeof MessageOutputSchema>;

export const RunAnalysisPromptOutputSchema = z.object({
  summary: z.string().min(1),
  prompt: z.string().min(1),
});
export type RunAnalysisPromptOutput = z.infer<typeof RunAnalysisPromptOutputSchema>;

export type WorkPacket = {
  contractVersion: typeof CONTRACT_VERSION;
  invocationId: string;
  runId: string;
  role: AgentRole;
  objective: string;
  constraints: string[];
  input: unknown;
  /** Slim source refs for audit/fingerprint; model text is `guidancePack`. */
  guidance: Array<{
    source: string;
    title: string;
    kind: "rule" | "skill";
  }>;
  /** Compiled assigned rules/skills body (no selection headers or frontmatter). */
  guidancePack: string;
  context: Array<{ source: string; title: string; excerpt: string }>;
  priorArtifacts: string[];
  expectedOutput: string;
  createdAt: string;
  /** Present when the role's guidance assignment includes domain-modeling. */
  domainArtifacts?: DomainArtifacts;
};

export function formatReflectRestatement(output: ReflectOutput): string {
  const section = (title: string, lines: string[]): string =>
    lines.length ? `## ${title}\n\n${lines.map((line) => `- ${line}`).join("\n")}` : `## ${title}\n\n_None._`;
  return [
    output.restatement.trim(),
    "",
    `## Goal\n\n${output.goal.trim()}`,
    "",
    section("Users", output.users),
    "",
    section("In scope", output.inScope),
    "",
    section("Out of scope", output.outOfScope),
    "",
    section("Assumptions", output.assumptions),
    "",
    section("Unknowns", output.unknowns),
  ].join("\n");
}

/** Uses stable ids so re-parsing the same reflector output does not churn entries. */
export function seedUnknownsFromReflect(unknowns: string[]): OpenUnknown[] {
  return unknowns
    .map((title) => title.trim())
    .filter((title) => title.length > 0)
    .map((title, index) => ({
      id: `unknown-seed-${index + 1}-${slugify(title)}`,
      title,
      whyItMatters: "",
      impact: "shaping" as const,
      status: "fog" as const,
    }));
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "item"
  );
}

export function createRunState(
  runId: string,
  idea: string,
  now: string,
  configurationHash: string = "unconfigured",
  configVersion: number = 0,
): RunState {
  return RunStateSchema.parse({
    contractVersion: CONTRACT_VERSION,
    runId,
    configurationHash,
    configVersion,
    idea: idea.trim(),
    phase: "new",
    grillResolutions: [],
    questions: [],
    tasks: [],
    revision: 0,
    lastEventSequence: 0,
    createdAt: now,
    updatedAt: now,
  });
}

export * from "./domain/domain-artifacts.js";
export * from "./domain/policies.js";
export * from "./domain/transitions.js";
export * from "./domain/run-execution.js";
export * from "./domain/workspace.js";
export * from "./domain/workspace-cleanup.js";

