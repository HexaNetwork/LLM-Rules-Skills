import type { Context } from "@deepseek-ai/cordis";
import type { WorkflowBundle } from "../domain/types.js";
import { DEFAULT_WORKFLOW } from "../workflows/default.js";
import { TICKET_WORKFLOW } from "../workflows/ticket.js";

export type WorkflowService = {
  get(id: string): WorkflowBundle;
  list(): WorkflowBundle[];
  nextPhase(bundleId: string, current: string): string | undefined;
  firstPhase(bundleId: string): string;
  includes(bundleId: string, phaseId: string): boolean;
};

export function createWorkflowService(bundles: WorkflowBundle[]): WorkflowService {
  const byId = new Map(bundles.map((bundle) => [bundle.id, bundle]));
  return {
    get(id) {
      const bundle = byId.get(id);
      if (!bundle) throw new Error(`Unknown workflow bundle: ${id}`);
      return bundle;
    },
    list: () => [...bundles],
    firstPhase(bundleId) {
      const first = this.get(bundleId).phases[0];
      if (!first) throw new Error(`Workflow bundle "${bundleId}" has no phases`);
      return first;
    },
    nextPhase(bundleId, current) {
      const phases = this.get(bundleId).phases;
      const index = phases.indexOf(current);
      if (index < 0) return undefined;
      return phases[index + 1];
    },
    includes(bundleId, phaseId) {
      return this.get(bundleId).phases.includes(phaseId);
    },
  };
}

export function workflowPlugin(
  ctx: Context,
  config: { bundles?: WorkflowBundle[] } = {},
): void {
  ctx.provide("workflow", createWorkflowService(config.bundles ?? [DEFAULT_WORKFLOW, TICKET_WORKFLOW]));
}

