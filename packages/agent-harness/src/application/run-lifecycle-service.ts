import { randomUUID } from "node:crypto";
import { CONFIG_VERSION, configurationHash } from "../config/schema.js";
import { loadRunWorkspace, writeRunWorkspace } from "../config/io.js";
import { createRunState, type RunState } from "../domain.js";
import { clearBlock } from "../domain/policies.js";
import { HarnessFailure } from "../errors.js";
import type { ApplicationContext } from "./application-context.js";
import { freezeRunComponents } from "./component-freeze.js";
import type { RecoveryService } from "./recovery-service.js";
import { recordBlockedFromNew } from "./run-setup.js";
import { assertDockerExecutionReady } from "./execution-runtime-status.js";
import {
  EXECUTION_IMAGE_APPROVAL_REQUIRED_MESSAGE,
  ensureExecutionImageForRun,
} from "./execution-image-service.js";

export class RunLifecycleService {
  constructor(
    private readonly ctx: ApplicationContext,
    private readonly _recovery: RecoveryService,
  ) {}

  async start(
    idea: string,
    runId: string = randomUUID(),
    refreshKnowledge = true,
    prepareRepositoryIntelligence = true,
  ): Promise<RunState> {
    if (!idea.trim()) throw new Error("Idea cannot be empty");
    const dockerRuntime = (this.ctx.config.execution?.runtime ?? "local") === "docker";
    if (dockerRuntime) {
      // Fail closed when Docker/daemon/image policy cannot support a new Docker run.
      await assertDockerExecutionReady({
        config: this.ctx.config,
        docker: this.ctx.docker,
        repositoryRoot: this.ctx.paths.controlRoot,
        collectEvidence: true,
      });
    }
    await this.ctx.store.initialize();
    let state = createRunState(
      runId,
      idea,
      new Date().toISOString(),
      configurationHash(this.ctx.config),
      CONFIG_VERSION,
    );
    await this.ctx.store.create(state);
    await this.ctx.store.writeJson(runId, "config.json", {
      ...this.ctx.config,
      configVersion: CONFIG_VERSION,
    });
    await this.freezeEffectiveComponents(runId);
    this.ctx.agents.assertIsolationBoundary(this.ctx.projectContext?.home.homeRoot);
    state = await this.ctx.store.record(state, "run.created", { idea: idea.trim() });
    // Worktree add takes the short workspace-admin lock inside WorktreeManager.
    // Shared knowledge refresh takes the shared-index lock. No repository lock on start.
    try {
      if (dockerRuntime) {
        await this.assertExecutionImageReady(runId);
      }
      if (this.ctx.config.git.enabled) {
        state = await this.prepareGitWorkspace(state);
      } else {
        const workspace = {
          version: 1 as const,
          kind: "git-disabled" as const,
          controlRoot: this.ctx.paths.controlRoot,
          createdAt: new Date().toISOString(),
        };
        await writeRunWorkspace(this.ctx.config, runId, workspace);
        this.ctx.bindWorkspace(workspace);
      }
      if (
        prepareRepositoryIntelligence &&
        this.ctx.config.knowledge.repositoryIntelligence.enabled
      ) {
        // Docker clones install clone-local excludes during seed init and run RI
        // inside the worker against /workspace — never touch the control repo exclude.
        if (this.ctx.workspace.kind !== "docker-clone") {
          await this.ctx.store.withWorkspaceAdminLock(
            { runId, action: "ensure-repository-intelligence-ignore" },
            () => this.ctx.git.ensureRepositoryIntelligenceArtifactsIgnored(),
          );
          await this.ctx.knowledge.prepareRepositoryIntelligence();
        }
      }
      if (refreshKnowledge) {
        await this.ctx.withSharedIndexLock({ runId, action: "refresh-knowledge" }, () =>
          this.ctx.knowledge.refresh(),
        );
      }
    } catch (error) {
      state = await recordBlockedFromNew(this.ctx.store, state, error);
    }
    await this.ctx.syncArtifacts(state);
    return state;
  }

