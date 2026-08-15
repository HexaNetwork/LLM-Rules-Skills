import type { Context } from "@deepseek-ai/cordis";
import type { HarnessConfig } from "../../config/schema.js";
import type { RunWorkspace } from "../../domain.js";
import type { AgentBackend } from "../../infrastructure/agents/types.js";
import type { HarnessPaths } from "../../application/paths.js";
import type { RunRepository } from "../../application/run-repository.js";
import type { RunStatePort } from "../../application/run-state-port.js";
import { WorkerHarnessRuntime } from "../../application/harness-engine.js";
import type { WorkspaceProvisioner } from "../../workspace/types.js";
import { WorkerWorkspaceProvisioner } from "../../workspace/worker-workspace-provisioner.js";

export type WorkerRuntimeConfig = {
  config: HarnessConfig;
  backend: AgentBackend;
  store: RunRepository;
  runStatePort: RunStatePort;
  workspace: RunWorkspace;
  paths: HarnessPaths;
  /** Defaults to the in-container provisioner; host Docker is unreachable here. */
  workspaceProvisioner?: WorkspaceProvisioner;
};

export type WorkerRuntimeControl = {
  engine: WorkerHarnessRuntime;
  ready(): Promise<boolean>;
  advance(runId: string): Promise<void>;
  shutdown(): Promise<void>;
};

/** Cordis-owned worker constructor graph and workflow service publication. */
export function workerRuntimePlugin(ctx: Context, input: WorkerRuntimeConfig): void {
  const engine = new WorkerHarnessRuntime(input.config, {
    backend: input.backend,
    store: input.store,
    runStatePort: input.runStatePort,
    workspace: input.workspace,
    paths: input.paths,
    workspaceProvisioner:
      input.workspaceProvisioner ??
      new WorkerWorkspaceProvisioner({ workspacePath: input.paths.workspaceRoot }),
  });
  const control: WorkerRuntimeControl = {
    engine,
    ready: async () => true,
    advance: (runId) => engine.advance(runId).then(() => undefined),
    shutdown: async () => undefined,
  };
  ctx.provide("workerControl", control);
  ctx.provide("agents", engine.agents);
  ctx.provide("knowledge", engine.knowledge);
  ctx.provide("repositoryIntelligence", {
    query: async () => {
      throw new Error("Repository intelligence is invoked through the worker knowledge service");
    },
  });
  ctx.provide("verification", {
    run: async () => ({ passed: true, output: "delegated to workflow gates" }),
  });
  ctx.provide("resultExport", {
    export: async () => {
      throw new Error("Result export is available only at the export-ready workflow boundary");
    },
  });
  ctx.provide("commands", {
    run: async () => {
      throw new Error("Commands are invoked through config-owned workflow verification");
    },
  });
}
