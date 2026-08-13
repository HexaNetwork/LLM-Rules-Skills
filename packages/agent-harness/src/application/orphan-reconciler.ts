import type { DockerClient, DockerContainerInspect } from "../infrastructure/container/types.js";
import { HARNESS_CONTAINER_LABEL_PREFIX } from "../infrastructure/container/container-spec.js";
import { harnessManagedContainerFilter } from "./docker-worker-session.js";

export type ManagedContainerSummary = {
  id: string;
  name: string;
  state: string;
  labels: Record<string, string>;
  image: string;
  projectKey?: string;
  runId?: string;
  /** Best-effort ISO timestamp from inspect Created when available. */
  createdAt?: string;
};

export type OrphanReconcileCandidate = ManagedContainerSummary & {
  decision: OrphanReconcileDecision;
};

export type OrphanReconcileDecision =
  | {
      action: "keep";
      reason:
        | "run-active"
        | "volume-may-hold-work"
        | "too-young"
        | "unknown-labels"
        | "matching-run-present";
    }
  | {
      action: "remove-container";
      reason: "orphaned-settled" | "orphaned-removed-workspace" | "orphaned-stale-no-run";
    };

export type OrphanReconcileKnownRun = {
  runId: string;
  phase?: string;
  removedAt?: string;
  workspaceVolumeName?: string;
  containerName?: string;
};

export type ReconcileOrphanContainersOptions = {
  docker: DockerClient;
  /** Known runs from durable harness state (workspace.json / execution.json). */
  knownRuns: OrphanReconcileKnownRun[];
  projectKey?: string;
  /** Minimum age before an unmatched container may be removed (ms). Default 24h. */
  minAgeMs?: number;
  now?: () => Date;
  /**
   * When true, perform removals for candidates whose decision is remove-container.
   * Default false (report only).
   */
  apply?: boolean;
};

export type OrphanReconcileReport = {
  inspected: number;
  candidates: OrphanReconcileCandidate[];
  removed: string[];
};

const DEFAULT_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Inspect harness-labeled containers and decide conservative orphan actions.
 * Never removes workspace volumes — unpublished commits may live there.
 */
export async function reconcileOrphanContainers(
  options: ReconcileOrphanContainersOptions,
): Promise<OrphanReconcileReport> {
  const now = options.now?.() ?? new Date();
  const minAgeMs = options.minAgeMs ?? DEFAULT_MIN_AGE_MS;
  const knownByRun = new Map(options.knownRuns.map((run) => [run.runId, run]));
  const knownByContainer = new Map(
    options.knownRuns
      .filter((run) => run.containerName)
      .map((run) => [run.containerName!, run]),
  );

  const managed = await listManagedContainers(options.docker, options.projectKey);
  const candidates: OrphanReconcileCandidate[] = [];
  const removed: string[] = [];

  for (const container of managed) {
    const decision = decideOrphanAction(container, {
      knownByRun,
      knownByContainer,
      now,
      minAgeMs,
    });
    candidates.push({ ...container, decision });

    if (options.apply && decision.action === "remove-container") {
      await options.docker.exec(["rm", "-f", container.name || container.id]);
      removed.push(container.name || container.id);
    }
  }

  return { inspected: managed.length, candidates, removed };
}

