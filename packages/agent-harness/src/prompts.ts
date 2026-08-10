import type { AgentRole, WorkPacket } from "./domain.js";

const ROLE_RULES: Record<AgentRole, string[]> = {
  reflector: [
    "Restate the idea in your own words without inventing requirements.",
    "Propose a concise imperative feature title suitable as a run label (for example \"Add greeting tone\"), not a paragraph.",
    "Separate goal, users, in-scope, out-of-scope, assumptions, and unknowns.",
    "Do not ask grilling questions and do not plan implementation.",
    "Look up codebase facts when they clarify existing behavior; do not decide product preferences.",
    "Return exactly one raw JSON object matching the expected output contract. Do not use Markdown headings or code fences.",
  ],
  griller: [
    "You may return 1..N questions in a single turn, but ONLY questions that are mutually independent — where the answer to one would not change how you would phrase, scope, or offer options on another.",
    "N (see the batch-size constraint below) is a CEILING, NOT A TARGET. Default to fewer questions, even one. If the very next decision genuinely forks on this answer, return a single question. Batching dependent questions produces low-quality interviews with contradictory or wasted options — this is the primary risk of asking more than one question per turn, so when in doubt, ask fewer.",
    "Every turn, also return openUnknowns: the complete list of everything you still need resolved to be ready_to_plan, including things you have not asked about yet. This is the human's only visibility into how much interview remains, so keep it honest and current — do not omit an unknown just because you have not gotten to it.",
    "Look up codebase facts; put product decisions to the human with a recommendation.",
    "For every question include why it matters, 2-4 mutually exclusive options with tradeoffs, and one recommended option with rationale. Link it to the openUnknowns entry it resolves via unknownId when one exists.",
    "When you incorporate answers, return one `resolutionSummaries` entry per answered `questionId` — a specific statement of what that one answer settled. Do not reuse the same text across entries; the turn-level `summary` covers the turn.",
    "Do not enact the plan; when understanding is sufficient, return ready_to_plan with compact resolutions.",
    "Human answers and operator notes are authoritative and used verbatim — never second-guess or soften them.",
    "Return exactly one JSON object matching the expected output contract. Do not write Markdown interview prose, headings, or reports as the deliverable. If you use CreatePlan, the plan body must be that JSON only — not a Markdown research plan.",
  ],
  planner: [
    "Do not edit the working tree. Produce the task list only.",
    "Produce narrow, complete tracer-bullet slices, not horizontal layers.",
    "Each task must be verifiable in one fresh agent context.",
    "Declare only genuine blocking edges and use the agreed domain vocabulary.",
    "Plan from the confirmed reflect brief and grill resolutions only.",
    "Propose dependency installs needed before implementation in proposedInstalls; do not install them yourself.",
    "Return exactly one raw JSON object matching the expected output contract. Do not use Markdown headings or code fences.",
  ],
  "prompt-builder": [
    "Turn the packet into a precise prompt without changing scope or inventing facts.",
    "Preserve every acceptance criterion, constraint, selected guidance block, evidence block, and output contract.",
    "Return exactly one raw JSON object matching the expected output contract. Do not use Markdown headings or code fences.",
  ],
  "test-writer": [
    "Edit tests only. Do not implement production behavior and do not commit.",
    "Test public behavior at the agreed seam with independent expected values.",
    "Return after creating a meaningful failing test.",
    "Return exactly one raw JSON object matching the expected output contract. Do not use Markdown headings or code fences.",
  ],
  implementer: [
    "Edit the working tree but never commit, push, or open a pull request.",
    "Treat supplied command output as ground truth and fix the reported behavior.",
    "Do not edit, weaken, delete, or bypass tests.",
    "Return exactly one raw JSON object matching the expected output contract. Do not use Markdown headings or code fences.",
  ],
  reviewer: [
    "Do not edit files.",
    "Block only for a demonstrable correctness, security, or acceptance failure.",
    "Use advisory findings for optional improvements.",
    "The diff is the primary evidence. Read the listed omitted files from disk before commenting on them.",
    "Return exactly one raw JSON object matching the expected output contract. Do not use Markdown headings or code fences.",
  ],
  "message-writer": [
    "Do not run git commands.",
    "Write an imperative conventional-commit subject or a concise pull-request title and body.",
    "Describe only verified changes present in the packet.",
    "Return exactly one raw JSON object matching the expected output contract. Do not use Markdown headings or code fences.",
  ],
  fixer: [
    "When asked to plan, do not edit files. Explain a minimal, reversible recovery plan grounded in the reported failure and operator guidance.",
    "When asked to apply an approved plan, edit only what is necessary to address that plan. Do not commit, push, open a pull request, weaken tests, or change scope.",
    "Treat the reported failure and the operator's guidance as authoritative. Report the files actually changed and validation performed.",
    "Return exactly one raw JSON object matching the expected output contract. Do not use Markdown headings or code fences.",
  ],
  "config-fixer": [
    "You only propose harness settings patches. Do not edit repository files.",
    "Return the smallest ProjectSettingsPatch (workflow / commands / git) that unblocks the reported failure.",
    "Ground the recommendation in currentRepairableSettings and the failure detail. Prefer widening testPathPatterns over unrelated changes.",
    "When repairing a shell-launch failure for commands.test, choose a host-compatible single command from the failure detail and current settings — do not invent a stack.",
    "The work packet is complete. Do not call tools, inspect files, or search the repository.",
    "Return exactly one raw JSON object with top-level summary and configPatch fields. Do not use Markdown headings or code fences.",
  ],
  "project-profiler": [
    "You only propose verification settings for this repository. Do not edit files.",
    "Propose the smallest change to commands.test and/or workflow.testPathPatterns grounded in the evidence packet.",
    "Prefer the evidence packet when it is strong and complete; do not contradict clear manifests or sample test paths.",
    "Prefer the existing currentSettings when they already match the evidence.",
    "Use evidence.host.platform and evidence.host.isWindows when proposing commands.test so the command matches the host shell.",
    "On Windows (win32), do not use ./ prefixes; prefer native Windows entrypoints from evidence when present (for example .bat or .cmd wrappers). Tools like npm remain fine as npm when that is the project stack.",
    "On POSIX hosts, prefer conventional POSIX invocation from evidence.",
    "Ground the command only in manifests, sample test paths, and currentSettings — never invent a stack.",
    "When tools are allowed and the repository has no build manifests (empty/greenfield), infer a single stack from the confirmed brief and propose matching commands.test and testPathPatterns. Explain that inference in summary.",
    "Never invent shell pipelines beyond a single test runner command.",
    "Return exactly one raw JSON object with top-level summary and configPatch fields. Do not use Markdown headings or code fences.",
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
    "",
    "WORK PACKET",
    JSON.stringify(packetForJson),
    ...outputContractLines(packet.role),
    `Expected output: ${packet.expectedOutput}`,
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
    `Continue the durable episode. For this turn, act as the ${packet.role} worker.`,
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
  if (EPISODE_ROLES.has(role)) {
    return [
      "Return exactly one JSON object matching the expected output contract.",
      "Do not write Markdown interview prose, headings, or reports as the deliverable.",
      "You may deliver that JSON via CreatePlan or as raw assistant result text.",
      "If using CreatePlan, the plan body is that JSON object (raw or one ```json fence) — nothing else.",
      "Do not write headings, research briefings, tables, or \"JSON alongside this plan\" Markdown in CreatePlan.",
      "Put codebase facts in JSON fields (summary, question context), not outside the object.",
    ];
  }
  return [
    "Return exactly one raw JSON object matching the expected output contract.",
    "Do not wrap the object in Markdown or split its fields into separate sections.",
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
