import type { DockerExecutionPolicy } from "../config/schema.js";
import type { DockerExecResult } from "../infrastructure/container/types.js";

export const HARNESS_RPC_URL_ENV = "HARNESS_RPC_URL" as const;
export const HARNESS_WORKER_TOKEN_ENV = "HARNESS_WORKER_TOKEN" as const;

export type WorkerCapability = "model";

export const WORKER_BROKER_CAPABILITIES: readonly WorkerCapability[] = ["model"];

export type SandboxExecResult = DockerExecResult;

export type SandboxWorkspace =
  | { kind: "volume"; volumeName: string }
  | { kind: "bind"; hostPath: string };

export type SandboxCreateInput = {
  name: string;
  image: string;
  projectKey: string;
  runId: string;
  workspace: SandboxWorkspace;
  dockerPolicy: DockerExecutionPolicy;
  env?: ReadonlyArray<string>;
  publicReadOnlyMounts?: ReadonlyArray<{ source: string; target: string }>;
  workingDir?: string;
  user?: string;
  runsCursorSandbox?: boolean;
  command?: string[];
};

export type Sandbox = {
  readonly id: string;
  readonly name: string;
  exec(
    command: readonly string[],
    options?: { timeoutMs?: number; input?: string; signal?: AbortSignal },
  ): Promise<SandboxExecResult>;
  destroy(): Promise<void>;
};

export type SandboxProvider = {
  create(input: SandboxCreateInput): Promise<Sandbox>;
};
