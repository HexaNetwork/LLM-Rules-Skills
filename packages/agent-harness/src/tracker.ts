import type { BuildTask, DecisionTicket, RunState } from "./domain.js";
import { RunStore } from "./store.js";

export interface TrackerPort {
  sync(state: RunState): Promise<string[]>;
}

/** Human-readable local issues are the default tracker and recovery surface. */
export class LocalTracker implements TrackerPort {
  constructor(private readonly store: RunStore) {}

  async sync(state: RunState): Promise<string[]> {
    const paths: string[] = [];
    if (state.map) {
      paths.push(await this.store.writeText(state.runId, "map.md", renderMap(state)));
    }
    for (const ticket of state.decisionTickets) {
      paths.push(
        await this.store.writeText(
          state.runId,
          `issues/${ticket.id}-${slug(ticket.title)}.md`,
          renderDecision(ticket),
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

export function decisionFrontier(tickets: DecisionTicket[]): DecisionTicket[] {
  const resolved = new Set(
    tickets
      .filter((ticket) => ticket.status === "resolved" || ticket.status === "out_of_scope")
      .map((ticket) => ticket.id),
  );
  return tickets
    .filter(
      (ticket) =>
        ticket.status === "open" && ticket.blockedBy.every((blocker) => resolved.has(blocker)),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
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

function renderMap(state: RunState): string {
  const map = state.map!;
  return `# ${escapeHeading(map.destination)}

## Destination

${map.destination}

## Notes

${renderList(map.notes)}

## Decisions so far

${
  map.decisionsSoFar.length
    ? map.decisionsSoFar
        .map((decision) => `- [${decision.title}](issues/${decision.ticketId}-${slug(decision.title)}.md) — ${decision.gist}`)
        .join("\n")
    : "_None yet._"
}

## Not yet specified

${renderList(map.notYetSpecified)}

## Out of scope

${renderList(map.outOfScope)}
`;
}

function renderDecision(ticket: DecisionTicket): string {
  const conversation = ticket.conversation.length
    ? ticket.conversation
        .map((turn) => `- **${turn.speaker}:** ${turn.text}`)
        .join("\n")
    : "_No conversation yet._";
  const humanQuestion = ticket.humanQuestion;
  const questionDetails = humanQuestion
    ? `

### Why this matters

${humanQuestion.context}

### Options

${humanQuestion.options
  .map(
    (option) =>
      `- **${option.label}${option.id === humanQuestion.recommendedOptionId ? " (recommended)" : ""}:** ${option.description}`,
  )
  .join("\n")}

### Recommendation

${humanQuestion.recommendation}`
    : "";
  return `# ${escapeHeading(ticket.title)}

**Type:** wayfinder:${ticket.kind}  
**Interaction:** ${ticket.interaction}  
**Status:** ${ticket.status}  
**Blocked by:** ${ticket.blockedBy.length ? ticket.blockedBy.join(", ") : "None"}

## Question

${ticket.question}${questionDetails}

## Conversation

${conversation}

## Resolution

${ticket.resolution ?? "_Open._"}
`;
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

function renderList(values: string[]): string {
  return values.length ? values.map((value) => `- ${value}`).join("\n") : "_None._";
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
