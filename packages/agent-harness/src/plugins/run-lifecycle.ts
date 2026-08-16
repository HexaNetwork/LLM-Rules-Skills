import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { ProjectSettings } from "../domain/settings.js";
import type {
  AnswerBatch,
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
  status(runId: string): Promise<Run>;
  list(): Promise<Run[]>;
  activity(runId: string): Promise<unknown[]>;
  sessions(runId: string): Promise<unknown[]>;
};

export function createRunLifecycle(ctx: Context): RunLifecycleService {
  const load = async (runId: string): Promise<Run> => {
    const identity = await ctx.store.readIdentity(runId);
    const state = await ctx.store.readState(runId);
    if (!identity || !state) throw new Error(`Unknown run: ${runId}`);
    const settings = await ctx.settings.readLive(identity.projectKey);
    return { identity, state, settings };
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

  const apply = async (run: Run, result: PhaseResult, hops = 0): Promise<Run> => {
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
    await phase.enter?.(run);
    await persist(run);
    const again = await phase.advance(run, { reason: "continue" });
    return apply(run, again, hops + 1);
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

  return {
    addProject: (controlRoot) => ctx.projects.add(controlRoot),
    listProjects: () => ctx.projects.list(),
    async start(input) {
      const registration = await ctx.projects.resolve(input);
      const workflowBundleId = input.workflowBundleId ?? "default";
      const first = ctx.workflow.firstPhase(workflowBundleId);
      const runId = randomUUID();
      const { worktreePath, baseSha } = await ctx.git.createWorktree(registration, runId);
      const identity: RunIdentity = {
        runId,
        projectKey: registration.projectKey,
        workflowBundleId,
        controlRoot: registration.controlRoot,
        worktreePath,
        baseSha,
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
      await phase.enter?.(run);
      const result = await phase.advance(run, { reason: "start" });
      return apply(run, result);
    },
    continue: (runId) =>
      withLiveSettings(runId, "advance", async (run) => {
        if (run.state.status === "completed" || run.state.status === "cancelled") return run;
        const result = await ctx.phases.get(run.state.phase).advance(run, { reason: "continue" });
        return apply(run, result);
      }),
    answer: (runId, batch) =>
      withLiveSettings(runId, "answer", async (run) => {
        const phase = ctx.phases.get(run.state.phase);
        if (!phase.onAnswer) throw new Error(`Phase "${phase.id}" does not accept answers`);
        const result = await phase.onAnswer(run, batch);
        return apply(run, result);
      }),
    retry: (runId) =>
      withLiveSettings(runId, "retry", async (run) => {
        if (run.state.block && !run.state.block.retriable) return run;
        run.state.status = "active";
        run.state.block = undefined;
        const result = await ctx.phases.get(run.state.phase).advance(run, { reason: "retry" });
        return apply(run, result);
      }),
    async cancel(runId) {
      const run = await load(runId);
      run.state.status = "cancelled";
      await ctx.sandbox.destroy(runId);
      await persist(run);
      return run;
    },
    status: load,
    activity: (runId) => ctx.store.readJsonl(`runs/${runId}/events.jsonl`),
    sessions: (runId) => ctx.store.readSessions(runId),
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
  (ctx: Context) => {
    ctx.provide("runLifecycle", createRunLifecycle(ctx));
  },
  {
    inject: ["store", "settings", "projects", "workflow", "phases", "git", "sandbox"],
  },
);
