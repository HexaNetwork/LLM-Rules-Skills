import { randomUUID } from "node:crypto";
import { CONFIG_VERSION, configurationHash } from "../config/schema.js";
import { createRunState, type RunState } from "../domain.js";
import { clearBlock } from "../domain/policies.js";
import { HarnessFailure } from "../errors.js";
import type { ApplicationContext } from "./application-context.js";
import { freezeRunComponents } from "./component-freeze.js";
import { recordBlockedFromNew } from "./run-setup.js";
import { assertDockerExecutionReady } from "./execution-runtime-status.js";

export class RunLifecycleService {
  constructor(private readonly ctx: ApplicationContext) {}

  async start(
    idea: string,
    runId: string = randomUUID(),
    refreshKnowledge = true,
    prepareRepositoryIntelligence = true,
  ): Promise<RunState> {
    const state = await this.create(idea, runId);
    return this.prepare(state.runId, refreshKnowledge, prepareRepositoryIntelligence);
  }

  /** Persist host-owned run state only; lifecycle preparation runs asynchronously. */
  async create(idea: string, runId: string = randomUUID()): Promise<RunState> {
    if (!idea.trim()) throw new Error("Idea cannot be empty");
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
    await this.ctx.syncArtifacts(state);
    return state;
  }

  /** Advance a newly-created run through image and workspace preparation. */
  async prepare(
    runId: string,
    refreshKnowledge = true,
    prepareRepositoryIntelligence = true,
  ): Promise<RunState> {
    let state = await this.ctx.store.load(runId);
    try {
      const inProcessTestProfile =
        process.env.VITEST === "true" &&
        !this.ctx.config.execution.docker.workerImageDigest;
      if (inProcessTestProfile) {
        const workspace = {
          version: 1 as const,
          kind: "git-disabled" as const,
          controlRoot: this.ctx.paths.controlRoot,
          createdAt: new Date().toISOString(),
        };
        await this.ctx.writeWorkspace(runId, workspace);
        this.ctx.bindWorkspace(workspace);
      } else {
        await assertDockerExecutionReady({
          config: this.ctx.config,
          docker: this.ctx.docker,
          repositoryRoot: this.ctx.paths.controlRoot,
          collectEvidence: true,
        });
        await this.assertExecutionImageReady();
      }
      if (!inProcessTestProfile && this.ctx.config.git.enabled) {
        state = await this.prepareGitWorkspace(state);
      } else if (!inProcessTestProfile) {
        const workspace = {
          version: 1 as const,
          kind: "git-disabled" as const,
          controlRoot: this.ctx.paths.controlRoot,
          createdAt: new Date().toISOString(),
        };
        await this.ctx.writeWorkspace(runId, workspace);
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
        // Host cannot index documents under the worker constant `/workspace`.
        // Docker initial setup refreshes knowledge inside the worker against the clone.
        if (this.ctx.workspace.kind !== "docker-clone") {
          await this.ctx.withSharedIndexLock({ runId, action: "refresh-knowledge" }, () =>
            this.ctx.knowledge.refresh(),
          );
        }
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
    await this.assertExecutionImageReady();

    const hasWorkspace = await this.hasRunWorkspace(runId);
    if (!hasWorkspace) {
      if (!this.ctx.config.git.enabled) {
        const workspace = {
          version: 1 as const,
          kind: "git-disabled" as const,
          controlRoot: this.ctx.paths.controlRoot,
          createdAt: new Date().toISOString(),
        };
        await this.ctx.writeWorkspace(runId, workspace);
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

  private async assertExecutionImageReady(): Promise<void> {
    const maintainedImage = this.ctx.config.execution.docker.workerImageDigest?.trim();
    if (maintainedImage) {
      if (!maintainedImage.startsWith("sha256:") && !maintainedImage.includes("@sha256:")) {
        throw new HarnessFailure(
          "Maintained worker image must be digest-pinned (sha256:… or image@sha256:…).",
          "execution",
          false,
        );
      }
      if (!(await this.ctx.docker.imageExists(maintainedImage))) {
        throw new HarnessFailure(
          `Maintained worker image is unavailable locally: ${maintainedImage}`,
          "execution",
          true,
        );
      }
      return;
    }
    throw new HarnessFailure(
      "Docker-only execution requires a maintained execution.docker.workerImageDigest; per-run image generation is retired.",
      "execution",
      false,
    );
  }

  private async hasRunWorkspace(runId: string): Promise<boolean> {
    try {
      await this.ctx.loadWorkspace(runId);
      return true;
    } catch (error) {
      if (error instanceof HarnessFailure && /workspace metadata is missing/i.test(error.message)) {
        return false;
      }
      throw error;
    }
  }

  /**
   * New Git-enabled runs get an isolated seed-bundle Docker clone.
   */
  private async prepareGitWorkspace(state: RunState): Promise<RunState> {
    let workspace;
    try {
      workspace = await this.ctx.workspaceProvisioner.create({
        runId: state.runId,
        baseBranch: this.ctx.config.git.baseBranch,
      });
      await this.ctx.writeWorkspace(state.runId, workspace);
      this.ctx.bindWorkspace(workspace);
    } catch (error) {
      throw error;
    }

    state = await this.ctx.store.record(
      state,
      "run.workspace_created",
      {
        baseBranch: workspace.baseBranch,
        baseSha: workspace.baseSha,
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
