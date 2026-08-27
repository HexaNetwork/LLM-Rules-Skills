import { randomUUID } from "node:crypto";
import type { Store } from "./store.js";
import type { WorkflowEngine } from "./workflow-engine.js";
import type { EnvironmentManager } from "./environment-manager.js";
import path from "node:path";

export class Coordinator {
  private readonly owner = randomUUID();
  private stopping = false;
  private wake?: () => void;
  private loop?: Promise<void>;
  private cancellationLoop?: Promise<void>;
  constructor(private readonly store: Store, private readonly engine: WorkflowEngine, private readonly environments: EnvironmentManager, private readonly worktreeRoot: string, private readonly leaseMs = 30_000) {}

  async start(): Promise<void> {
    this.stopping = false;
    for (const run of this.store.listRuns().filter((item) => !["completed", "cancelled"].includes(item.status))) {
      if (["implement", "validate", "publish"].includes(run.currentStep)) await this.environments.ensureContainer(run.id, path.join(this.worktreeRoot, run.id)).catch((error) => this.store.setRunStatus(run.id, "blocked", `Container recovery failed: ${String(error)}`));
    }
    this.loop = this.consume();
    this.cancellationLoop = this.consumeCancellations();
  }
  notify(): void { this.wake?.(); }
  async stop(): Promise<void> { this.stopping = true; this.notify(); await Promise.all([this.loop, this.cancellationLoop]); }

  private async consume(): Promise<void> {
    while (!this.stopping) {
      const command = this.store.leaseNextCommand(this.owner, this.leaseMs);
      if (!command) { await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 500); timer.unref(); this.wake = () => { clearTimeout(timer); resolve(); }; }); this.wake = undefined; continue; }
      const renewal = setInterval(() => this.store.renewLease(command.id, this.owner, this.leaseMs), Math.max(1_000, this.leaseMs / 3)); renewal.unref();
      try { await this.engine.process(command); this.store.finishCommand(command.id, this.owner); }
      catch (error) { this.store.finishCommand(command.id, this.owner, error instanceof Error ? error.message : String(error)); }
      finally { clearInterval(renewal); }
    }
  }

  private async consumeCancellations(): Promise<void> {
    while (!this.stopping) {
      const command = this.store.leaseNextCancellation(this.owner, this.leaseMs);
      if (!command) { await new Promise((resolve) => setTimeout(resolve, 200)); continue; }
      try { await this.engine.process(command); this.store.finishCommand(command.id, this.owner); }
      catch (error) { this.store.finishCommand(command.id, this.owner, error instanceof Error ? error.message : String(error)); }
    }
  }
}
