import { randomUUID } from "node:crypto";
import { CONFIG_VERSION, configurationHash } from "../config.js";
import { createRunState, isTerminalPhase, type RunState } from "../domain.js";
import { classifyFailure, HarnessFailure } from "../errors.js";
import { prepareGraphifyForRun } from "../graphify.js";
import type { ApplicationContext } from "./application-context.js";
import {
  defaultPreflightCommitMessage,
  dirtyTreeMessage,
  preflightCommitDetail,
} from "./helpers.js";
import type { RecoveryService } from "./recovery-service.js";

const terminal = isTerminalPhase;

export class RunLifecycleService {
  constructor(
    private readonly ctx: ApplicationContext,
    private readonly recovery: RecoveryService,
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
    state = await this.ctx.store.record(state, "run.created", { idea: idea.trim() });
    // Lock ordering: repository → run, always (avoid deadlock with paths that take both).
    await this.ctx.store.withRepositoryLock({ runId, action: "start" }, async () => {
      try {
        // Same changedFiles() source ensureRunBranch guards later; fail before burning a run.
        if (this.ctx.config.git.enabled) {
          const dirty = await this.ctx.git.changedFiles();
          if (dirty.length > 0) {
            if (!this.ctx.config.git.autoCommitPreflight) {
              throw new HarnessFailure(dirtyTreeMessage(dirty), "workspace", true);
            }
            const order = this.ctx.config.git.preflightCommitOrder;
            const commit = await this.recovery.runPreflightCommit(runId, order, defaultPreflightCommitMessage(runId));
            state = await this.ctx.store.record(
              {
                ...state,
                branchName: commit.runBranch ?? state.branchName,
                treeFingerprint: await this.ctx.git.treeFingerprint(),
              },
              "run.preflight_committed",
              preflightCommitDetail(order, commit, true),
            );
          }
        }
        if (prepareGraphify && this.ctx.config.knowledge.graphify.enabled) {
          if (this.ctx.graphifySetupRunner) {
            await prepareGraphifyForRun(
              this.ctx.config,
              this.ctx.graphifyRunner,
              this.ctx.graphifySetupRunner,
            );
          } else {
            await prepareGraphifyForRun(this.ctx.config, this.ctx.graphifyRunner);
          }
        }
        if (refreshKnowledge) await this.ctx.knowledge.refresh();
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
    });
    await this.ctx.syncArtifacts(state);
    return state;
  }

  status(runId: string): Promise<RunState> {
    return this.ctx.store.load(runId);
  }
}
