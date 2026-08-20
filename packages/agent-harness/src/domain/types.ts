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

export type Question = {
  id: string;
  prompt: string;
  kind: "confirm" | "text" | "choice";
  choices?: string[];
  recommended?: string;
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
};

export type FogStatus = "fog" | "asked" | "parked" | "resolved";

export type FogEntry = {
  id: string;
  text: string;
  status: FogStatus;
};

export type TaskStatus = "pending" | "in_progress" | "review" | "committed" | "blocked";

export type Task = {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  commitSha?: string;
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
  input: unknown;
  guidance: string;
  retrieval: string;
  budget: {
    guidanceTokens: number;
    inputTokens: number;
    graphifyTokens: number;
    truncated: string[];
  };
};

export type AgentInvocation = {
  role: string;
  packet: WorkPacket;
  output: unknown;
  at: string;
};

export type ProjectRegistration = {
  projectKey: string;
  controlRoot: string;
  worktreeRoot: string;
  createdAt: string;
};
