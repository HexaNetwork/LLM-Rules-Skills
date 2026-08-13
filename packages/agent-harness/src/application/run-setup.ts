import type { HarnessConfig } from "../config/schema.js";
import type { RunState } from "../domain.js";
import { classifyFailure } from "../errors.js";
import { prepareCodegraphForRun, type CodegraphRunner } from "../codegraph.js";
import type { RunStore } from "../store.js";
import type { HarnessPaths } from "./paths.js";

const TERMINAL_PHASES = new Set(["blocked", "cancelled", "completed"]);

export async function recordBlockedFromNew(
  store: RunStore,
  state: RunState,
  error: unknown,
): Promise<RunState> {
  const message = error instanceof Error ? error.message : String(error);
  const classified = classifyFailure(error);
  return store.record(
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

export type InitialRunSetupOptions = {
  runId: string;
  config: HarnessConfig;
  store: RunStore;
  paths: HarnessPaths;
  codegraphRunner?: CodegraphRunner;
  git: { ensureCodegraphOutputIgnored(): Promise<void> };
  knowledge: {
    refresh(onProgress?: (progress: { message: string }) => void): Promise<unknown>;
  };
  advance: () => Promise<unknown>;
  onProgress?: (message: string) => void;
};

/**
 * CodeGraph → knowledge refresh → advance for a run that has not left `new`.
 * Records `run.blocked` from `new` when setup fails, then rethrows.
 */
export async function runInitialSetupThenAdvance(options: InitialRunSetupOptions): Promise<void> {
  try {
    const latest = await options.store.load(options.runId);
    if (TERMINAL_PHASES.has(latest.phase)) return;
    if (options.config.knowledge.codegraph.enabled) {
      options.onProgress?.("Checking CodeGraph for this project");
      await options.store.withWorkspaceAdminLock(
        { runId: options.runId, action: "ensure-codegraph-ignore" },
        () => options.git.ensureCodegraphOutputIgnored(),
      );
      const codegraphReady = await prepareCodegraphForRun(
        options.config,
        options.codegraphRunner,
        options.paths,
      );
      if (codegraphReady.enabled) {
        options.onProgress?.(
          codegraphReady.setupRan
            ? "Repository graph built and ready"
            : "CodeGraph repository index is ready",
        );
      }
    }
    const beforeIndex = await options.store.load(options.runId);
    if (TERMINAL_PHASES.has(beforeIndex.phase)) return;
    await options.store.withSharedIndexLock({ runId: options.runId, action: "refresh-knowledge" }, () =>
      options.knowledge.refresh((progress) => {
        options.onProgress?.(progress.message);
      }),
    );
    const beforeAdvance = await options.store.load(options.runId);
    if (TERMINAL_PHASES.has(beforeAdvance.phase)) return;
    await options.advance();
  } catch (error) {
    const state = await options.store.load(options.runId);
    if (state.phase === "new") {
      await recordBlockedFromNew(options.store, state, error);
    }
    throw error;
  }
}
