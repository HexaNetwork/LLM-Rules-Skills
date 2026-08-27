export const RUN_STATUSES = [
  "queued", "starting", "working", "awaiting_user", "stalled", "blocked",
  "cancelled", "completed",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];
export type JsonSchema = Record<string, unknown>;
export type JsonObject = Record<string, unknown>;

export type AgentTurnRequest = {
  turnId: string;
  role: string;
  sessionId?: string;
  prompt: string;
  outputSchema: JsonSchema;
};

export type Usage = {
  inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number;
  totalTokens?: number; reasoningTokens?: number; costUsd?: number; rawCostUsd?: number;
  provider?: string; model?: string; providerRunId?: string; requestId?: string; durationMs?: number;
};
export type AgentTurnResult = {
  turnId: string;
  sessionId: string;
  output: unknown;
  usage?: Usage;
};

export type ContainerCommand = {
  actionId: string;
  command: string;
  timeoutMs?: number;
};

export type CommandResult = {
  actionId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
};

export type UserQuestion = { id: string; prompt: string; required: boolean };
export type ReflectGatePayload = {
  proposedTitle?: string;
  summary: string;
  restatement: string;
  goal: string;
  users: string[];
  inScope: string[];
  outOfScope: string[];
  assumptions: string[];
  unknowns: string[];
};

export type SpecificationGateDocuments = {
  glossary: string;
  plan: string;
  requirements: string;
  scenarios: string;
};

export type UserGate = {
  id: string;
  title: string;
  questions: UserQuestion[];
  editableArtifacts?: string[];
  reflect?: ReflectGatePayload;
  documents?: SpecificationGateDocuments;
};
export type UserAnswers = { gateId: string; answers: Record<string, string> };
export type StepError = { code: string; message: string; detail?: unknown; retryable: boolean };

export type StepTransition<State, Output> =
  | { type: "invoke-agent"; state: State; request: AgentTurnRequest }
  | { type: "run-command"; state: State; request: ContainerCommand }
  | { type: "await-user"; state: State; gate: UserGate }
  | { type: "complete"; output: Output }
  | { type: "blocked"; error: StepError };

export interface WorkflowStep<Input, State, Output> {
  readonly id: string;
  start(input: Input): StepTransition<State, Output>;
  onAgent(state: State, result: AgentTurnResult): StepTransition<State, Output>;
  onCommand(state: State, result: CommandResult): StepTransition<State, Output>;
  onUser(state: State, answers: UserAnswers): StepTransition<State, Output>;
}

export type EnvironmentSpec = {
  containerfile: string;
  setupCommands: string[];
  healthcheckCommands: string[];
  caches: Array<{ name: string; containerPath: string }>;
};

export type Project = { id: string; name: string; repositoryPath: string; baseBranch: string; createdAt: string };
export type Run = {
  id: string; projectId: string; workflowId: string; currentStep: string; status: RunStatus;
  revision: number; input: JsonObject; createdAt: string; updatedAt: string;
};
export type DurableCommand = {
  id: string; runId: string; kind: string; payload: JsonObject; status: "queued" | "leased" | "completed" | "failed";
  idempotencyKey: string; priority: number; leaseOwner?: string; leaseExpiresAt?: string; createdAt: string;
};
export type EventRecord = { id: number; runId?: string; kind: string; message: string; data?: unknown; createdAt: string };
export type TurnRecord = {
  id: string; runId: string; stepId: string; actionKey: string; role: string; sessionId?: string;
  request: AgentTurnRequest; output?: unknown; usage?: Usage;
  status: "starting" | "completed" | "stalled" | "blocked"; attempt: number; error?: string;
  createdAt: string; updatedAt: string;
};
export type ArtifactRecord = { id: string; runId: string; stepId: string; name: string; path: string; mediaType: string; createdAt: string };
export type UsageBreakdown = {
  key: string; sessions: number; completedSessions: number; failedSessions: number; usageReportedSessions: number;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number };
};
export type UsageReport = { total: UsageBreakdown; byRole: UsageBreakdown[]; byStep: UsageBreakdown[] };
export type RunError = {
  id: string;
  source: "run" | "agent" | "step" | "command";
  stepId?: string;
  role?: string;
  message: string;
  detail?: unknown;
  createdAt: string;
};

export type WorkflowDefinition = { id: string; steps: readonly WorkflowStep<unknown, unknown, unknown>[] };
export type EffectiveConfig = {
  coordinatorUrl: string;
  runnerImage: string;
  agentDeadlineMs: number;
  implementationAttemptLimit: number;
  finalRepairAttemptLimit: number;
  dockerBuildConcurrency: number;
  models: Record<string, string>;
  publication: { remote: string; draft: boolean };
  environmentSpec?: EnvironmentSpec;
  verificationCommands?: string[];
  coverageCommands?: string[];
};
