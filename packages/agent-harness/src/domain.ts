import { z } from "zod";

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
  status: z.enum(["fog", "asked", "parked", "resolved"]).default("fog"),
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
  "{summary:string,restatement:string,goal:string,users:[string],inScope:[string],outOfScope:[string],assumptions:[string],unknowns:[string]}";

export const ReflectOutputSchema = z.object({
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
  startedAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().optional(),
});
export type GrillEpisode = z.infer<typeof GrillEpisodeSchema>;

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

export const BuildTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  // Planned paths let the harness apply file-scoped guidance before a worker
  // has made its first edit. Defaults preserve old task artifacts.
  affectedPaths: z.array(z.string().min(1)).default([]),
  blockedBy: z.array(z.string()).default([]),
  tdd: z.boolean(),
  testCommand: z.string().optional(),
  status: z.enum(["pending", "active", "done", "failed"]),
  step: z.enum([
    "pending",
    "writing_tests",
    "red",
    "implementing",
    "verifying",
    "reviewing",
    "committing",
    "done",
    "failed",
  ]),
  attempts: z.object({
    tests: z.number().int().nonnegative(),
    implementation: z.number().int().nonnegative(),
    review: z.number().int().nonnegative(),
  }),
  evidence: z.array(CommandEvidenceSchema).default([]),
  // Test files written by the test-writer; implementer edits to these are blocked.
  testPaths: z.array(z.string()).default([]),
  changedFiles: z.array(z.string()).default([]),
  reviewSummary: z.string().optional(),
  commitSha: z.string().optional(),
  failure: z.string().optional(),
});
export type BuildTask = z.infer<typeof BuildTaskSchema>;

export const RunPhaseSchema = z.enum([
  "new",
  "reflecting",
  "awaiting_input",
  "grilling",
  "planning",
  "executing",
  "publishing",
  "completed",
  "blocked",
  "cancelled",
]);
export type RunPhase = z.infer<typeof RunPhaseSchema>;

export const RunStateSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  runId: z.string().min(1),
  configurationHash: z.string().min(1),
  // Bumped on frozen-config shape migrations; older runs resume via their snapshot.
  configVersion: z.number().int().nonnegative().default(0),
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
  activeQuestionId: z.string().optional(),
  branchName: z.string().optional(),
  pullRequestUrl: z.string().optional(),
  failure: z.string().optional(),
  blockedFrom: RunPhaseSchema.optional(),
  grillEpisode: GrillEpisodeSchema.optional(),
  // Distinguishes a yielded run from one paused on human input.
  yieldedAt: z.string().optional(),
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
  "planner",
  "prompt-builder",
  "test-writer",
  "implementer",
  "reviewer",
  "message-writer",
]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const GRILL_EXPECTED_OUTPUT =
  "either {status:'needs_input',summary:string,questions:[{prompt,context,options:[{id,label,description}] (2-4),recommendedOptionId,recommendation,unknownId?}] (1-N, N is a ceiling not a target; only mutually independent questions may share a turn),openUnknowns:[{id,title,whyItMatters,impact:'blocking'|'shaping'|'minor'}]} or {status:'ready_to_plan',summary:string,resolutions:[{id,question,answer,summary}],openUnknowns:[{id,title,whyItMatters,impact}]}";

export const GrillOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("needs_input"),
    summary: z.string().min(1),
    questions: z.array(HumanQuestionDraftSchema).min(1).max(6),
    openUnknowns: z.array(OpenUnknownDraftSchema).default([]),
  }),
  z.object({
    status: z.literal("ready_to_plan"),
    summary: z.string().min(1),
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

export const PlannerOutputSchema = z.object({
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
        tdd: z.boolean().optional(),
        testCommand: z.string().optional(),
      }),
    )
    .min(1),
});
export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

export const PromptBuilderOutputSchema = z.object({
  prompt: z.string().min(1),
});

export const WorkerOutputSchema = z.object({
  summary: z.string().min(1),
  changedFiles: z.array(z.string()),
});
export type WorkerOutput = z.infer<typeof WorkerOutputSchema>;

export const ReviewOutputSchema = z.object({
  approved: z.boolean(),
  summary: z.string().min(1),
  findings: z
    .array(
      z.object({
        severity: z.enum(["blocking", "advisory"]),
        message: z.string().min(1),
      }),
    ),
});
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

export const MessageOutputSchema = z.object({
  subject: z.string().min(1).max(100),
  body: z.string(),
});
export type MessageOutput = z.infer<typeof MessageOutputSchema>;

export type WorkPacket = {
  contractVersion: typeof CONTRACT_VERSION;
  invocationId: string;
  runId: string;
  role: AgentRole;
  objective: string;
  constraints: string[];
  input: unknown;
  guidance: Array<{
    source: string;
    title: string;
    kind: "rule" | "skill";
    excerpt: string;
    reason: string;
    score: number;
  }>;
  context: Array<{ source: string; title: string; excerpt: string }>;
  priorArtifacts: string[];
  expectedOutput: string;
  createdAt: string;
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
