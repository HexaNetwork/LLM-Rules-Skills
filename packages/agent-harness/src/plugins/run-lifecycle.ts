import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import { workingOn, type RunWorking } from "../domain/working.js";
import { recoverFinalizedWorker } from "./agents.js";
import { summarizeSessionUsage, type SessionUsageReport } from "../domain/session-usage.js";
import type {
  AgentInvocation,
  AnswerBatch,
  AdvanceInput,
  PhaseResult,
  ProjectRegistration,
  Run,
  RunIdentity,
  RunState,
  StartInput,
} from "../domain/types.js";

export type RunLifecycleService = {
  addProject(controlRoot: string): Promise<ProjectRegistration>;
  listProjects(): Promise<ProjectRegistration[]>;
  start(input: StartInput): Promise<Run>;
  continue(runId: string): Promise<Run>;
  answer(runId: string, batch: AnswerBatch): Promise<Run>;
  retry(runId: string): Promise<Run>;
  cancel(runId: string): Promise<Run>;
  delete(runId: string): Promise<{ deleted: string }>;
  status(runId: string): Promise<Run>;
  list(): Promise<Run[]>;
  activity(runId: string): Promise<unknown[]>;
  sessions(runId: string): Promise<unknown[]>;
  sessionEvents(runId: string, sessionId: string): Promise<unknown[]>;
  usage(runId: string): Promise<SessionUsageReport>;
};

