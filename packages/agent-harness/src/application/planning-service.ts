import { applyPlan, PlannerOutputSchema, type RunState } from "../domain.js";
import { HarnessFailure } from "../errors.js";
import { compactDomainSeed } from "../knowledge.js";
import type { ApplicationContext } from "./application-context.js";
import { pendingInstallApprovals } from "./helpers.js";

export class PlanningService {
  constructor(private readonly ctx: ApplicationContext) {}

  async plan(state: RunState): Promise<RunState> {
    // Dirty-tree + run-branch guard BEFORE the planner. Previously this ran after
    // invoke, so a dirty package-lock (or similar) burned a full plan on every retry.
    const branchName = await this.ctx.git.ensureRunBranch(state.runId);

    // Idempotent resume: a prior plan.created may have persisted tasks before a
    // post-planner workspace block. Do not re-invoke the planner.
    if (state.tasks.length > 0) {
      const phase = pendingInstallApprovals(state).length > 0 ? "awaiting_input" : "executing";
      return this.ctx.store.record(
        { ...state, branchName: branchName ?? state.branchName, phase },
        "plan.resumed",
        { tasks: state.tasks.length, pendingInstalls: pendingInstallApprovals(state).length },
      );
    }

    const output = await this.ctx.agents.invoke({
      runId: state.runId,
      role: "planner",
      objective:
        "Turn the confirmed brief and grill resolutions into dependency-ordered tracer-bullet implementation tickets",
      input: {
        idea: state.idea,
        confirmedBrief: state.reflectBrief?.confirmed,
        resolutions: state.grillResolutions,
        defaultTdd: this.ctx.config.workflow.tdd,
        defaultTestCommand: this.ctx.config.commands.test,
      },
      expectedOutput:
        "{summary,tasks:[{id,title,description,acceptanceCriteria,affectedPaths?,blockedBy,tdd?,testCommand?}],proposedInstalls?:[{id,manager,packages,reason,command?}]}",
      schema: PlannerOutputSchema,
      knowledgeQuery: [
        state.reflectBrief?.confirmed ?? state.idea,
        compactDomainSeed(
          state.idea,
          state.reflectBrief?.confirmed,
          ...state.grillResolutions.flatMap((item) => [item.question, item.answer, item.summary]),
        ),
      ]
        .filter(Boolean)
        .join(" "),
      knowledgeFallbackQuery: compactDomainSeed(state.idea, state.reflectBrief?.confirmed),
      signal: this.ctx.signalFor(state.runId),
    });
    const now = new Date().toISOString();
    const transition = applyPlan(state, output, now, {
      tdd: this.ctx.config.workflow.tdd,
      testCommand: this.ctx.config.commands.test,
      branchName,
    });

    // Planner sessions can still dirty the tree; persist the plan first so a
    // workspace block does not discard it, then refuse to enter executing.
    if (this.ctx.config.git.enabled) {
      const dirty = await this.ctx.git.changedFiles();
      if (dirty.length > 0) {
        await this.ctx.store.persistTransition(state.runId, {
          state: { ...transition.state, phase: "planning" },
          events: transition.events,
        });
        throw new HarnessFailure(
          `Refusing to start on a dirty working tree. Commit or stash first: ${dirty.join(", ")}`,
          "workspace",
          true,
        );
      }
    }

    return this.ctx.store.persistTransition(state.runId, transition);
  }
}
