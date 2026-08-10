import { access, unlink, writeFile } from "node:fs/promises";
import { hostname as localHostname } from "node:os";
import path from "node:path";
import type { AgentCoordinator } from "../agent.js";
import type { HarnessConfig } from "../config.js";
import type { BuildTask, RunState } from "../domain.js";
import { HarnessFailure } from "../errors.js";
import type { GitService } from "../git.js";
import type { GraphifyRunner, GraphifySetupRunner } from "../graphify.js";
import type { LocalKnowledgeBase } from "../knowledge.js";
import type { RunStore } from "../store.js";
import type { TrackerPort } from "../tracker.js";
import {
  createApplicationDependencies,
  type ApplicationDependencies,
  type HarnessDependencies,
} from "./dependencies.js";
import {
  runCancellationRegistry,
  type RunCancellationRegistry,
} from "./cancellation-registry.js";
export type { HarnessDependencies, ApplicationDependencies };

/** Shared ports, clock/command seams, and cross-cutting run helpers. */
export class ApplicationContext {
  readonly store: RunStore;
  readonly knowledge: LocalKnowledgeBase;
  readonly tracker: TrackerPort;
  readonly git: GitService;
  readonly agents: AgentCoordinator;
  readonly deps: ApplicationDependencies;
  readonly graphifyRunner: GraphifyRunner;
  readonly graphifySetupRunner?: GraphifySetupRunner;
  readonly sleep: (ms: number) => Promise<void>;
  readonly cancellation: RunCancellationRegistry;
  phaseStepper: ((state: RunState) => Promise<RunState>) | undefined;

  constructor(
    readonly config: HarnessConfig,
    dependencies: HarnessDependencies,
    cancellation: RunCancellationRegistry = runCancellationRegistry,
  ) {
    this.deps = createApplicationDependencies(config, dependencies);
    this.store = this.deps.store;
    this.knowledge = this.deps.knowledge;
    this.tracker = this.deps.tracker;
    this.git = this.deps.git;
    this.agents = this.deps.agents;
    this.graphifyRunner = this.deps.graphifyRunner;
    this.graphifySetupRunner = this.deps.graphifySetupRunner;
    this.sleep = this.deps.sleep;
    this.cancellation = cancellation;
  }

  setPhaseStepper(stepper: (state: RunState) => Promise<RunState>): void {
    this.phaseStepper = stepper;
  }

  signalFor(runId: string): AbortSignal | undefined {
    return this.cancellation.signalFor(runId);
  }

  cancelRequestPath(runId: string): string {
    return path.join(this.store.runDirectory(runId), "cancel.request");
  }

  stopRequestPath(runId: string): string {
    return path.join(this.store.runDirectory(runId), "stop.request");
  }

  async writeCancelRequest(runId: string): Promise<void> {
    await writeFile(
      this.cancelRequestPath(runId),
      JSON.stringify({
        at: new Date().toISOString(),
        by: `${localHostname()}:${process.pid}`,
      }),
      "utf8",
    );
  }

  async writeStopRequest(runId: string): Promise<void> {
    await writeFile(
      this.stopRequestPath(runId),
      JSON.stringify({
        at: new Date().toISOString(),
        by: `${localHostname()}:${process.pid}`,
      }),
      "utf8",
    );
  }

  async clearCancelRequest(runId: string): Promise<void> {
    await unlink(this.cancelRequestPath(runId)).catch(() => undefined);
  }

  async clearStopRequest(runId: string): Promise<void> {
    await unlink(this.stopRequestPath(runId)).catch(() => undefined);
  }

  async cancelRequestPresent(runId: string): Promise<boolean> {
    try {
      await access(this.cancelRequestPath(runId));
      return true;
    } catch {
      return false;
    }
  }

  async stopRequestPresent(runId: string): Promise<boolean> {
    try {
      await access(this.stopRequestPath(runId));
      return true;
    } catch {
      return false;
    }
  }

  async isCancelRequested(runId: string): Promise<boolean> {
    if (this.signalFor(runId)?.aborted) return true;
    return this.cancelRequestPresent(runId);
  }

  async isStopRequested(runId: string, state: RunState): Promise<boolean> {
    if (state.stopAfterTask) return true;
    return this.stopRequestPresent(runId);
  }

  commandEnvironmentOptions(): {
    passEnv: string[];
    protectedEnvNames: string[];
  } {
    return {
      passEnv: this.config.commands.passEnv,
      // The embedding key name is configurable, so include it in the hard
      // deny-list in addition to built-in provider credential names.
      protectedEnvNames: [this.config.knowledge.embeddings.apiKeyEnv],
    };
  }

  async withTreeFingerprint(state: RunState): Promise<RunState> {
    if (!this.config.git.enabled) return state;
    return { ...state, treeFingerprint: await this.git.treeFingerprint() };
  }

  /** Throws HarnessFailure when the working tree no longer matches the last stamped fingerprint. */

  async assertTreeFingerprint(state: RunState): Promise<void> {
    if (!this.config.git.enabled || !state.treeFingerprint) return;
    const observed = await this.git.treeFingerprint();
    if (observed === state.treeFingerprint) return;
    const recorded = new Set(state.tasks.flatMap((task) => task.changedFiles));
    const current = await this.git.changedFiles();
    const diverging = current.filter((file) => !recorded.has(file));
    const listed = diverging.length > 0 ? diverging : current;
    throw new HarnessFailure(
      `Working tree diverged from the harness's last known state. Diverging paths: ${
        listed.length > 0 ? listed.join(", ") : "(HEAD or index changed with no dirty paths)"
      }`,
      "workspace",
      true,
    );
  }

  async syncArtifacts(state: RunState): Promise<void> {
    await this.tracker.sync(state);
  }

  async releaseImplementerSession(task: BuildTask): Promise<BuildTask> {
    if (!task.implementerSession) return task;
    await this.agents
      .releaseProviderSession(task.implementerSession.providerSessionId)
      .catch(() => undefined);
    return { ...task, implementerSession: undefined };
  }

  async releaseAllImplementerSessions(state: RunState): Promise<RunState> {
    const tasks: BuildTask[] = [];
    for (const task of state.tasks) {
      tasks.push(await this.releaseImplementerSession(task));
    }
    return { ...state, tasks };
  }
}