export function createRunLifecycle(ctx: Context): RunLifecycleService {
  const attachWorking = async (run: Run): Promise<Run> => {
    const working = await ctx.store.readProgress(run.identity.runId);
    if (!working) {
      delete run.state.working;
      return run;
    }
    const age = Date.now() - Date.parse(working.startedAt);
    run.state.working =
      working.status !== "reconciling" && Number.isFinite(age) && age > 45_000
        ? { ...working, status: "stalled" }
        : working;
    return run;
  };

  const load = async (runId: string): Promise<Run> => {
    const identity = await ctx.store.readIdentity(runId);
    const state = await ctx.store.readState(runId);
    if (!identity || !state) throw new Error(`Unknown run: ${runId}`);
    const settings = await ctx.settings.readLive(identity.projectKey);
    return attachWorking({ identity, state, settings });
  };

  const setWorking = async (runId: string, working: RunWorking): Promise<void> => {
    await ctx.store.writeProgress(runId, working);
  };

  const clearWorking = async (runId: string): Promise<void> => {
    await ctx.store.clearProgress(runId);
  };

  const persist = async (run: Run): Promise<void> => {
    run.state.revision += 1;
    run.state.updatedAt = new Date().toISOString();
    await ctx.store.writeState(run.state);
    await ctx.store.appendEvent(run.identity.runId, {
      at: run.state.updatedAt,
      revision: run.state.revision,
      status: run.state.status,
      phase: run.state.phase,
    });
  };

  const apply = async (
    run: Run,
    result: PhaseResult,
    hops = 0,
    advanceReason: AdvanceInput["reason"] = "continue",
  ): Promise<Run> => {
    if (hops > run.settings.workflow.maxPhaseHopsPerAdvance) {
      run.state.status = "blocked";
      run.state.block = { reason: "Phase hop budget exceeded", retriable: true };
      await persist(run);
      return run;
    }
    if (result.kind === "await") {
      run.state.status = "awaiting_input";
      run.state.gate = result.gate;
      run.state.block = undefined;
      await persist(run);
      return run;
    }
    if (result.kind === "block") {
      run.state.status = "blocked";
      run.state.block = { reason: result.reason, retriable: result.retriable };
      await persist(run);
      return run;
    }
    const next =
      result.kind === "continue" && result.next
        ? result.next
        : ctx.workflow.nextPhase(run.identity.workflowBundleId, run.state.phase);
    if (!next) {
      run.state.status = "completed";
      run.state.gate = undefined;
      run.state.block = undefined;
      await ctx.sandbox.destroy(run.identity.runId);
      await persist(run);
      return run;
    }
    if (!ctx.workflow.includes(run.identity.workflowBundleId, next)) {
      run.state.status = "blocked";
      run.state.block = { reason: `Workflow cannot enter phase "${next}"`, retriable: false };
      await persist(run);
      return run;
    }
    run.state.phase = next;
    run.state.status = "active";
    run.state.gate = undefined;
    run.state.block = undefined;
    const phase = ctx.phases.get(next);
    await setWorking(run.identity.runId, workingOn(`Entering ${next}`, { phase: next }));
    await phase.enter?.(run);
    await persist(run);
    await setWorking(run.identity.runId, workingOn(`Running ${next}`, { phase: next }));
    try {
      const again = await phase.advance(run, { reason: advanceReason });
      return apply(run, again, hops + 1, advanceReason);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return apply(
        run,
        {
          kind: "block",
          reason: `Agent failed during ${next}: ${detail}`,
          retriable: true,
        },
        hops,
        advanceReason,
      );
    }
  };

  const withLiveSettings = async (
    runId: string,
    source: "start" | "advance" | "answer" | "retry",
    body: (run: Run) => Promise<Run>,
  ): Promise<Run> => {
    const run = await load(runId);
    run.settings = await ctx.settings.readLive(run.identity.projectKey);
    await ctx.settings.audit(runId, source === "advance" ? "advance" : source, run.settings);
    return body(run);
  };

  const withWorkingScope = async (
    runId: string,
    initial: RunWorking,
    body: () => Promise<Run>,
  ): Promise<Run> => {
    await setWorking(runId, initial);
    try {
      return await body();
    } finally {
      await clearWorking(runId);
    }
  };

  return {
    addProject: (controlRoot) => ctx.projects.add(controlRoot),
    listProjects: () => ctx.projects.list(),
    async start(input) {
      const registration = await ctx.projects.resolve(input);
      const workflowBundleId = input.workflowBundleId ?? "default";
      const first = ctx.workflow.firstPhase(workflowBundleId);
      const runId = randomUUID();
      await setWorking(runId, workingOn("Updating base branch", { phase: first }));
      try {
        const requested = input.baseBranch?.trim();
        const baseBranch =
          requested ||
          (await ctx.git.listLocalBranches(registration.controlRoot)).current ||
          "";
        if (!baseBranch) throw new Error("baseBranch is required");
        const { worktreePath, baseSha } = await ctx.git.createWorktree(
          registration,
          runId,
          baseBranch,
        );
        const identity: RunIdentity = {
          runId,
          projectKey: registration.projectKey,
          workflowBundleId,
          controlRoot: registration.controlRoot,
          worktreePath,
          baseSha,
          baseBranch,
          createdAt: new Date().toISOString(),
        };
        const settings = await ctx.settings.readLive(registration.projectKey);
        const state: RunState = {
          runId,
          status: "active",
          phase: first,
          idea: input.idea,
          revision: 0,
          updatedAt: identity.createdAt,
          artifacts: {},
          fog: [],
          tasks: [],
        };
        await ctx.store.writeIdentity(identity);
        await ctx.store.writeState(state);
        await ctx.settings.audit(runId, "start", settings);
        const run: Run = { identity, state, settings };
        const phase = ctx.phases.get(first);
        await setWorking(runId, workingOn(`Entering ${first}`, { phase: first }));
        await phase.enter?.(run);
        await setWorking(runId, workingOn(`Running ${first}`, { phase: first }));
        let result: PhaseResult;
        try {
          result = await phase.advance(run, { reason: "start" });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          result = {
            kind: "block",
            reason: `Agent failed during ${first}: ${detail}`,
            retriable: true,
          };
        }
        return apply(run, result, 0, "start");
      } finally {
        await clearWorking(runId);
      }
    },
    continue: (runId) =>
      withLiveSettings(runId, "advance", (run) =>
        withWorkingScope(
          runId,
          workingOn(`Continuing ${run.state.phase}`, { phase: run.state.phase }),
          async () => {
            if (run.state.status === "completed" || run.state.status === "cancelled") return run;
            await setWorking(runId, workingOn(`Running ${run.state.phase}`, { phase: run.state.phase }));
            let result: PhaseResult;
            try {
              result = await ctx.phases.get(run.state.phase).advance(run, { reason: "continue" });
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              result = {
                kind: "block",
                reason: `Agent failed during ${run.state.phase}: ${detail}`,
                retriable: true,
              };
            }
            return apply(run, result, 0, "continue");
          },
        ),
      ),
    answer: (runId, batch) =>
      withLiveSettings(runId, "answer", (run) =>
        withWorkingScope(
          runId,
          workingOn(`Applying answers for ${run.state.phase}`, { phase: run.state.phase }),
          async () => {
            const phase = ctx.phases.get(run.state.phase);
            if (!phase.onAnswer) throw new Error(`Phase "${phase.id}" does not accept answers`);
            const result = await phase.onAnswer(run, batch);
            return apply(run, result, 0, "continue");
          },
        ),
      ),
    retry: (runId) =>
      withLiveSettings(runId, "retry", (run) =>
        withWorkingScope(
          runId,
          workingOn(`Retrying ${run.state.phase}`, { phase: run.state.phase }),
          async () => {
            if (run.state.block && !run.state.block.retriable) return run;
            run.state.status = "active";
            run.state.block = undefined;
            await setWorking(runId, workingOn(`Running ${run.state.phase}`, { phase: run.state.phase }));
            let result: PhaseResult;
            try {
              result = await ctx.phases.get(run.state.phase).advance(run, { reason: "retry" });
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              result = {
                kind: "block",
                reason: `Agent failed during ${run.state.phase}: ${detail}`,
                retriable: true,
              };
            }
            return apply(run, result, 0, "retry");
          },
        ),
      ),
    async cancel(runId) {
      const run = await load(runId);
      await setWorking(runId, workingOn("Cancelling run", { phase: run.state.phase }));
      try {
        run.state.status = "cancelled";
        await ctx.sandbox.destroy(runId);
        await persist(run);
        return run;
      } finally {
        await clearWorking(runId);
      }
    },
    async delete(runId) {
      const identity = await ctx.store.readIdentity(runId);
      if (!identity) {
        const ids = await ctx.store.listRunIds();
        if (!ids.includes(runId)) throw new Error(`Unknown run: ${runId}`);
      }
      await setWorking(runId, workingOn("Deleting run", { phase: identity?.workflowBundleId }));
      try {
        await Promise.all([
          ctx.sandbox.destroy(runId, { purgeImage: true }).catch(() => undefined),
          identity ? ctx.git.removeWorktree(identity).catch(() => undefined) : Promise.resolve(),
        ]);
        await ctx.store.deleteRun(runId);
        return { deleted: runId };
      } finally {
        await clearWorking(runId).catch(() => undefined);
      }
    },
    status: load,
    async activity(runId) {
      const events = await ctx.store.readJsonl<{ kind?: string }>(`runs/${runId}/events.jsonl`);
      // Drop legacy agent_stream mirrors; streams live on session event logs.
      return events.filter((event) => event.kind !== "agent_stream");
    },
    sessions: (runId) => ctx.store.readSessions(runId),
    sessionEvents: (runId, sessionId) => ctx.store.readSessionEvents(runId, sessionId),
    async usage(runId) {
      const sessions = await ctx.store.readSessions<AgentInvocation>(runId);
      return summarizeSessionUsage(sessions);
    },
    async list() {
      const ids = await ctx.store.listRunIds();
      const runs: Run[] = [];
      for (const id of ids) {
        try {
          runs.push(await load(id));
        } catch {
          // Pre-rewrite or partial runs are ignored, not migrated.
        }
      }
      return runs;
    },
  };
}

