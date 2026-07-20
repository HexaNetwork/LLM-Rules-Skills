import { z } from "zod";
import {
  BlockedReasonSchema,
  CONTRACT_VERSION,
  FindingSeveritySchema,
  RunStatusSchema,
  TaskStatusSchema,
} from "./common.js";

export const FindingSchema = z.object({
  id: z.string().min(1),
  severity: FindingSeveritySchema,
  criterionOrRule: z.string().min(1),
  location: z.string().min(1),
  evidence: z.string().min(1),
  remediation: z.string().min(1),
});
export type Finding = z.infer<typeof FindingSchema>;

export const CriterionEvidenceSchema = z.object({
  criterionId: z.string().min(1),
  satisfied: z.boolean(),
  evidence: z.string().min(1),
});
export type CriterionEvidence = z.infer<typeof CriterionEvidenceSchema>;

export const WorkerReportSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  taskId: z.string().min(1),
  summary: z.string().min(1),
  changedPaths: z.array(z.string()).default([]),
  testsAddedOrUpdated: z.array(z.string()).default([]),
  unresolvedRisks: z.array(z.string()).default([]),
  agentId: z.string().optional(),
  runId: z.string().optional(),
});
export type WorkerReport = z.infer<typeof WorkerReportSchema>;

export const VerifierReportSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  taskId: z.string().min(1),
  acceptance: z.array(CriterionEvidenceSchema),
  findings: z.array(FindingSchema).default([]),
  browserProbeResults: z
    .array(
      z.object({
        probeId: z.string().min(1),
        passed: z.boolean(),
        evidence: z.string().min(1),
      }),
    )
    .default([]),
  agentId: z.string().optional(),
  runId: z.string().optional(),
});
export type VerifierReport = z.infer<typeof VerifierReportSchema>;

export const CommandGateResultSchema = z.object({
  gateId: z.string().min(1),
  command: z.string().min(1),
  exitCode: z.number().int(),
  passed: z.boolean(),
  stdout: z.string().default(""),
  stderr: z.string().default(""),
  durationMs: z.number().nonnegative(),
});
export type CommandGateResult = z.infer<typeof CommandGateResultSchema>;

export const TaskRuntimeStateSchema = z.object({
  taskId: z.string().min(1),
  status: TaskStatusSchema,
  workerAgentId: z.string().optional(),
  verifierAgentId: z.string().optional(),
  commandRepairsUsed: z.number().int().nonnegative().default(0),
  reviewRepairsUsed: z.number().int().nonnegative().default(0),
  commitSha: z.string().optional(),
  blockedReason: BlockedReasonSchema.optional(),
  blockedDetail: z.string().optional(),
  lastWorkerReport: WorkerReportSchema.optional(),
  lastVerifierReport: VerifierReportSchema.optional(),
  lastGateResults: z.array(CommandGateResultSchema).default([]),
  advisories: z.array(FindingSchema).default([]),
});
export type TaskRuntimeState = z.infer<typeof TaskRuntimeStateSchema>;

export const RunEventSchema = z.object({
  at: z.string().datetime(),
  type: z.string().min(1),
  taskId: z.string().optional(),
  detail: z.record(z.unknown()).default({}),
});
export type RunEvent = z.infer<typeof RunEventSchema>;

export const RunStateSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  runId: z.string().min(1),
  status: RunStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  manifestHash: z.string().min(1),
  worktreePath: z.string().optional(),
  branchName: z.string().optional(),
  baseRef: z.string().optional(),
  headSha: z.string().optional(),
  tasks: z.array(TaskRuntimeStateSchema),
  finalBranchRepairsUsed: z.number().int().nonnegative().default(0),
  prUrl: z.string().url().optional(),
  cost: z
    .object({
      inputTokens: z.number().nonnegative().default(0),
      outputTokens: z.number().nonnegative().default(0),
      agentLaunches: z.number().int().nonnegative().default(0),
    })
    .default({}),
  events: z.array(RunEventSchema).default([]),
});
export type RunState = z.infer<typeof RunStateSchema>;

export const FinalReportSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  runId: z.string().min(1),
  status: RunStatusSchema,
  branchName: z.string().optional(),
  prUrl: z.string().optional(),
  durationMs: z.number().nonnegative(),
  tasks: z.array(
    z.object({
      taskId: z.string(),
      title: z.string().optional(),
      status: TaskStatusSchema,
      commitSha: z.string().optional(),
      blockedReason: BlockedReasonSchema.optional(),
      blockedDetail: z.string().optional(),
      advisories: z.array(FindingSchema).default([]),
    }),
  ),
  cost: RunStateSchema.shape.cost,
  retries: z.object({
    commandOrSpec: z.number().int().nonnegative(),
    review: z.number().int().nonnegative(),
    finalBranch: z.number().int().nonnegative(),
    sdkStartup: z.number().int().nonnegative(),
  }),
});
export type FinalReport = z.infer<typeof FinalReportSchema>;