export function decideOrphanAction(
  container: ManagedContainerSummary,
  input: {
    knownByRun: Map<string, OrphanReconcileKnownRun>;
    knownByContainer: Map<string, OrphanReconcileKnownRun>;
    now: Date;
    minAgeMs: number;
  },
): OrphanReconcileDecision {
  const runId =
    container.runId ??
    container.labels[`${HARNESS_CONTAINER_LABEL_PREFIX}.run-id`];
  const managed = container.labels[`${HARNESS_CONTAINER_LABEL_PREFIX}.managed`];
  if (managed !== "true" || !runId) {
    return { action: "keep", reason: "unknown-labels" };
  }

  const known =
    input.knownByRun.get(runId) ??
    (container.name ? input.knownByContainer.get(container.name) : undefined);

  if (known) {
    if (known.removedAt) {
      return ageAllowsRemoval(container, input.now, input.minAgeMs)
        ? { action: "remove-container", reason: "orphaned-removed-workspace" }
        : { action: "keep", reason: "too-young" };
    }
    const phase = known.phase ?? "";
    if (phase === "completed" || phase === "cancelled") {
      // Settled but volume may still hold unpublished work — only remove the
      // container shell, and only after the age gate.
      if (!ageAllowsRemoval(container, input.now, input.minAgeMs)) {
        return { action: "keep", reason: "too-young" };
      }
      if (container.state === "running") {
        return { action: "keep", reason: "run-active" };
      }
      return { action: "remove-container", reason: "orphaned-settled" };
    }
    if (container.state === "running") {
      return { action: "keep", reason: "run-active" };
    }
    return { action: "keep", reason: "matching-run-present" };
  }

  // No durable run record — still require age before removing a labeled container.
  if (!ageAllowsRemoval(container, input.now, input.minAgeMs)) {
    return { action: "keep", reason: "too-young" };
  }
  if (container.state === "running") {
    // Conservative: a running unlabeled-run container may still be a live worker.
    return { action: "keep", reason: "run-active" };
  }
  return { action: "remove-container", reason: "orphaned-stale-no-run" };
}

function ageAllowsRemoval(
  container: ManagedContainerSummary,
  now: Date,
  minAgeMs: number,
): boolean {
  if (!container.createdAt) return false;
  const created = Date.parse(container.createdAt);
  if (!Number.isFinite(created)) return false;
  return now.getTime() - created >= minAgeMs;
}

export async function listManagedContainers(
  docker: DockerClient,
  projectKey?: string,
): Promise<ManagedContainerSummary[]> {
  const filters = harnessManagedContainerFilter(projectKey);
  const args = ["ps", "-a", "--format", "{{json .}}", ...filters.flatMap((f) => ["--filter", f])];
  const result = await docker.exec(args);
  if (result.exitCode !== 0) {
    return [];
  }
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const summaries: ManagedContainerSummary[] = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line) as {
        ID?: string;
        Id?: string;
        Names?: string;
        State?: string;
        Status?: string;
        Image?: string;
        Labels?: string;
        CreatedAt?: string;
      };
      const name = (row.Names ?? "").replace(/^\//, "").split(",")[0] ?? "";
      const labels = parseDockerPsLabels(row.Labels ?? "");
      const id = row.ID ?? row.Id ?? name;
      if (!id) continue;
      summaries.push({
        id,
        name: name || id,
        state: (row.State ?? row.Status ?? "unknown").toLowerCase().split(/\s+/)[0] ?? "unknown",
        labels,
        image: row.Image ?? "",
        projectKey: labels[`${HARNESS_CONTAINER_LABEL_PREFIX}.project-key`],
        runId: labels[`${HARNESS_CONTAINER_LABEL_PREFIX}.run-id`],
        createdAt: normalizeDockerCreatedAt(row.CreatedAt),
      });
    } catch {
      // skip malformed lines
    }
  }

  // Enrich with inspect when available (labels/created more reliable).
  if (docker.inspectContainer) {
    for (const summary of summaries) {
      const inspected = await docker.inspectContainer(summary.name).catch(() => undefined);
      if (inspected) applyInspect(summary, inspected);
    }
  }
  return summaries;
}

function applyInspect(summary: ManagedContainerSummary, inspected: DockerContainerInspect): void {
  summary.id = inspected.id || summary.id;
  summary.name = inspected.name || summary.name;
  summary.state = inspected.state || summary.state;
  summary.image = inspected.image || summary.image;
  summary.labels = { ...summary.labels, ...inspected.labels };
  summary.projectKey =
    summary.labels[`${HARNESS_CONTAINER_LABEL_PREFIX}.project-key`] ?? summary.projectKey;
  summary.runId = summary.labels[`${HARNESS_CONTAINER_LABEL_PREFIX}.run-id`] ?? summary.runId;
}

function parseDockerPsLabels(raw: string): Record<string, string> {
  const labels: Record<string, string> = {};
  if (!raw) return labels;
  for (const part of raw.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    labels[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return labels;
}

function normalizeDockerCreatedAt(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  return undefined;
}
