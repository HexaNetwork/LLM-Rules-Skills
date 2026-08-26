import type { ProjectSettings } from "./settings.js";
import type { RunWorking } from "./working.js";

export type { RunWorking } from "./working.js";

export const RUN_STATUSES = [
  "active",
  "awaiting_input",
  "blocked",
  "cancelled",
  "completed",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export type RunIdentity = {
  runId: string;
  projectKey: string;
  workflowBundleId: string;
  controlRoot: string;
  worktreePath: string;
  baseSha: string;
  baseBranch: string;
  createdAt: string;
};

export type QuestionOption = {
  id: string;
  label: string;
  description: string;
};

export type Question = {
  id: string;
  prompt: string;
  kind: "confirm" | "text" | "choice";
  /** @deprecated Prefer structured `options`; kept for simple confirm/yes-no gates. */
  choices?: string[];
  /** @deprecated Prefer `recommendedOptionId` + `recommendation`. */
  recommended?: string;
  context?: string;
  options?: QuestionOption[];
  recommendedOptionId?: string;
  recommendation?: string;
  /** Fog entries this question resolves or parks when the operator answers. */
  fogIds?: string[];
};

export type GateSpec = {
  id: string;
  title: string;
  questions: Question[];
};

export type AnswerBatch = {
  answers: Record<string, string>;
  parked?: string[];
  notes?: string;
  clarifications?: Array<{ questionId: string; text: string }>;
};

export type FogStatus = "fog" | "asked" | "parked" | "resolved";
export type FogResolutionSource = "user" | "code";

export type FogEntry = {
  id: string;
  text: string;
  status: FogStatus;
  resolution?: {
    source: FogResolutionSource;
    reason: string;
  };
};

export type FogDraft = {
  id: string;
  text: string;
};

export type FogResolution = {
  id: string;
  source: FogResolutionSource;
  reason: string;
};

export type TaskStatus = "pending" | "in_progress" | "review" | "committed" | "blocked";

export type Task = {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  commitSha?: string;
  attempts?: { implementation: number; review: number };
  reviewSummary?: string;
  verification?: VerificationEvidence;
};

export type VerificationEvidence = {
  command: string;
  passed: boolean;
  output: string;
  classification: "passed" | "project_failure" | "environment_failure";
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  exitCode?: number;
};

export type RunState = {
  runId: string;
  status: RunStatus;
  phase: string;
  idea: string;
  revision: number;
  updatedAt: string;
  gate?: GateSpec;
  block?: { reason: string; retriable: boolean };
  /** Ephemeral in-flight work line; overlaid from progress.json when serving status. */
  working?: RunWorking;
  artifacts: Record<string, unknown>;
  fog: FogEntry[];
  tasks: Task[];
  /** Delivery branch set at publish; absent means none yet. */
  branchName?: string;
};

export type Run = {
  identity: RunIdentity;
  state: RunState;
  settings: ProjectSettings;
};

export type AdvanceInput = {
  reason: "start" | "continue" | "retry";
};

export type PhaseResult =
  | { kind: "continue"; next?: string }
  | { kind: "await"; gate: GateSpec }
  | { kind: "block"; reason: string; retriable: boolean }
  | { kind: "done" };

export interface Phase {
  id: string;
  enter?(run: Run): Promise<void>;
  advance(run: Run, input: AdvanceInput): Promise<PhaseResult>;
  onAnswer?(run: Run, batch: AnswerBatch): Promise<PhaseResult>;
}

export type WorkflowBundle = {
  id: string;
  phases: string[];
};

export type StartInput = {
  idea: string;
  baseBranch?: string;
  projectKey?: string;
  repository?: string;
  workflowBundleId?: string;
};

export type WorkPacket = {
  role: string;
  runId: string;
  phase: string;
  /** Configured model selection for this invocation; provider telemetry records the resolved model. */
  model: string;
  input: unknown;
  guidance: string;
  retrieval: string;
  budget: {
    guidanceTokens: number;
    inputTokens: number;
    graphifyTokens: number;
    truncated: string[];
  };
  /** Per-role agent token cap enforced after the worker run completes. */
  maxAgentTokens?: number;
  /** Wall-clock deadline applied to every agent invocation. */
  agentTimeoutMs: number;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
};

export type UsageCost = {
  rawCostCents: number;
  chargedCents: number;
};

export type ProviderTelemetry = {
  provider: "cursor" | "fake";
  model: string;
  agentId?: string;
  providerRunId?: string;
  requestId?: string;
  usage?: TokenUsage;
  cost?: UsageCost;
};

export type AgentInvocation = {
  sessionId: string;
  role: string;
  packet: WorkPacket;
  /** Exact prompt submitted to the provider, when returned by the worker. */
  submittedPrompt?: string;
  /** Present on completed invokes; omitted or null on hard failure. */
  output?: unknown;
  startedAt: string;
  endedAt: string;
  /** Same as `endedAt`; kept for older UI/API consumers. */
  at: string;
  status: "running" | "completed" | "failed";
  error?: string;
  /** Provider identifiers and billed usage captured for this exact invocation. */
  telemetry?: ProviderTelemetry;
};

export type ProjectRegistration = {
  projectKey: string;
  controlRoot: string;
  worktreeRoot: string;
  createdAt: string;
};
