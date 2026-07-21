import { z } from "zod";
import { CONTRACT_VERSION } from "./common.js";

export const CommandGateSchema = z.object({
  id: z.string().min(1),
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});
export type CommandGate = z.infer<typeof CommandGateSchema>;

export const RetryBudgetSchema = z.object({
  sdkStartupAttempts: z.number().int().min(1).default(3),
  commandOrSpecRepairs: z.number().int().min(0).default(2),
  reviewRepairs: z.number().int().min(0).default(1),
  finalBranchRepairs: z.number().int().min(0).default(1),
});
export type RetryBudget = z.infer<typeof RetryBudgetSchema>;

/** Runtime fail-safes while agents are in flight. */
export const WatchdogsSchema = z.object({
  /**
   * If a worker produces no *new* worktree changes for this long, cancel it as stuck.
   * Stays armed until the worker run finishes (then harness command/testing gates run).
   * Set to 0 to disable. Default: 5 minutes.
   */
  workerNoCodeMs: z.number().int().nonnegative().default(5 * 60 * 1000),
});
export type Watchdogs = z.infer<typeof WatchdogsSchema>;

export const ModelRolesSchema = z.object({
  prepare: z.string().min(1),
  worker: z.string().min(1),
  verifier: z.string().min(1),
  repair: z.string().min(1),
  adversarial: z.string().min(1),
});
export type ModelRoles = z.infer<typeof ModelRolesSchema>;

export const AllowlistPolicySchema = z.object({
  terminalAllowlist: z.array(z.string()).default([]),
  mcpAllowlist: z.array(z.string()).default([]),
  networkAllowlist: z.array(z.string()).default([]),
});
export type AllowlistPolicy = z.infer<typeof AllowlistPolicySchema>;

export const BrowserSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  mcpServer: z.string().optional(),
  baseUrl: z.string().url().optional(),
});
export type BrowserSettings = z.infer<typeof BrowserSettingsSchema>;

export const GitHubLifecycleSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  projectNumber: z.number().int().positive().optional(),
  statusField: z.string().default("Status"),
  statusInProgress: z.string().default("In Progress"),
  statusDone: z.string().default("Done"),
  statusBlocked: z.string().default("Blocked"),
  assigneeLogin: z.string().optional(),
  afkLabel: z.string().default("afk"),
  hitlLabel: z.string().default("hitl"),
});
export type GitHubLifecycle = z.infer<typeof GitHubLifecycleSchema>;

export const PathPolicySchema = z.object({
  protectedGlobs: z.array(z.string()).default([
    ".env",
    ".env.*",
    "**/*secret*",
    "**/*credential*",
  ]),
  defaultAllowedGlobs: z.array(z.string()).default(["**/*"]),
});
export type PathPolicy = z.infer<typeof PathPolicySchema>;

export const ProjectConfigSchema = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  name: z.string().min(1),
  repositoryRoot: z.string().min(1).default("."),
  baseBranch: z.string().min(1).default("main"),
  branchPrefix: z.string().min(1).default("agent-harness"),
  models: ModelRolesSchema,
  commandGates: z.array(CommandGateSchema).min(1),
  pathPolicy: PathPolicySchema.default({}),
  retries: RetryBudgetSchema.default({}),
  watchdogs: WatchdogsSchema.default({}),
  allowlist: AllowlistPolicySchema.default({}),
  browser: BrowserSettingsSchema.default({}),
  github: GitHubLifecycleSchema.optional(),
  runDirectory: z.string().default(".agent-harness/runs"),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
