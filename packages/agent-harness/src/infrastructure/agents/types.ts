import { z } from "zod";
import type { InvocationKind, InvocationTrigger } from "../../application/agent-activity.js";
import type { AgentRole, RunPhase } from "../../domain.js";
import { HarnessFailure } from "../../errors.js";

export type AgentStepEvent = {
  type: string;
  toolName?: string;
  summary?: string;
};

export type ObservedInstallEvent = {
  manager: import("../../domain.js").PackageManager;
  packages: string[];
  commandSummary: string;
  role: AgentRole;
  taskId?: string;
};

export type AgentRequest = {
  role: AgentRole;
  model: string;
  prompt: string;
  continuationPrompt?: string;
  providerSessionId?: string;
  retainProviderSession?: boolean;
  mode?: "agent" | "plan";
  /** When false, the backend aborts the run as soon as a tool call is observed. */
  allowTools?: boolean;
  cwd: string;
  signal: AbortSignal;
  /** Redacted live step ticker; never includes raw tool args. */
  onStep?: (step: AgentStepEvent) => void;
  /** Passive install observation from shell-like tool calls (never blocks). */
  onInstallObserved?: (entry: ObservedInstallEvent) => void;
  taskId?: string;
};


export type AgentBackendResult = {
  output: unknown;
  /** Plan-mode CreatePlan bodies captured during the run, oldest first. */
  createPlanBodies?: string[];
  providerSessionId?: string;
  providerRunId?: string;
  providerSessionReused?: boolean;
  submittedPrompt?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
};

export type BackendWorkspaceCapabilities = {
  /** Provider can bind agent tools to a single writable cwd/workspace. */
  canRestrictWritableWorkspace: boolean;
  providerId: string;
};

export interface AgentBackend {
  run(request: AgentRequest): Promise<AgentBackendResult>;
  release?(providerSessionId: string): Promise<void>;
  readiness?(): { ready: boolean; message?: string };
  /** Optional isolation capability advertisement for strictIsolation checks. */
  workspaceCapabilities?(): BackendWorkspaceCapabilities;
}

export class AgentBackendRunError extends HarnessFailure {
  readonly result: Partial<AgentBackendResult>;

  constructor(
    message: string,
    result: Partial<AgentBackendResult> = {},
  ) {
    super(message, "provider", true);
    this.name = "AgentBackendRunError";
    this.result = result;
  }
}

type InvokeBase<T> = {
  runId: string;
  role: AgentRole;
  objective: string;
  input: unknown;
  /**
   * New information for a retained provider conversation. The complete `input`
   * remains in the durable packet and is used if provider resume falls back to
   * a fresh context; this delta is submitted only when resume actually works.
   */
  continuationInput?: unknown;
  expectedOutput: string;
  // Input is intentionally loosened: schemas with `.default()` fields have an
  // Input type narrower than parsed Output T, which a plain z.ZodType<T> would reject here.
  schema: z.ZodType<T, z.ZodTypeDef, any>;
  constraints?: string[];
  priorArtifacts?: string[];
  /** Domain seed for Graphify when the primary query shapes to generic tokens. */
  knowledgeFallbackQuery?: string;
  buildPrompt?: boolean;
  previousGuidanceFingerprint?: string;
  /** Deny provider tool calls for constrained, packet-complete roles. */
  allowTools?: boolean;
  /** Out-of-band cancellation from the harness engine. */
  signal?: AbortSignal;
  /** Harness-authored causal metadata for Agent activity (models never supply this). */
  causal?: {
    taskId?: string;
    phase?: RunPhase;
    taskStep?: string;
    invocationKind?: InvocationKind;
    trigger?: InvocationTrigger;
  };
};

/** Retrieval-disabled calls must not invent a JSON-blob knowledge query. */
export type InvokeInput<T> =
  | (InvokeBase<T> & { retrieval: false; knowledgeQuery?: string })
  | (InvokeBase<T> & { retrieval?: true; knowledgeQuery: string });

export type AgentInvocation<T> = {
  value: T;
  providerSessionId?: string;
  providerRunId?: string;
  providerSessionReused: boolean;
  providerTurns: number;
  guidanceFingerprint?: string;
};
