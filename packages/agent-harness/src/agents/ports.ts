import type {
  Finding,
  VerifierReport,
  WorkerReport,
} from "../schemas/reports.js";
import type { ManifestTask, RunManifest } from "../schemas/manifest.js";
import type { ProjectConfig } from "../schemas/config.js";

export type AgentLaunchResult = {
  agentId: string;
  runId: string;
  text: string;
  inputTokens?: number;
  outputTokens?: number;
};

export type AgentPort = {
  runWorker(input: {
    model: string;
    cwd: string;
    task: ManifestTask;
    manifest: RunManifest;
    resumeAgentId?: string;
    repairContext?: string;
  }): Promise<{ launch: AgentLaunchResult; report: WorkerReport }>;

  runVerifier(input: {
    model: string;
    cwd: string;
    task: ManifestTask;
    changedPaths: string[];
    resumeAgentId?: string;
    repairFocus?: Finding[];
  }): Promise<{ launch: AgentLaunchResult; report: VerifierReport }>;

  runAdversarial(input: {
    model: string;
    cwd: string;
    baseRef: string;
    changedPaths: string[];
    resumeAgentId?: string;
    repairFocus?: Finding[];
  }): Promise<{ launch: AgentLaunchResult; report: VerifierReport }>;

  runPrepareResearch(input: {
    model: string;
    cwd: string;
    config: ProjectConfig;
    draftTasks: ManifestTask[];
  }): Promise<{
    launch: AgentLaunchResult;
    enrichment: Array<{
      taskId: string;
      allowedGlobs?: string[];
      testSeams?: string[];
      browserProbes?: ManifestTask["browserProbes"];
      implementationNotes?: string;
    }>;
  }>;
};

export type GitHubIssue = {
  number: number;
  id: number;
  title: string;
  body: string;
  labels: string[];
  state: string;
  htmlUrl: string;
  parentNumber?: number;
  blockedBy?: number[];
};

export type GitHubPort = {
  getIssue(owner: string, repo: string, number: number): Promise<GitHubIssue>;
  listSubIssues(
    owner: string,
    repo: string,
    number: number,
  ): Promise<GitHubIssue[]>;
  assignIssue(
    owner: string,
    repo: string,
    number: number,
    login: string,
  ): Promise<void>;
  commentIssue(
    owner: string,
    repo: string,
    number: number,
    body: string,
  ): Promise<void>;
  setProjectStatus?(input: {
    owner: string;
    repo: string;
    issueNumber: number;
    status: string;
  }): Promise<void>;
  createPullRequest(input: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<{ url: string; number: number }>;
};
