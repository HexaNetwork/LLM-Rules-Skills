import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { CONFIG_VERSION, configurationHash, writeRunWorkspace } from "../config.js";
import { createRunState, type RunState } from "../domain.js";
import { classifyFailure } from "../errors.js";
import { prepareGraphifyForRun } from "../graphify.js";
import { WorktreeManager } from "../git/worktree-manager.js";
import type { ApplicationContext } from "./application-context.js";
import { freezeRunComponents } from "./component-freeze.js";
import type { RecoveryService } from "./recovery-service.js";

export class RunLifecycleService {
  constructor(
    private readonly ctx: ApplicationContext,
    private readonly _recovery: RecoveryService,
  ) {}

  async start(
    idea: string,
    runId: string = randomUUID(),
    refreshKnowledge = true,
    prepareGraphify = true,
  ): Promise<RunState> {
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
    // Worktree add takes the short workspace-admin lock inside WorktreeManager.
    // Shared knowledge refresh takes the shared-index lock. No repository lock on start.
    try {
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
      if (prepareGraphify && this.ctx.config.knowledge.graphify.enabled) {
        await prepareGraphifyForRun(this.ctx.config, this.ctx.graphifyRunner, this.ctx.paths);
      }
      if (refreshKnowledge) {
        await this.ctx.withSharedIndexLock({ runId, action: "refresh-knowledge" }, () =>
          this.ctx.knowledge.refresh(),
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const classified = classifyFailure(error);
      state = await this.ctx.store.record(
        {
          ...state,
          phase: "blocked",
          blockedFrom: "new",
          failure: message,
          blockedKind: classified.kind,
          blockedRetriable: classified.retriable,
        },
        "run.blocked",
        {
          blockedFrom: "new",
          error: message,
          blockedKind: classified.kind,
          blockedRetriable: classified.retriable,
        },
      );
    }
    await this.ctx.syncArtifacts(state);
    return state;
  }

  status(runId: string): Promise<RunState> {
    return this.ctx.store.load(runId);
  }

  /**
   * New Git-enabled runs get a detached worktree at baseSha.
   * Legacy shared-checkout semantics remain only for resumed runs without workspace.json.
   */
  private async prepareGitWorkspace(state: RunState): Promise<RunState> {
    const manager = new WorktreeManager({
      controlRoot: this.ctx.paths.controlRoot,
      stateRoot: this.ctx.paths.stateRoot,
      worktreeRoot: this.ctx.paths.worktreeRoot,
      store: this.ctx.store,
    });

    let workspace;
    try {
      workspace = await manager.create({
        runId: state.runId,
        baseBranch: this.ctx.config.git.baseBranch,
      });
      await writeRunWorkspace(this.ctx.config, state.runId, workspace);
      this.ctx.bindWorkspace(workspace);
    } catch (error) {
      // WorktreeManager.create already reconciles a just-registered clean worktree.
      throw error;
    }

    state = await this.ctx.store.record(
      state,
      "run.worktree_created",
      {
        baseBranch: workspace.baseBranch,
        baseSha: workspace.baseSha,
        // Paths stay in workspace.json; event carries only non-sensitive coordinates.
        kind: workspace.kind,
      },
    );

    const dirtyPaths = await controlCheckoutDirtyPaths(this.ctx.paths.controlRoot);
    if (dirtyPaths.length > 0) {
      const shown = dirtyPaths.slice(0, 10);
      const more =
        dirtyPaths.length > shown.length ? ` (+${dirtyPaths.length - shown.length} more)` : "";
      state = await this.ctx.store.record(state, "run.control_checkout_notice", {
        dirty: true,
        includedInRun: false,
        pathCount: dirtyPaths.length,
        message:
          "Control checkout has uncommitted changes that are not included in this run. " +
          `The run starts from the committed base ${workspace.baseBranch ?? "branch"}` +
          (workspace.baseSha ? ` @ ${workspace.baseSha.slice(0, 12)}` : "") +
          `. Dirty paths: ${shown.join(", ")}${more}. Commit those changes yourself if you need them in a run.`,
      });
    }
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

/** Porcelain paths in the operator control checkout (not the run worktree). */
async function controlCheckoutDirtyPaths(controlRoot: string): Promise<string[]> {
  const result = await new Promise<{ exitCode: number; stdout: string }>((resolve, reject) => {
    const child = spawn(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all", "-z"],
      {
        cwd: controlRoot,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString("utf8")}`.slice(-200_000);
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout }));
  });
  if (result.exitCode !== 0 || !result.stdout) return [];
  const paths: string[] = [];
  for (const entry of result.stdout.split("\0")) {
    if (entry.length < 4) continue;
    const filePath = entry.slice(3).replace(/\0.*/, "").trim();
    if (filePath) paths.push(filePath.replaceAll("\\", "/"));
  }
  return paths;
}
