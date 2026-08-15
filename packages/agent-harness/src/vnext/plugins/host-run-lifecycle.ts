import type { Context } from "@deepseek-ai/cordis";
import type { HarnessConfig } from "../../config/schema.js";
import type { RunState } from "../../domain.js";
import {
  createHostRunBootstrap,
  type HostRunBootstrap,
} from "../../application/host-run-bootstrap.js";
import type { RunRepository } from "../../application/run-repository.js";
import type { HarnessDependencies } from "../../application/dependencies.js";
import type {
  HostLifecycleState,
  LifecycleStage,
  RunLifecycleService,
} from "../services/contracts.js";

const LIFECYCLE_ARTIFACT = "host-lifecycle.json";

export type HostRunLifecyclePluginConfig = {
  store: RunRepository;
  runtimeDependencies: HarnessDependencies;
  loadRunConfig(runId: string): Promise<HarnessConfig>;
  startWorker(input: {
    config: HarnessConfig;
    runId: string;
    onProgress(message: string): void;
  }): Promise<void>;
  stopWorker?(input: { config: HarnessConfig; runId: string }): Promise<void>;
  publishRun?(input: { config: HarnessConfig; runId: string }): Promise<RunState>;
  onProgress?(runId: string, message: string): void;
};

export interface HostRunLifecycleService extends RunLifecycleService {
  createRun(config: HarnessConfig, idea: string, runId: string): Promise<RunState>;
  productState(runId: string): Promise<RunState>;
}

/**
 * Sole host owner for production run creation and Docker startup.
 * CLI and HTTP adapters only create durable state and enqueue this service.
 */
export class HostRunLifecycleOwner implements HostRunLifecycleService {
  private readonly active = new Map<string, Promise<void>>();
  private readonly startedWorkers = new Map<string, HarnessConfig>();
  private stopping = false;

  constructor(private readonly config: HostRunLifecyclePluginConfig) {}

  async createRun(config: HarnessConfig, idea: string, runId: string): Promise<RunState> {
    if (this.stopping) throw new Error("Host run lifecycle is disposing");
    const state = await this.bootstrap(config).createRun(idea, runId);
    await this.save({ runId, stage: "created", revision: 0 });
    return state;
  }

  async enqueue(runId: string): Promise<void> {
    if (this.stopping) throw new Error("Host run lifecycle is disposing");
    const existing = this.active.get(runId);
    if (existing) return existing;
    const task = this.advance(runId).finally(() => this.active.delete(runId));
    this.active.set(runId, task);
    return task;
  }

  async recover(): Promise<void> {
    const states = await this.config.store.list();
    const recoverable: string[] = [];
    for (const state of states) {
      if (["completed", "cancelled"].includes(state.phase)) continue;
      // Pre-cutover/manual states have no lifecycle coordinate and must not be
      // reinterpreted by vNext.
      if (await this.state(state.runId)) recoverable.push(state.runId);
    }
    await Promise.all(recoverable.map((runId) => this.enqueue(runId)));
  }

  async state(runId: string): Promise<HostLifecycleState | undefined> {
    try {
      return (await this.config.store.readJson(runId, LIFECYCLE_ARTIFACT)) as HostLifecycleState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  productState(runId: string): Promise<RunState> {
    return this.config.store.load(runId);
  }

  async dispose(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled(this.active.values());
    if (this.config.stopWorker) {
      await Promise.allSettled(
        [...this.startedWorkers].map(([runId, config]) =>
          this.config.stopWorker!({ config, runId }),
        ),
      );
    }
    this.startedWorkers.clear();
  }

  private async advance(runId: string): Promise<void> {
    const runConfig = await this.config.loadRunConfig(runId);
    try {
      const currentProductState = await this.config.store.load(runId);
      if (currentProductState.phase === "publishing" && this.config.publishRun) {
        await this.advanceStage(runId, "export_ready");
        const published = await this.config.publishRun({ config: runConfig, runId });
        if (published.phase === "completed") {
          await this.advanceStage(runId, "settled");
          await this.stopWorker(runId, runConfig);
        }
        return;
      }

      const bootstrap = this.bootstrap(runConfig);
      this.progress(runId, "Ensuring maintained image and Docker workspace");
      const prepared = await bootstrap.prepareWorkspace(runId);
      if (prepared.phase === "blocked" || prepared.phase === "cancelled") return;
      await this.advanceStage(runId, "image_ready");
      await this.advanceStage(runId, "volume_ready");
      await this.advanceStage(runId, "workspace_seeded");

      await this.advanceStage(runId, "worker_starting");
      this.startedWorkers.set(runId, runConfig);
      this.progress(runId, "Advancing host-owned workflow");
      await this.config.startWorker({
        config: runConfig,
        runId,
        onProgress: (message) => this.progress(runId, message),
      });
      await this.advanceStage(runId, "worker_ready");

      const state = await this.config.store.load(runId);
      await this.advanceStage(
        runId,
        state.phase === "completed"
          ? "settled"
          : state.phase === "publishing"
            ? "export_ready"
            : "running",
      );
      if (state.phase === "completed" || state.phase === "cancelled") {
        await this.stopWorker(runId, runConfig);
      }
    } catch (error) {
      const current =
        (await this.state(runId)) ??
        ({ runId, stage: "created", revision: 0 } satisfies HostLifecycleState);
      const message = error instanceof Error ? error.message : String(error);
      await this.save({
        ...current,
        revision: current.revision + 1,
        failure: {
          stage: current.stage,
          retryable: true,
          lastSuccessfulStage: current.stage,
          message,
          at: new Date().toISOString(),
        },
      });
      throw error;
    }
  }

  private async advanceStage(runId: string, stage: LifecycleStage): Promise<void> {
    const current =
      (await this.state(runId)) ??
      ({ runId, stage: "created", revision: 0 } satisfies HostLifecycleState);
    await this.save({
      runId,
      stage,
      revision: current.revision + 1,
    });
  }

  private save(state: HostLifecycleState): Promise<string> {
    return this.config.store.writeJson(state.runId, LIFECYCLE_ARTIFACT, state);
  }

  private progress(runId: string, message: string): void {
    this.config.onProgress?.(runId, message);
  }

  private bootstrap(config: HarnessConfig): HostRunBootstrap {
    return createHostRunBootstrap(config, this.config.runtimeDependencies);
  }

  private async stopWorker(runId: string, config: HarnessConfig): Promise<void> {
    if (!this.config.stopWorker) return;
    await this.config.stopWorker({ config, runId });
    this.startedWorkers.delete(runId);
  }
}

export function hostRunLifecyclePlugin(
  ctx: Context,
  config: HostRunLifecyclePluginConfig,
): () => Promise<void> {
  const lifecycle = new HostRunLifecycleOwner(config);
  ctx.provide("runLifecycle", lifecycle);
  return () => lifecycle.dispose();
}
