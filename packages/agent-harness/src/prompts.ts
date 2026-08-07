import type { AgentRole, WorkPacket } from "./domain.js";

const ROLE_RULES: Record<AgentRole, string[]> = {
  reflector: [
    "Restate the idea in your own words without inventing requirements.",
    "Separate goal, users, in-scope, out-of-scope, assumptions, and unknowns.",
    "Do not ask grilling questions and do not plan implementation.",
    "Look up codebase facts when they clarify existing behavior; do not decide product preferences.",
  ],
  griller: [
    "You may return 1..N questions in a single turn, but ONLY questions that are mutually independent — where the answer to one would not change how you would phrase, scope, or offer options on another.",
    "N (see the batch-size constraint below) is a CEILING, NOT A TARGET. Default to fewer questions, even one. If the very next decision genuinely forks on this answer, return a single question. Batching dependent questions produces low-quality interviews with contradictory or wasted options — this is the primary risk of asking more than one question per turn, so when in doubt, ask fewer.",
    "Every turn, also return openUnknowns: the complete list of everything you still need resolved to be ready_to_plan, including things you have not asked about yet. This is the human's only visibility into how much interview remains, so keep it honest and current — do not omit an unknown just because you have not gotten to it.",
    "Look up codebase facts; put product decisions to the human with a recommendation.",
    "For every question include why it matters, 2-4 mutually exclusive options with tradeoffs, and one recommended option with rationale. Link it to the openUnknowns entry it resolves via unknownId when one exists.",
    "Do not enact the plan; when understanding is sufficient, return ready_to_plan with compact resolutions.",
    "Human answers and operator notes are authoritative and used verbatim — never second-guess or soften them.",
  ],
  planner: [
    "Produce narrow, complete tracer-bullet slices, not horizontal layers.",
    "Each task must be verifiable in one fresh agent context.",
    "Declare only genuine blocking edges and use the agreed domain vocabulary.",
    "Plan from the confirmed reflect brief and grill resolutions only.",
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
  const { guidance: _rendered, ...packetForJson } = packet;
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
    JSON.stringify(packetForJson),
  ].join("\n");
}

export function renderPromptBuilderPrompt(packet: WorkPacket): string {
  const { guidance: _rendered, ...packetForJson } = packet;
  return [
    "You are a low-cost prompt compiler.",
    "Transform the work packet into the prompt for the named downstream worker.",
    "Do not solve the task, omit constraints, selected guidance block, or add requirements.",
    "Return only JSON shaped as {\"prompt\":\"...\"}.",
    ...renderGuidance(packet),
    JSON.stringify(packetForJson),
  ].join("\n");
}

export function renderContinuationPrompt(
  packet: WorkPacket,
  options: { includeGuidance?: boolean } = {},
): string {
  const includeGuidance = options.includeGuidance !== false;
  return [
    `Continue the durable grill episode. For this turn, act as the ${packet.role} worker.`,
    "Use the existing conversation and repository findings; do not repeat exploration already completed unless the new input invalidates it.",
    ...ROLE_RULES[packet.role].map((rule) => `- ${rule}`),
    ...packet.constraints.map((constraint) => `- ${constraint}`),
    ...(includeGuidance ? renderGuidance(packet) : []),
    `Objective: ${packet.objective}`,
    "New authoritative input:",
    JSON.stringify(packet.input),
    ...outputContractLines(packet.role),
    `Expected output: ${packet.expectedOutput}`,
  ].join("\n");
}

const EPISODE_ROLES = new Set<AgentRole>(["griller"]);

function outputContractLines(role: AgentRole): string[] {
  if (!EPISODE_ROLES.has(role)) return [];
  return [
    "Return exactly one JSON object matching the expected output contract.",
    "You may deliver that JSON via CreatePlan or as the assistant result text.",
  ];
}

function renderGuidance(packet: WorkPacket): string[] {
  if (packet.guidance.length === 0) return [];
  return [
    "",
    "SELECTED GUIDANCE",
    ...packet.guidance.flatMap((item) => [
      `### ${item.title} (${item.kind}: ${item.source})`,
      `Reason: ${item.reason}`,
      item.excerpt,
    ]),
  ];
}