  status(runId: string): Promise<RunState> {
    return this.ctx.store.load(runId);
  }

  /**
   * After operator Approve & build (or cache reuse), stamp digest and create the
   * Docker clone when workspace.json is still missing. Clears blocked-from-new.
   */
  async ensureDockerWorkspaceReady(runId: string): Promise<RunState> {
    let state = await this.ctx.store.load(runId);
    const dockerRuntime = (this.ctx.config.execution?.runtime ?? "local") === "docker";
    if (!dockerRuntime) return state;

    await this.assertExecutionImageReady(runId);

    const hasWorkspace = await this.hasRunWorkspace(runId);
    if (!hasWorkspace) {
      if (!this.ctx.config.git.enabled) {
        const workspace = {
          version: 1 as const,
          kind: "git-disabled" as const,
          controlRoot: this.ctx.paths.controlRoot,
          createdAt: new Date().toISOString(),
        };
        await writeRunWorkspace(this.ctx.config, runId, workspace);
        this.ctx.bindWorkspace(workspace);
      } else {
        state = await this.prepareGitWorkspace(state);
      }
    }

    if (state.phase === "blocked" && state.blockedFrom === "new") {
      state = await this.ctx.store.record(
        clearBlock(state, "new"),
        "run.execution_image_ready",
        { runId },
      );
    }
    await this.ctx.syncArtifacts(state);
    return state;
  }

  private async assertExecutionImageReady(runId: string): Promise<void> {
    const ensured = await ensureExecutionImageForRun({
      config: this.ctx.config,
      stateRoot: this.ctx.paths.stateRoot,
      runId,
      projectStateRoot: this.ctx.projectContext?.paths.projectStateRoot,
      repositoryRoot: this.ctx.paths.controlRoot,
      docker: this.ctx.docker,
      dockerPolicy: this.ctx.config.execution.docker,
    });
    if (ensured.status === "blocked") {
      throw new HarnessFailure(ensured.reason, "execution", false);
    }
    if (ensured.status === "needs-approval") {
      throw new HarnessFailure(EXECUTION_IMAGE_APPROVAL_REQUIRED_MESSAGE, "execution", true);
    }
  }

  private async hasRunWorkspace(runId: string): Promise<boolean> {
    try {
      await loadRunWorkspace(this.ctx.config, runId);
      return true;
    } catch (error) {
      if (error instanceof HarnessFailure && /workspace metadata is missing/i.test(error.message)) {
        return false;
      }
      throw error;
    }
  }

  /**
   * New Git-enabled runs get a detached worktree (local) or seed-bundle clone (Docker).
   */
  private async prepareGitWorkspace(state: RunState): Promise<RunState> {
    let workspace;
    try {
      workspace = await this.ctx.workspaceProvisioner.create({
        runId: state.runId,
        baseBranch: this.ctx.config.git.baseBranch,
      });
      await writeRunWorkspace(this.ctx.config, state.runId, workspace);
      this.ctx.bindWorkspace(workspace);
    } catch (error) {
      // LocalWorktreeProvisioner/WorktreeManager.create already reconciles a just-registered clean worktree.
      throw error;
    }

    state = await this.ctx.store.record(
      state,
      "run.worktree_created",
      {
        baseBranch:
          workspace.kind === "git-worktree" || workspace.kind === "docker-clone"
            ? workspace.baseBranch
            : undefined,
        baseSha:
          workspace.kind === "git-worktree" || workspace.kind === "docker-clone"
            ? workspace.baseSha
            : undefined,
        // Paths stay in workspace.json; event carries only non-sensitive coordinates.
        kind: workspace.kind,
      },
    );

    return state;
  }

  private async freezeEffectiveComponents(runId: string): Promise<void> {
    const project = this.ctx.projectContext;
    if (!project) return;
    await freezeRunComponents({
      runId,
      runsRoot: project.paths.runsRoot,
      project: project.paths,
      home: project.home,
      config: this.ctx.config,
    });
  }
}
