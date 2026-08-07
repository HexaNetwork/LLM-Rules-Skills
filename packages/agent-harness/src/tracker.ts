import type { BuildTask, GrillResolution, RunState } from "./domain.js";
import { RunStore } from "./store.js";

export interface TrackerPort {
  sync(state: RunState): Promise<string[]>;
}

/** Human-readable local issues are the default tracker and recovery surface. */
export class LocalTracker implements TrackerPort {
  constructor(private readonly store: RunStore) {}

  async sync(state: RunState): Promise<string[]> {
    const paths: string[] = [];
    if (state.reflectBrief) {
      paths.push(
        await this.store.writeText(state.runId, "brief.md", renderBrief(state)),
      );
    }
    if (state.grillResolutions.length > 0) {
      paths.push(
        await this.store.writeText(
          state.runId,
          "grill.md",
          renderGrill(state.grillResolutions),
        ),
      );
    }
    for (const task of state.tasks) {
      paths.push(
        await this.store.writeText(
          state.runId,
          `tasks/${task.id}-${slug(task.title)}.md`,
          renderTask(task),
        ),
      );
    }
    return paths;
  }
}

export function taskFrontier(tasks: BuildTask[]): BuildTask[] {
  const done = new Set(tasks.filter((task) => task.status === "done").map((task) => task.id));
  return tasks
    .filter(
      (task) => task.status === "pending" && task.blockedBy.every((blocker) => done.has(blocker)),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function assertAcyclic(items: Array<{ id: string; blockedBy: string[] }>): void {
  const ids = new Set(items.map((item) => item.id));
  for (const item of items) {
    for (const blocker of item.blockedBy) {
      if (!ids.has(blocker)) throw new Error(`${item.id} references unknown blocker ${blocker}`);
      if (blocker === item.id) throw new Error(`${item.id} cannot block itself`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(items.map((item) => [item.id, item] as const));
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Dependency cycle includes ${id}`);
    visiting.add(id);
    for (const blocker of byId.get(id)?.blockedBy ?? []) visit(blocker);
    visiting.delete(id);
    visited.add(id);
  };
  for (const item of items) visit(item.id);
}

function renderBrief(state: RunState): string {
  const brief = state.reflectBrief!;
  const body = brief.confirmed ?? brief.draft;
  return `# Feature brief

**Status:** ${brief.confirmed ? "confirmed" : "draft"}

## Idea

${state.idea}

## Restatement

${body}
`;
}

function renderGrill(resolutions: GrillResolution[]): string {
  if (resolutions.length === 0) return "# Grill resolutions\n\n_None yet._\n";
  return `# Grill resolutions

${resolutions
  .map(
    (item) => `## ${escapeHeading(item.id)}

**Question:** ${item.question}

**Answer:** ${item.answer}

**Summary:** ${item.summary}
`,
  )
  .join("\n")}`;
}

function renderTask(task: BuildTask): string {
  return `# ${escapeHeading(task.title)}

**Status:** ${task.status} / ${task.step}  
**Blocked by:** ${task.blockedBy.length ? task.blockedBy.join(", ") : "None"}  
**TDD:** ${task.tdd ? "on" : "off"}

## What to build

${task.description}

## Acceptance criteria

${task.acceptanceCriteria.map((criterion) => `- [${task.status === "done" ? "x" : " "}] ${criterion}`).join("\n")}

## Verification

${
  task.evidence.length
    ? task.evidence.map((evidence) => `- ${evidence.purpose}: ${evidence.passed ? "PASS" : "FAIL"} — \`${evidence.command}\``).join("\n")
    : "_Not run._"
}
`;
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "item"
  );
}

function escapeHeading(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}
