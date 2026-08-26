import { z } from "zod";

export const ProjectSettingsSchema = z.object({
  models: z.object({
    default: z.string().min(1).default("default"),
    small: z.string().min(1).default("small"),
  }).default({ default: "default", small: "small" }),
  budgets: z.object({
    guidanceTokens: z.number().int().positive().default(4000),
    inputTokens: z.number().int().positive().default(6000),
    graphifyTokens: z.number().int().nonnegative().default(1500),
    maxAgentTokens: z.number().int().positive().optional(),
    roleMaxAgentTokens: z.record(z.string(), z.number().int().positive()).default({
      "docs-writer": 50_000,
    }),
  }).default({
    guidanceTokens: 4000,
    inputTokens: 6000,
    graphifyTokens: 1500,
    roleMaxAgentTokens: { "docs-writer": 50_000 },
  }),
  workflow: z.object({
    agentTimeoutMinutes: z.number().int().min(1).max(1440).default(30),
    grillQuestionsPerBatch: z.number().int().min(1).max(8).default(3),
    maxWayfindingTurnsPerEpisode: z.number().int().min(1).default(6),
    maxPhaseHopsPerAdvance: z.number().int().min(1).default(16),
    maxImplementationAttempts: z.number().int().min(1).default(3),
    maxFinalReviewAttempts: z.number().int().min(1).default(3),
    maxImageRepairAttempts: z.number().int().min(1).default(2),
  }).default({
    agentTimeoutMinutes: 30,
    grillQuestionsPerBatch: 3,
    maxWayfindingTurnsPerEpisode: 6,
    maxPhaseHopsPerAdvance: 16,
    maxImplementationAttempts: 3,
    maxFinalReviewAttempts: 3,
    maxImageRepairAttempts: 2,
  }),
  verification: z.object({
    command: z.string().min(1).optional(),
    fixCommand: z.string().min(1).optional(),
    testGlobs: z.array(z.string().min(1)).default([]),
  }).default({ testGlobs: [] }),
  coverage: z.object({
    enabled: z.boolean().default(false),
    command: z.string().min(1).optional(),
  }).default({ enabled: false }),
});

export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

export const DEFAULT_SETTINGS: ProjectSettings = ProjectSettingsSchema.parse({});

export function mergeSettings(
  ...layers: Array<Partial<ProjectSettings> | undefined>
): ProjectSettings {
  const merged: Record<string, unknown> = structuredClone(DEFAULT_SETTINGS);
  for (const layer of layers) {
    if (!layer) continue;
    deepMerge(merged, layer as Record<string, unknown>);
  }
  return ProjectSettingsSchema.parse(merged);
}

export function maxAgentTokensFor(role: string, settings: ProjectSettings): number | undefined {
  const roleCap = settings.budgets.roleMaxAgentTokens?.[role];
  if (roleCap !== undefined) return roleCap;
  return settings.budgets.maxAgentTokens;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const current = target[key];
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      current &&
      typeof current === "object" &&
      !Array.isArray(current)
    ) {
      deepMerge(current as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      target[key] = value;
    }
  }
}

export type SettingsAuditEntry = {
  at: string;
  source: "advance" | "start" | "answer" | "retry";
  settings: ProjectSettings;
};
