import { z } from "zod";
import {
  CONTRACT_VERSION,
  SourceKindSchema,
  TaskModeSchema,
} from "./common.js";
import { ProjectConfigSchema, RetryBudgetSchema } from "./config.js";

export const AcceptanceCriterionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

export const BrowserProbeSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  urlPath: z.string().optional(),
  steps: z.array(z.string()).min(1),
});
export type BrowserProbe = z.infer<typeof BrowserProbeSchema>;

export const ManifestTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  mode: TaskModeSchema,
  sourceRef: z.string().optional(),
  body: z.string().default(""),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1),
  blockedBy: z.array(z.string()).default([]),
  allowedGlobs: z.array(z.string()).min(1),
  testSeams: z.array(z.string()).default([]),
  browserProbes: z.array(BrowserProbeSchema).default([]),
  implementationNotes: z.string().optional(),
});
export type ManifestTask = z.infer<typeof ManifestTaskSchema>;

export const SourceDocumentSchema = z.object({
  kind: SourceKindSchema,
  location: z.string().min(1),
  contentHash: z.string().min(1),
  fetchedAt: z.string().datetime(),
});
export type SourceDocument = z.infer<typeof SourceDocumentSchema>;

export const DraftManifestSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  draft: z.literal(true),
  createdAt: z.string().datetime(),
  source: SourceDocumentSchema,
  configSnapshot: ProjectConfigSchema,
  tasks: z.array(ManifestTaskSchema).min(1),
  validationErrors: z.array(z.string()).default([]),
});
export type DraftManifest = z.infer<typeof DraftManifestSchema>;

export const RunManifestSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  draft: z.literal(false),
  approvedAt: z.string().datetime(),
  approvedBy: z.string().min(1),
  manifestHash: z.string().min(1),
  source: SourceDocumentSchema,
  configSnapshot: ProjectConfigSchema,
  retries: RetryBudgetSchema,
  models: ProjectConfigSchema.shape.models,
  taskOrder: z.array(z.string()).min(1),
  tasks: z.array(ManifestTaskSchema).min(1),
});
export type RunManifest = z.infer<typeof RunManifestSchema>;
