import { access, unlink, writeFile } from "node:fs/promises";
import { hostname as localHostname } from "node:os";
import path from "node:path";
import type { AgentCoordinator } from "../infrastructure/agents/agent-coordinator.js";
import { loadRunWorkspace } from "../config/io.js";
import type { HarnessConfig } from "../config/schema.js";
import type { BuildTask, RunState } from "../domain.js";
import { HarnessFailure } from "../errors.js";
import type { GitService } from "../git.js";
import type {
  ExecutableRunner,
  RepositoryIntelligenceBroker,
} from "../infrastructure/repository-intelligence/index.js";
import type { LocalKnowledgeBase } from "../knowledge.js";
import type { RunStore } from "../store.js";
import type { TrackerPort } from "../tracker.js";
import {
  diffWorkspaceEvidence,
  formatWorkspaceDivergenceMessage,
  WORKSPACE_SCHEMA_VERSION,
  type RunWorkspace,
  type WorkspaceEvidence,
} from "../domain/workspace.js";
import {
  createApplicationDependencies,
  type ApplicationDependencies,
  type HarnessDependencies,
  type ProjectContext,
} from "./dependencies.js";
import {
  runCancellationRegistry,
  type RunCancellationRegistry,
} from "./cancellation-registry.js";
import { applyWorkspaceToPaths, type HarnessPaths } from "./paths.js";
export type { HarnessDependencies, ApplicationDependencies, ProjectContext };
export type { HarnessPaths } from "./paths.js";

/** Shared ports, clock/command seams, and cross-cutting run helpers. */
export class ApplicationContext {
  readonly paths: HarnessPaths;
  readonly store: RunStore;
  readonly knowledge: LocalKnowledgeBase;
  readonly tracker: TrackerPort;
  readonly git: GitService;
  readonly agents: AgentCoordinator;
  readonly deps: ApplicationDependencies;
  readonly repositoryIntelligence: RepositoryIntelligenceBroker;
  readonly repositoryIntelligenceRunner: ExecutableRunner;
  readonly sleep: (ms: number) => Promise<void>;
  readonly cancellation: RunCancellationRegistry;
  readonly projectContext?: ProjectContext;
  workspace: RunWorkspace;
  phaseStepper: ((state: RunState) => Promise<RunState>) | undefined;

  constructor(
    readonly config: HarnessConfig,
    dependencies: HarnessDependencies,
    cancellation: RunCancellationRegistry = runCancellationRegistry,
  ) {
    this.deps = createApplicationDependencies(config, dependencies);
    this.paths = this.deps.paths;
    this.store = this.deps.store;
    this.knowledge = this.deps.knowledge;
    this.tracker = this.deps.tracker;
    this.git = this.deps.git;
    this.agents = this.deps.agents;
    this.repositoryIntelligence = this.deps.repositoryIntelligence;
    this.repositoryIntelligenceRunner = this.deps.repositoryIntelligenceRunner;
    this.sleep = this.deps.sleep;
    this.projectContext = this.deps.projectContext;
    this.cancellation = cancellation;
    this.workspace = config.git.enabled
      ? {
          version: WORKSPACE_SCHEMA_VERSION,
          kind: "git-worktree",
          controlRoot: this.paths.controlRoot,
          createdAt: new Date().toISOString(),
        }
      : {
          version: WORKSPACE_SCHEMA_VERSION,
          kind: "git-disabled",
          controlRoot: this.paths.controlRoot,
          createdAt: new Date().toISOString(),
        };
    applyWorkspaceToPaths(this.paths, this.workspace);
  }

  /** Point execution roots at a recorded/created run workspace. */
  bindWorkspace(workspace: RunWorkspace): void {
    this.workspace = workspace;
    applyWorkspaceToPaths(this.paths, workspace);
  }

  usesGitWorktree(): boolean {
    return this.workspace.kind === "git-worktree";
  }

  /**
   * Bind durable workspace identity, then take the run lock for a mutating operation.
   */
  async withMutatingRunLock<T>(
    runId: string,
    action: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const workspace = await loadRunWorkspace(this.config, runId);
    this.bindWorkspace(workspace);
    return this.store.withLock(runId, work);
  }

  /** Serialize shared knowledge-index refreshes across runs. */
  withSharedIndexLock<T>(
    holder: { runId: string; action: string },
    work: () => Promise<T>,
  ): Promise<T> {
    return this.store.withSharedIndexLock(holder, work);
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

  /** Stamp structured workspace evidence (and legacy-compatible treeFingerprint). */
  async withTreeFingerprint(state: RunState): Promise<RunState> {
    if (!this.config.git.enabled) return state;
    const stamped = await this.stampWorkspaceEvidence();
    return { ...state, ...stamped };
  }

  async stampWorkspaceEvidence(): Promise<{
    workspaceEvidence: WorkspaceEvidence;
    treeFingerprint: string;
  }> {
    const workspaceEvidence = await this.git.workspaceEvidence();
    return {
      workspaceEvidence,
      treeFingerprint: workspaceEvidence.fingerprint,
    };
  }

  /**
   * Throws HarnessFailure when this run's worktree no longer matches the last stamp.
   * Structured evidence yields component-level diagnostics.
   */
  async assertTreeFingerprint(state: RunState): Promise<void> {
    if (!this.config.git.enabled) return;
    if (!state.workspaceEvidence && !state.treeFingerprint) return;

    if (state.workspaceEvidence) {
      const observed = await this.git.workspaceEvidence();
      if (observed.fingerprint === state.workspaceEvidence.fingerprint) return;
      const diff = diffWorkspaceEvidence(state.workspaceEvidence, observed);
      const message = formatWorkspaceDivergenceMessage(diff, observed);
      await this.store
        .record(state, "run.workspace_diverged", {
          components: {
            head: diff.head,
            index: diff.index,
            workingFiles: diff.workingFiles,
          },
          changedPaths: diff.changedPaths,
          omittedCount: diff.omittedCount,
          previousFingerprint: state.workspaceEvidence.fingerprint,
          observedFingerprint: observed.fingerprint,
        })
        .catch(() => undefined);
      throw new HarnessFailure(message, "workspace", true);
    }

    // Versioned fingerprint without structured fields (partial stamp).
    const observed = await this.git.workspaceEvidence();
    if (observed.fingerprint === state.treeFingerprint) return;
    const current = await this.git.changedFiles();
    throw new HarnessFailure(
      `Workspace diverged in this run's worktree. Diverging paths: ${
        current.length > 0 ? current.join(", ") : "(HEAD or index changed with no dirty paths)"
      }`,
      "workspace",
      true,
    );
  }

  async syncArtifacts(state: RunState): Promise<void> {
    await this.tracker.sync(state);
  }

  /** Release any retained worker sessions for a finished task. */
  async releaseTaskWorkerSessions(task: BuildTask): Promise<BuildTask> {
    await this.agents
      .releaseProviderSession(task.implementerSession?.providerSessionId)
      .catch(() => undefined);
    if (!task.implementerSession) return task;
    return { ...task, implementerSession: undefined };
  }

  async releaseAllTaskWorkerSessions(state: RunState): Promise<RunState> {
    const tasks: BuildTask[] = [];
    for (const task of state.tasks) {
      tasks.push(await this.releaseTaskWorkerSessions(task));
    }
    return { ...state, tasks };
  }
}
