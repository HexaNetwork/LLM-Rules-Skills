/** Agent roles invoked by the lean workflow steps. */
export const WORKFLOW_ROLES = [
  "reflector",
  "griller",
  "specifier",
  "environment-planner",
  "task-slicer",
  "implementer",
  "task-reviewer",
  "final-reviewer",
  "final-repairer",
  "publication-writer",
] as const;

export type WorkflowRole = (typeof WORKFLOW_ROLES)[number];

const ROLE_RULES: Record<WorkflowRole, readonly string[]> = {
  reflector: [
    "Restate the operator request without inventing scope.",
    "Surface users, assumptions, boundaries, and material unknowns.",
    "Return one editable brief, not implementation steps.",
  ],
  griller: [
    "Ask only for material unknowns that block specification or delivery.",
    "Prefer one structured batch of questions over many tiny follow-ups.",
    "Mark resolved when the brief is actionable without further clarification.",
  ],
  specifier: [
    "Produce concise, testable specification artifacts from the clarified brief.",
    "Keep scope bounded and traceable to operator intent.",
    "Do not invent repository facts you cannot justify from the packet.",
  ],
  "environment-planner": [
    "Plan a language-neutral container environment from repository evidence.",
    "Extend the configured runner image exactly; do not replace it.",
    "Justify toolchains only through setup and healthcheck commands.",
  ],
  "task-slicer": [
    "Create ordered, bounded implementation tasks with observable outcomes.",
    "Each task must include one relevant verification command.",
    "Preserve existing project structure unless the run is explicitly fresh.",
  ],
  implementer: [
    "Implement only the assigned task inside /workspace.",
    "Do not commit, publish, or expand scope beyond the task requirement.",
    "Prefer minimal diffs that satisfy the requirement.",
  ],
  "task-reviewer": [
    "Review the task diff independently against the bounded requirement.",
    "Return actionable findings only; avoid stylistic nitpicks.",
    "Approve when the requirement is satisfied with acceptable risk.",
  ],
  "final-reviewer": [
    "Review the complete change against the approved specification and evidence.",
    "Focus on correctness, missing coverage, and delivery risk.",
    "Return approved plus actionable findings.",
  ],
  "final-repairer": [
    "Repair only the validated findings reported to you.",
    "Do not commit, publish, or introduce unrelated changes.",
    "Treat operator and harness diagnostics as authoritative.",
  ],
  "publication-writer": [
    "Draft a concise pull-request title and body from durable artifacts.",
    "Do not run Git or publication commands.",
    "Summarize outcomes and validation evidence for a human reviewer.",
  ],
};

export function roleRulesFor(role: string): readonly string[] {
  return ROLE_RULES[role as WorkflowRole] ?? [
    "Follow harness constraints and return exactly one schema-valid JSON object.",
  ];
}

export function renderRoleContext(role: string, guidanceBody: string): string {
  const body = guidanceBody.trim();
  return [
    `You are the ${role} worker in a deterministic software-delivery harness.`,
    "Rules:",
    ...roleRulesFor(role).map((rule) => `- ${rule}`),
    body ? `\nGuidance:\n${body}` : "",
  ].filter(Boolean).join("\n");
}
