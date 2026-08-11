import type {
  BuildTask,
  GrillResolution,
  HighLevelPlan,
  OpenUnknown,
  Prd,
  RunState,
} from "./domain.js";
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
    if (state.openUnknowns.length > 0) {
      paths.push(
        await this.store.writeText(state.runId, "unknowns.md", renderUnknowns(state.openUnknowns)),
      );
    }
    if (state.plan) {
      paths.push(await this.store.writeText(state.runId, "plan.md", renderPlan(state.plan)));
    }
    if (state.prd) {
      paths.push(await this.store.writeText(state.runId, "prd.md", renderPrd(state.prd)));
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

export { assertAcyclic, taskFrontier } from "./domain/policies.js";

function renderBrief(state: RunState): string {
  const brief = state.reflectBrief!;
  const body = brief.confirmed ?? brief.draft;
  return `# Feature brief

**Status:** ${brief.confirmed ? "confirmed" : "draft"}

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

function renderUnknowns(unknowns: OpenUnknown[]): string {
  const groups: Record<OpenUnknown["status"], OpenUnknown[]> = {
    fog: [],
    asked: [],
    parked: [],
    dropped: [],
    resolved: [],
  };
  for (const item of unknowns) groups[item.status].push(item);
  const section = (title: string, items: OpenUnknown[]): string => {
    if (items.length === 0) return `## ${title}\n\n_None._`;
    return `## ${title}\n\n${items
      .map(
        (item) =>
          `- **${escapeHeading(item.title)}** _(${item.impact})_${
            item.whyItMatters ? ` — ${item.whyItMatters}` : ""
          }`,
      )
      .join("\n")}`;
  };
  return `# Open unknowns

${section("Fog (not yet asked)", groups.fog)}

${section("Asked", groups.asked)}

${section("Parked", groups.parked)}

${section("Dropped (griller stopped tracking)", groups.dropped)}

${section("Resolved", groups.resolved)}
`;
}

function renderPlan(plan: HighLevelPlan): string {
  const list = (items: string[]): string =>
    items.length ? items.map((item) => `- ${item}`).join("\n") : "_None._";
  return `# High-level plan

**Summary:** ${plan.summary}

## Problem statement

${plan.problemStatement}

## Solution

${plan.solution}

## Approach

${plan.approach}

## Constraints

${list(plan.constraints)}

## Out of scope

${list(plan.outOfScope)}

## Open questions

${list(plan.openQuestions)}
`;
}

function renderPrd(prd: Prd): string {
  const list = (items: string[]): string =>
    items.length ? items.map((item) => `- ${item}`).join("\n") : "_None._";
  const numbered = (items: string[]): string =>
    items.length
      ? items.map((item, index) => `${index + 1}. ${item}`).join("\n")
      : "_None._";
  return `# PRD

**Summary:** ${prd.summary}

## Problem Statement

${prd.problemStatement}

## Solution

${prd.solution}

## User Stories

${numbered(prd.userStories)}

## Implementation Decisions

${list(prd.implementationDecisions)}

## Testing Decisions

${list(prd.testingDecisions)}

## Out of Scope

${list(prd.outOfScope)}

## Further Notes

${prd.furtherNotes.trim() || "_None._"}
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