export const runLifecyclePlugin = Object.assign(
  async (ctx: Context) => {
    ctx.provide("runLifecycle", createRunLifecycle(ctx));
    // Any invocation that predates this host process is orphaned by
    // definition. Reconcile it at startup so stale progress cannot survive a
    // coordinator restart indefinitely. Await here so short-lived CLI commands
    // finish recovery before the host context is disposed.
    await recoverOrphanedRuns(ctx);
  },
  {
    inject: ["store", "settings", "projects", "workflow", "phases", "git", "sandbox"],
  },
);

export async function recoverOrphanedRuns(ctx: Context): Promise<void> {
  for (const runId of await ctx.store.listRunIds()) {
    const [state, progress, sessions] = await Promise.all([
      ctx.store.readState(runId),
      ctx.store.readProgress(runId),
      ctx.store.readSessions<AgentInvocation>(runId),
    ]);
    if (!state || !progress || state.status !== "active") continue;
    // A second CLI/dashboard process must not reclaim work owned by a live
    // coordinator. Legacy progress has no owner and is safe to reconcile.
    if (progress.ownerPid && processIsAlive(progress.ownerPid)) continue;
    const session = [...sessions].reverse().find((entry) => entry.status === "running");
    if (!session) {
      await ctx.store.clearProgress(runId);
      continue;
    }

    await ctx.store.writeProgress(
      runId,
      workingOn(`Recovering orphaned ${session.role}`, {
        phase: session.packet.phase,
        role: session.role,
        status: "reconciling",
      }),
    );
    const events = await ctx.store.readSessionEvents<Record<string, unknown>>(
      runId,
      session.sessionId,
    );
    const recovered = recoverFinalizedWorker(events);
    const endedAt = new Date().toISOString();
    const terminal: AgentInvocation = recovered
      ? {
          ...session,
          output: recovered.output,
          telemetry: recovered.telemetry,
          endedAt,
          at: endedAt,
          status: "completed",
        }
      : {
          ...session,
          endedAt,
          at: endedAt,
          status: "failed",
          error: "Coordinator restarted before the agent invocation reached a terminal state",
        };
    await ctx.store.writeSession(runId, session.sessionId, terminal);
    await ctx.store.appendEvent(runId, {
      kind: "agent",
      at: endedAt,
      sessionId: session.sessionId,
      role: session.role,
      phase: session.packet.phase,
      status: terminal.status,
    });
    state.status = "blocked";
    state.block = {
      reason: recovered
        ? `Recovered finalized ${session.role} output after coordinator restart; retry this phase to continue safely`
        : `Recovered orphaned ${session.role} invocation after coordinator restart; retry this phase`,
      retriable: true,
    };
    state.revision += 1;
    state.updatedAt = endedAt;
    await ctx.store.writeState(state);
    await ctx.store.appendEvent(runId, {
      at: endedAt,
      revision: state.revision,
      status: state.status,
      phase: state.phase,
      recovered: true,
    });
    await ctx.sandbox.destroy(runId).catch(() => undefined);
    await ctx.store.clearProgress(runId);
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
