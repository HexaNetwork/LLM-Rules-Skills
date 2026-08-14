import type { Context } from "@deepseek-ai/cordis";
import type {
  HostLifecycleState,
  LifecycleStage,
  RunLifecycleService,
} from "../services/contracts.js";

const STAGES: readonly LifecycleStage[] = [
  "created",
  "image_ready",
  "volume_ready",
  "workspace_seeded",
  "worker_starting",
  "worker_ready",
  "running",
  "export_ready",
  "settled",
];

export type LifecycleStageHandler = {
  /**
   * Inspect labeled Docker/durable state and return true only when all identity
   * fields for this stage match. RPC timeout is never evidence of completion.
   */
  inspect(runId: string): Promise<boolean>;
  apply(runId: string): Promise<void>;
  retryable?(error: unknown): boolean;
};

export type RunLifecyclePluginConfig = {
  load(runId: string): Promise<HostLifecycleState | undefined>;
  save(state: HostLifecycleState): Promise<void>;
  listRecoverableRunIds(): Promise<string[]>;
  handlers: Partial<Record<Exclude<LifecycleStage, "created">, LifecycleStageHandler>>;
};

export class RunLifecycleCoordinator implements RunLifecycleService {
  private readonly active = new Map<string, Promise<void>>();
  private stopping = false;

  constructor(
    private readonly ctx: Context,
    private readonly config: RunLifecyclePluginConfig,
  ) {}

  state(runId: string): Promise<HostLifecycleState | undefined> {
    return this.config.load(runId);
  }

  async enqueue(runId: string): Promise<void> {
    if (this.stopping) throw new Error("Run lifecycle is disposing");
    const existing = this.active.get(runId);
    if (existing) return existing;
    const task = this.advance(runId).finally(() => this.active.delete(runId));
    this.active.set(runId, task);
    return task;
  }

  async recover(): Promise<void> {
    const runIds = await this.config.listRecoverableRunIds();
    await Promise.all(runIds.map((runId) => this.enqueue(runId)));
  }

  async dispose(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled(this.active.values());
  }

  private async advance(runId: string): Promise<void> {
    let current =
      (await this.config.load(runId)) ??
      ({ runId, stage: "created", revision: 0 } satisfies HostLifecycleState);
    await this.config.save(current);

    for (let index = STAGES.indexOf(current.stage) + 1; index < STAGES.length; index += 1) {
      const stage = STAGES[index]!;
      const handler = this.config.handlers[stage as Exclude<LifecycleStage, "created">];
      if (!handler) throw new Error(`No lifecycle handler registered for stage "${stage}"`);
      try {
        const alreadyComplete = await handler.inspect(runId);
        if (!alreadyComplete) await handler.apply(runId);
        // Validate after applying. This prevents an RPC timeout or partial
        // Docker operation from being persisted as a completed stage.
        if (!(await handler.inspect(runId))) {
          throw new Error(`Lifecycle stage "${stage}" did not validate after apply`);
        }
        current = {
          runId,
          stage,
          revision: current.revision + 1,
        };
        await this.config.save(current);
        this.ctx.emit("run/lifecycle", current);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failed: HostLifecycleState = {
          ...current,
          revision: current.revision + 1,
          failure: {
            stage,
            retryable: handler.retryable?.(error) ?? true,
            lastSuccessfulStage: current.stage,
            message,
            at: new Date().toISOString(),
          },
        };
        await this.config.save(failed);
        this.ctx.emit("run/lifecycle", failed);
        throw error;
      }
    }
    this.ctx.emit("run/settled", runId);
  }
}

export function runLifecyclePlugin(ctx: Context, config: RunLifecyclePluginConfig): () => Promise<void> {
  const lifecycle = new RunLifecycleCoordinator(ctx, config);
  ctx.provide("runLifecycle", lifecycle);
  return () => lifecycle.dispose();
}
