import type { AgentRole, WorkPacket } from "./domain.js";

const ROLE_RULES: Record<AgentRole, string[]> = {
  navigator: [
    "Name a concrete destination before charting work.",
    "Create decision tickets, not implementation slices.",
    "Put only precise questions into tickets; keep unshaped uncertainty in fog.",
    "Ticket kind must be exactly one of: research, prototype, grilling.",
    "Mark tickets HITL when a human must speak for preferences or intent.",
    "For every HITL ticket, give the human enough context to decide: a self-contained prompt, why it matters, 2-4 mutually exclusive options with concrete tradeoffs, and one recommended option with rationale.",
  ],
  "decision-researcher": [
    "Resolve only the named research question from evidence.",
    "Do not invent product preferences.",
  ],
  "decision-prototyper": [
    "Create only the cheapest artifact needed to make the decision concrete.",
    "Ask for human reaction when preference determines the answer.",
  ],
  "decision-facilitator": [
    "Use the recorded human conversation verbatim as authoritative input.",
    "Ask exactly one follow-up when the decision is still ambiguous.",
    "When asking, include why the decision matters, 2-4 mutually exclusive options with concrete tradeoffs, and one recommended option with rationale; leave room for a custom answer.",
  ],
  planner: [
    "Produce narrow, complete tracer-bullet slices, not horizontal layers.",
    "Each task must be verifiable in one fresh agent context.",
    "Declare only genuine blocking edges and use the agreed domain vocabulary.",
  ],
  "prompt-builder": [
    "Turn the packet into a precise prompt without changing scope or inventing facts.",
    "Preserve every acceptance criterion, constraint, selected guidance block, evidence block, and output contract.",
  ],
  "test-writer": [
    "Edit tests only. Do not implement production behavior and do not commit.",
    "Test public behavior at the agreed seam with independent expected values.",
    "Return after creating a meaningful failing test.",
  ],
  implementer: [
    "Edit the working tree but never commit, push, or open a pull request.",
    "Treat supplied command output as ground truth and fix the reported behavior.",
    "Do not weaken, delete, or bypass tests.",
  ],
  reviewer: [
    "Do not edit files.",
    "Block only for a demonstrable correctness, security, or acceptance failure.",
    "Use advisory findings for optional improvements.",
  ],
  "message-writer": [
    "Do not run git commands.",
    "Write an imperative conventional-commit subject or a concise pull-request title and body.",
    "Describe only verified changes present in the packet.",
  ],
};

export function renderPrompt(packet: WorkPacket): string {
  return [
    `You are the ${packet.role} worker in a deterministic software-delivery harness.`,
    "This is a fresh session. The work packet below is the complete handoff; do not assume hidden chat history.",
    ...ROLE_RULES[packet.role].map((rule) => `- ${rule}`),
    ...packet.constraints.map((constraint) => `- ${constraint}`),
    ...renderGuidance(packet),
    ...outputContractLines(packet.role),
    `Expected output: ${packet.expectedOutput}`,
    "",
    "WORK PACKET",
    JSON.stringify(packet, null, 2),
  ].join("\n");
}

export function renderPromptBuilderPrompt(packet: WorkPacket): string {
  return [
    "You are a low-cost prompt compiler.",
    "Transform the work packet into the prompt for the named downstream worker.",
    "Do not solve the task, omit constraints, selected guidance block, or add requirements.",
    "Return only JSON shaped as {\"prompt\":\"...\"}.",
    JSON.stringify(packet, null, 2),
  ].join("\n");
}

export function renderContinuationPrompt(packet: WorkPacket): string {
  return [
    `Continue the durable wayfinding episode. For this turn, act as the ${packet.role} worker.`,
    "Use the existing conversation and repository findings; do not repeat exploration already completed unless the new input invalidates it.",
    ...ROLE_RULES[packet.role].map((rule) => `- ${rule}`),
    ...packet.constraints.map((constraint) => `- ${constraint}`),
    ...renderGuidance(packet),
    `Objective: ${packet.objective}`,
    "New authoritative input:",
    JSON.stringify(packet.input, null, 2),
    ...outputContractLines(packet.role),
    `Expected output: ${packet.expectedOutput}`,
  ].join("\n");
}

const WAYFINDING_ROLES = new Set<AgentRole>([
  "navigator",
  "decision-researcher",
  "decision-prototyper",
  "decision-facilitator",
]);

function outputContractLines(role: AgentRole): string[] {
  if (WAYFINDING_ROLES.has(role)) {
    return [
      "Return exactly one JSON object matching the expected schema and no surrounding prose.",
      "You may deliver that JSON as the assistant result text or as the CreatePlan body — same schema either way.",
    ];
  }
  return ["Return exactly one JSON object and no surrounding prose."];
}

function renderGuidance(packet: WorkPacket): string[] {
  if (packet.guidance.length === 0) return [];
  return [
    "Apply this deterministic, scoped selection of repository rules and skills:",
    ...packet.guidance.map(
      (item) => `- [${item.kind}] ${item.source} (${item.reason}; score ${item.score}):\n${item.excerpt}`,
    ),
  ];
}
