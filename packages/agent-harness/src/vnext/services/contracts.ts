import type { HardenedContainerSpec } from "../../infrastructure/container/container-spec.js";
import type { RunStatePort } from "../../application/run-state-port.js";

export const VNEXT_SERVICE_NAMES = [
  "runState",
  "runArtifacts",
  "runLifecycle",
  "containerRuntime",
  "securityPolicy",
  "workspaceSource",
  "environment",
  "workerControl",
  "credentials",
  "agents",
  "roles",
  "workflow",
  "knowledge",
  "repositoryIntelligence",
  "verification",
  "resultExport",
  "publisher",
  "commands",
  "webServer",
] as const;

export type VNextServiceName = (typeof VNEXT_SERVICE_NAMES)[number];

export type LifecycleStage =
  | "created"
  | "image_ready"
  | "volume_ready"
  | "workspace_seeded"
  | "worker_starting"
  | "worker_ready"
  | "running"
  | "export_ready"
  | "settled";

export type LifecycleFailure = {
  stage: LifecycleStage;
  retryable: boolean;
  lastSuccessfulStage: LifecycleStage;
  message: string;
  at: string;
};

export type HostLifecycleState = {
  runId: string;
  stage: LifecycleStage;
  revision: number;
  failure?: LifecycleFailure;
};

export interface RunArtifactsService {
  read(runId: string, kind: string, id?: string): Promise<string | undefined>;
  write(runId: string, kind: string, contents: string, id?: string): Promise<void>;
}

export interface RunLifecycleService {
  enqueue(runId: string): Promise<void>;
  recover(): Promise<void>;
  state(runId: string): Promise<HostLifecycleState | undefined>;
}

export interface ContainerRuntimeService {
  ensureImage(reference: string): Promise<{ reference: string; digest: string }>;
  createVolume(name: string, labels: Record<string, string>): Promise<void>;
  start(spec: HardenedContainerSpec, command: string[]): Promise<{ containerId: string }>;
  stop(containerId: string): Promise<void>;
  removeContainer(containerId: string): Promise<void>;
  removeVolume(name: string): Promise<void>;
}

export interface SecurityPolicyService {
  validate(spec: HardenedContainerSpec): void;
}

export interface WorkspaceSeed {
  baseSha: string;
  bundleSha256: string;
  volumeName: string;
}

export interface WorkspaceSourceService {
  prepare(runId: string): Promise<WorkspaceSeed>;
  validate(runId: string, seed: WorkspaceSeed): Promise<void>;
}

export interface EnvironmentService {
  readonly image: string;
  resolve(): Promise<{ reference: string; digest: string }>;
}

export interface WorkerControlService {
  ready(runId: string): Promise<boolean>;
  advance(runId: string): Promise<void>;
  shutdown(runId: string): Promise<void>;
}

export interface CredentialsService {
  issue(runId: string, workerInstanceId: string): Promise<{ credential: string; expiresAt: string }>;
  revoke(runId: string, workerInstanceId: string): Promise<void>;
}

export interface AgentsService {
  invoke(role: string, input: unknown): Promise<unknown>;
}

export type RoleDescriptor = {
  id: string;
  allowTools: boolean;
  description: string;
};

export interface RoleRegistryService {
  register(descriptor: RoleDescriptor): () => void;
  get(id: string): RoleDescriptor | undefined;
  list(): RoleDescriptor[];
}

export type WorkflowPhaseHandler = {
  phase: string;
  terminal?: boolean;
  advance(runId: string): Promise<void>;
};

export interface WorkflowRegistryService {
  register(handler: WorkflowPhaseHandler): () => void;
  get(phase: string): WorkflowPhaseHandler | undefined;
  list(): WorkflowPhaseHandler[];
  validate(nonterminalPhases: readonly string[]): void;
}

export interface KnowledgeService {
  search(query: string): Promise<unknown[]>;
}

export interface RepositoryIntelligenceService {
  query(operation: string, input: string): Promise<string>;
}

export interface VerificationService {
  run(runId: string): Promise<{ passed: boolean; output: string }>;
}

export interface ResultExportService {
  export(runId: string): Promise<{ sha256: string; channel: string }>;
}

export interface PublisherService {
  publish(runId: string, result: { sha256: string; channel: string }): Promise<void>;
}

export interface CommandsService {
  run(commandId: string, cwd: "/workspace"): Promise<{ exitCode: number; output: string }>;
}

export interface WebServerService {
  readonly origin: string;
  close(): Promise<void>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    runState: RunStatePort;
    runArtifacts: RunArtifactsService;
    runLifecycle: RunLifecycleService;
    containerRuntime: ContainerRuntimeService;
    securityPolicy: SecurityPolicyService;
    workspaceSource: WorkspaceSourceService;
    environment: EnvironmentService;
    workerControl: WorkerControlService;
    credentials: CredentialsService;
    agents: AgentsService;
    roles: RoleRegistryService;
    workflow: WorkflowRegistryService;
    knowledge: KnowledgeService;
    repositoryIntelligence: RepositoryIntelligenceService;
    verification: VerificationService;
    resultExport: ResultExportService;
    publisher: PublisherService;
    commands: CommandsService;
    webServer: WebServerService;
  }

  interface Events {
    "run/lifecycle"(state: HostLifecycleState): void;
    "run/export-ready"(runId: string, sha256: string): void;
    "run/settled"(runId: string): void;
  }
}
