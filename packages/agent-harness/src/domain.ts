import { z } from "zod";

export const CONTRACT_VERSION = "2" as const;

export const DecisionKindSchema = z.enum([
  "research",
  "prototype",
  "grilling",
]);
export type DecisionKind = z.infer<typeof DecisionKindSchema>;

export const InteractionSchema = z.enum(["AFK", "HITL"]);
export type Interaction = z.infer<typeof InteractionSchema>;

/** Compact sketch of ProposedDecisionSchema for worker expectedOutput prompts. */
export function proposedTicketOutputSketch(): string {
  const kinds = DecisionKindSchema.options.map((kind) => `'${kind}'`).join("|");
  return [
    `AFK {id,title,question:string,kind:${kinds},interaction:'AFK',blockedBy:[string]}`,
    "or",
    `HITL {id,title,question:{prompt,context,options:[{id,label,description}] (2-4),recommendedOptionId,recommendation},kind:${kinds},interaction:'HITL',blockedBy:[string]}`,
  ].join(" ");
}

export const NAVIGATOR_EXPECTED_OUTPUT =
  `{summary:string,destination:string,notes:[string],tickets:[${proposedTicketOutputSketch()}],fog:[string],outOfScope:[string],readyToPlan:boolean}`;

export const DECISION_EXPECTED_OUTPUT =
  `either {status:'resolved',summary:string,resolution:string,newTickets:[${proposedTicketOutputSketch()}],newFog:[string],clearFog:[string],outOfScope:[string],routeClear:boolean} or {status:'needs_input',summary:string,question:{prompt,context,options:[{id,label,description}] (2-4),recommendedOptionId,recommendation}}`;

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

export const DecisionTicketSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  question: z.string().min(1),
  humanQuestion: HumanQuestionDraftSchema.optional(),
  kind: DecisionKindSchema,
  interaction: InteractionSchema,
  status: z.enum(["open", "claimed", "resolved", "out_of_scope"]),
  blockedBy: z.array(z.string()).default([]),
  claimedBy: z.string().optional(),
  resolution: z.string().optional(),
  resolutionSummary: z.string().optional(),
  conversation: z
    .array(
      z.object({
        speaker: z.enum(["human", "agent"]),
        text: z.string().min(1),
        at: z.string(),
      }),
    )
    .default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DecisionTicket = z.infer<typeof DecisionTicketSchema>;

export const WayfinderMapSchema = z.object({
  destination: z.string().min(1),
  notes: z.array(z.string()).default([]),
  decisionsSoFar: z
    .array(
      z.object({
        ticketId: z.string(),
        title: z.string(),
        gist: z.string(),
      }),
    )
    .default([]),
  notYetSpecified: z.array(z.string()).default([]),
  outOfScope: z.array(z.string()).default([]),
  readyToPlan: z.boolean().default(false),
});
export type WayfinderMap = z.infer<typeof WayfinderMapSchema>;

export const QuestionSchema = z.object({
  id: z.string().min(1),
  ticketId: z.string().optional(),
  prompt: z.string().min(1),
  // Defaults keep run files created before rich HITL questions readable.
  context: z.string().default(""),
  options: z.array(QuestionOptionSchema).default([]),
  recommendedOptionId: z.string().optional(),
  recommendation: z.string().optional(),
  status: z.enum(["open", "answered"]),
  answer: z.string().optional(),
  askedAt: z.string(),
  answeredAt: z.string().optional(),
});
export type Question = z.infer<typeof QuestionSchema>;

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
  changedFiles: z.array(z.string()).default([]),
  reviewSummary: z.string().optional(),
  commitSha: z.string().optional(),
  failure: z.string().optional(),
});
export type BuildTask = z.infer<typeof BuildTaskSchema>;

export const RunPhaseSchema = z.enum([
  "new",
  "navigating",
  "wayfinding",
  "awaiting_input",
  "planning",
  "executing",
  "publishing",
  "completed",
  "blocked",
  "cancelled",
]);
export type RunPhase = z.infer<typeof RunPhaseSchema>;

export const WayfindingEpisodeSchema = z.object({
  number: z.number().int().positive(),
  providerSessionId: z.string().min(1).optional(),
  turnCount: z.number().int().nonnegative(),
  startedAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().optional(),
});
export type WayfindingEpisode = z.infer<typeof WayfindingEpisodeSchema>;

export const RunStateSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  runId: z.string().min(1),
  configurationHash: z.string().min(1),
  idea: z.string().min(1),
  phase: RunPhaseSchema,
  map: WayfinderMapSchema.optional(),
  decisionTickets: z.array(DecisionTicketSchema).default([]),
  questions: z.array(QuestionSchema).default([]),
  tasks: z.array(BuildTaskSchema).default([]),
  activeQuestionId: z.string().optional(),
  branchName: z.string().optional(),
  pullRequestUrl: z.string().optional(),
  failure: z.string().optional(),
  blockedFrom: RunPhaseSchema.optional(),
  navigationPasses: z.number().int().nonnegative().default(0),
  // Optional so runs created before resumable wayfinding episodes remain readable.
  wayfindingEpisode: WayfindingEpisodeSchema.optional(),
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
  "navigator",
  "decision-researcher",
  "decision-prototyper",
  "decision-facilitator",
  "planner",
  "prompt-builder",
  "test-writer",
  "implementer",
  "reviewer",
  "message-writer",
]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

const ProposedDecisionFields = {
  id: z.string().min(1),
  title: z.string().min(1),
  kind: DecisionKindSchema,
  blockedBy: z.array(z.string()),
};

const ProposedDecisionSchema = z.discriminatedUnion("interaction", [
  z.object({
    ...ProposedDecisionFields,
    interaction: z.literal("AFK"),
    question: z.string().min(1),
  }),
  z.object({
    ...ProposedDecisionFields,
    interaction: z.literal("HITL"),
    question: HumanQuestionDraftSchema,
  }),
]);

export const NavigatorOutputSchema = z.object({
  summary: z.string().min(1),
  destination: z.string().min(1),
  notes: z.array(z.string()),
  tickets: z.array(ProposedDecisionSchema),
  fog: z.array(z.string()),
  outOfScope: z.array(z.string()),
  readyToPlan: z.boolean(),
});
export type NavigatorOutput = z.infer<typeof NavigatorOutputSchema>;

export const DecisionOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("resolved"),
    summary: z.string().min(1),
    resolution: z.string().min(1),
    newTickets: z.array(ProposedDecisionSchema),
    newFog: z.array(z.string()),
    clearFog: z.array(z.string()),
    outOfScope: z.array(z.string()),
    routeClear: z.boolean(),
  }),
  z.object({
    status: z.literal("needs_input"),
    summary: z.string().min(1),
    question: HumanQuestionDraftSchema,
  }),
]);
export type DecisionOutput = z.infer<typeof DecisionOutputSchema>;

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

export function createRunState(
  runId: string,
  idea: string,
  now: string,
  configurationHash: string = "unconfigured",
): RunState {
  return RunStateSchema.parse({
    contractVersion: CONTRACT_VERSION,
    runId,
    configurationHash,
    idea: idea.trim(),
    phase: "new",
    decisionTickets: [],
    questions: [],
    tasks: [],
    navigationPasses: 0,
    revision: 0,
    lastEventSequence: 0,
    createdAt: now,
    updatedAt: now,
  });
}
