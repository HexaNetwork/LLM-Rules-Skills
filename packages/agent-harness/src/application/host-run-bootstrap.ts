import type { HarnessConfig } from "../config/schema.js";
import type { RunState } from "../domain.js";
import { ApplicationContext } from "./application-context.js";
import { runCancellationRegistry } from "./cancellation-registry.js";
import type { HarnessDependencies } from "./dependencies.js";
import { RunLifecycleService } from "./run-lifecycle-service.js";

/**
 * Host-owned run creation and Docker workspace preparation.
 * Does not construct WorkerHarnessRuntime or workflow phase services.
 */
export class HostRunBootstrap {
  readonly ctx: ApplicationContext;
  private readonly lifecycle: RunLifecycleService;

  constructor(config: HarnessConfig, dependencies: HarnessDependencies) {
    this.ctx = new ApplicationContext(config, dependencies, runCancellationRegistry);
    this.lifecycle = new RunLifecycleService(this.ctx);
  }

  createRun(idea: string, runId?: string): Promise<RunState> {
    return this.lifecycle.create(idea, runId);
  }

  prepareWorkspace(runId: string): Promise<RunState> {
    return this.lifecycle.prepare(runId, false, false);
  }
}

export function createHostRunBootstrap(
  config: HarnessConfig,
  dependencies: HarnessDependencies,
): HostRunBootstrap {
  return new HostRunBootstrap(config, dependencies);
}
