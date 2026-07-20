import { z } from "zod";

export const CONTRACT_VERSION = "1" as const;

export const FindingSeveritySchema = z.enum(["BLOCKING", "ADVISORY"]);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

export const TaskModeSchema = z.enum(["AFK", "HITL"]);
export type TaskMode = z.infer<typeof TaskModeSchema>;

export const SourceKindSchema = z.enum(["local", "github"]);
export type SourceKind = z.infer<typeof SourceKindSchema>;

export const RunStatusSchema = z.enum([
  "prepared",
  "approved",
  "running",
  "partial",
  "blocked",
  "succeeded",
  "failed",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const TaskStatusSchema = z.enum([
  "pending",
  "ready",
  "working",
  "verifying",
  "repairing",
  "accepted",
  "blocked",
  "blocked_dependency",
  "skipped",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const BlockedReasonSchema = z.enum([
  "HITL_REQUIRED",
  "INVALID_MANIFEST",
  "DEPENDENCY_CYCLE",
  "MISSING_ACCEPTANCE",
  "COMMAND_GATE_FAILED",
  "PATH_SCOPE_VIOLATION",
  "PROTECTED_PATH",
  "BLOCKING_FINDING",
  "REPAIR_BUDGET_EXHAUSTED",
  "SDK_RETRY_EXHAUSTED",
  "BLOCKED_TOOL_PERMISSION",
  "BLOCKED_DEPENDENCY",
  "BROWSER_PROBE_FAILED",
  "FINAL_GATE_FAILED",
  "PUBLISH_FAILED",
  "RESUME_INVARIANT",
  "PRECONDITION",
]);
export type BlockedReason = z.infer<typeof BlockedReasonSchema>;
