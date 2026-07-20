import type { ProjectConfig } from "../schemas/config.js";
import {
  DraftManifestSchema,
  RunManifestSchema,
  type DraftManifest,
  type ManifestTask,
  type RunManifest,
} from "../schemas/manifest.js";
import type { NormalizedSource } from "../adapters/local.js";
import { topologicalSort } from "../engine/dag.js";
import { sha256Json } from "../util/hash.js";
import type { AgentPort } from "../agents/ports.js";

export function validateTasksForPrepare(tasks: ManifestTask[]): string[] {
  const errors: string[] = [];
  for (const task of tasks) {
    if (task.mode === "HITL") {
      errors.push(`Task ${task.id} is HITL and rejected by v1 AFK-only policy`);
    }
    if (task.acceptanceCriteria.length === 0) {
      errors.push(`Task ${task.id} is missing acceptance criteria`);
    }
    for (const criterion of task.acceptanceCriteria) {
      if (criterion.text.trim().length < 8) {
        errors.push(
          `Task ${task.id} criterion ${criterion.id} is too vague to execute unattended`,
        );
      }
    }
  }
  const dag = topologicalSort(tasks);
  if (!dag.ok) {
    errors.push(dag.error);
  }
  return errors;
}

export async function buildDraftManifest(input: {
  config: ProjectConfig;
  source: NormalizedSource;
  agent?: AgentPort;
  enrich?: boolean;
}): Promise<DraftManifest> {
  let tasks = input.source.tasks.map((task) => ({ ...task }));
  const validationErrors = validateTasksForPrepare(tasks);

  if (input.enrich && input.agent && validationErrors.length === 0) {
    const research = await input.agent.runPrepareResearch({
      model: input.config.models.prepare,
      cwd: input.config.repositoryRoot,
      config: input.config,
      draftTasks: tasks,
    });
    const byId = new Map(
      research.enrichment.map((item) => [item.taskId, item] as const),
    );
    tasks = tasks.map((task) => {
      const enrichment = byId.get(task.id);
      if (!enrichment) return task;
      return {
        ...task,
        allowedGlobs: enrichment.allowedGlobs?.length
          ? enrichment.allowedGlobs
          : task.allowedGlobs,
        testSeams: enrichment.testSeams ?? task.testSeams,
        browserProbes: enrichment.browserProbes ?? task.browserProbes,
        implementationNotes:
          enrichment.implementationNotes ?? task.implementationNotes,
        // acceptance criteria are intentionally untouched
      };
    });
  }

  return DraftManifestSchema.parse({
    contractVersion: "1",
    draft: true,
    createdAt: new Date().toISOString(),
    source: input.source.source,
    configSnapshot: input.config,
    tasks,
    validationErrors,
  });
}

export async function approveManifest(input: {
  draft: DraftManifest;
  approvedBy: string;
}): Promise<RunManifest> {
  if (input.draft.validationErrors.length > 0) {
    throw new Error(
      `Cannot approve draft with validation errors:\n${input.draft.validationErrors.join("\n")}`,
    );
  }
  if (input.draft.tasks.some((task) => task.mode !== "AFK")) {
    throw new Error("Cannot approve non-AFK tasks in v1");
  }
  const dag = topologicalSort(input.draft.tasks);
  if (!dag.ok) {
    throw new Error(dag.error);
  }

  const withoutHash = {
    contractVersion: "1" as const,
    draft: false as const,
    approvedAt: new Date().toISOString(),
    approvedBy: input.approvedBy,
    source: input.draft.source,
    configSnapshot: input.draft.configSnapshot,
    retries: input.draft.configSnapshot.retries,
    models: input.draft.configSnapshot.models,
    taskOrder: dag.order,
    tasks: input.draft.tasks,
  };

  const manifestHash = await sha256Json(withoutHash);
  return RunManifestSchema.parse({
    ...withoutHash,
    manifestHash,
  });
}

export function assertManifestUnchanged(
  expectedHash: string,
  manifest: RunManifest,
): void {
  if (manifest.manifestHash !== expectedHash) {
    throw new Error("Run manifest hash mismatch; re-approve before execute");
  }
}
