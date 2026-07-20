import type { ManifestTask } from "../schemas/manifest.js";

export type DagResult =
  | { ok: true; order: string[] }
  | { ok: false; error: string; cycle?: string[] };

export function topologicalSort(tasks: ManifestTask[]): DagResult {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    for (const dep of task.blockedBy) {
      if (!byId.has(dep)) {
        return {
          ok: false,
          error: `Task ${task.id} depends on missing task ${dep}`,
        };
      }
    }
  }

  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    indegree.set(task.id, task.blockedBy.length);
    for (const dep of task.blockedBy) {
      const list = dependents.get(dep) ?? [];
      list.push(task.id);
      dependents.set(dep, list);
    }
  }

  const ready = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id)
    .sort((a, b) => a.localeCompare(b));

  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const child of (dependents.get(id) ?? []).sort((a, b) =>
      a.localeCompare(b),
    )) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) ready.push(child);
      ready.sort((a, b) => a.localeCompare(b));
    }
  }

  if (order.length !== tasks.length) {
    const remaining = tasks
      .map((task) => task.id)
      .filter((id) => !order.includes(id));
    return {
      ok: false,
      error: `Dependency cycle detected among: ${remaining.join(", ")}`,
      cycle: remaining,
    };
  }

  return { ok: true, order };
}

export function dependentsOf(
  tasks: ManifestTask[],
  taskId: string,
): string[] {
  return tasks
    .filter((task) => task.blockedBy.includes(taskId))
    .map((task) => task.id);
}

export function allDependents(
  tasks: ManifestTask[],
  taskId: string,
): string[] {
  const result = new Set<string>();
  const queue = [taskId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of dependentsOf(tasks, current)) {
      if (!result.has(child)) {
        result.add(child);
        queue.push(child);
      }
    }
  }
  return [...result];
}
