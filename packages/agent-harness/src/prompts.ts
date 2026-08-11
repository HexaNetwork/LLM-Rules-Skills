import type { AgentRole, WorkPacket } from "./domain.js";

export const ROLE_RULES: Record<AgentRole, string[]> = {
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
    "Do not edit the working tree. Produce a high-level plan only — not executable tickets.",
    "Capture the problem, solution, approach (modules and sequencing), constraints, and out-of-scope items.",
    "Do not emit a task list, BuildTasks, acceptance criteria tickets, or proposedInstalls.",
    "Plan from the confirmed reflect brief and grill resolutions only.",
    "openQuestions should usually be empty after grilling; list only genuine remaining blockers.",
    "When continuing to author a PRD, expand the approved plan into the PRD sections without inventing scope.",
    "Return exactly one raw JSON object matching the expected output contract. Do not use Markdown headings or code fences.",
  ],
  "issue-slicer": [
    "Do not edit the working tree. Produce executable tracer-bullet tickets only.",
    "Slice the supplied local PRD into narrow, complete vertical slices — not horizontal layers.",
    "Each task must be verifiable in one fresh agent context.",
    "Declare only genuine blocking edges and use the agreed domain vocabulary.",
    "Propose dependency installs needed before implementation in proposedInstalls; do not install them yourself.",
    "Return exactly one raw JSON object matching the expected output contract. Do not use Markdown headings or code fences.",
  ],
  "prompt-builder": [
    "Turn the packet into a precise prompt without changing scope or inventing facts.",
    "Preserve every acceptance criterion, constraint, selected guidance block, evidence block, and output contract.",
    "Return exactly one raw JSON object matching the expected output contract. Do not use Markdown headings or code fences.",
  ],
  "red-writer": [
    "Edit test files only. Do not add production scaffolds, configuration, localization, implementation wiring, or real behavior.",
    "Do not run test, compile, build, lint, verification, or other shell commands. The harness owns all command execution.",
    "Add the smallest coherent batch that meaningfully advances the feature, typically three to five tests. Each batch should cover a focused behavior cluster and include relevant edge cases, boundaries, invalid inputs, or exemption paths. Use judgment: prefer a parameterized test when several cases express the same rule, and stop when implementation feedback would help determine the next batch.",
    "Own edge-case discovery for the batch: boundaries, invalid inputs, exemptions, duplicates, absent relationships, and regressions that must remain unchanged when applicable.",
    "Reference production types, functions, methods, fields, routes, schema members, or other public interfaces that do not exist yet when that is what the seam requires. Compilation or equivalent pre-execution failure is acceptable until GREEN.",
    "Test public behavior at the agreed seam with independent expected values. Build on accumulated tests and do not duplicate already covered behaviors.",
    "Return status continue when adding a batch, or done only when the worktree is already at verified GREEN and no further tests are needed. A done turn must not change any files.",
    "Do not commit, push, or open a pull request.",
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
    "Every finding must include kind: production (implementation fix), test-coverage (missing tests), or advisory.",
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
    "When repairing a verification shell-launch failure, replace commands.verification with host-compatible config-owned commands grounded in the failure detail — do not invent a stack.",
    "The work packet is complete. Do not call tools, inspect files, or search the repository.",
    "Return exactly one raw JSON object with top-level summary and configPatch fields. Do not use Markdown headings or code fences.",
  ],
  "project-profiler": [
    "You only propose verification settings for this repository. Do not edit files.",
    "Propose the complete commands.verification collection, optional commands.testTargetTemplate, and workflow.testPathPatterns grounded in the evidence packet.",
    "Prefer the evidence packet when it is strong and complete; do not contradict clear manifests or sample test paths.",
    "Prefer the existing currentSettings when they already match the evidence.",
    "Use evidence.host.platform and evidence.host.isWindows when proposing verification commands so they match the host shell.",
    "On Windows (win32), do not use ./ prefixes; prefer native Windows entrypoints from evidence when present (for example .bat or .cmd wrappers). Tools like npm remain fine as npm when that is the project stack.",
    "On POSIX hosts, prefer conventional POSIX invocation from evidence.",
    "Ground the command only in manifests, sample test paths, and currentSettings — never invent a stack.",
    "When tools are allowed and the repository has no build manifests (empty/greenfield), infer a single stack from the confirmed brief and propose matching verification commands, targeted-test template, and testPathPatterns. Explain that inference in summary.",
    "Never invent shell pipelines beyond a single test runner command.",
    "Return exactly one raw JSON object with top-level summary and configPatch fields. Do not use Markdown headings or code fences.",
  ],
};

/** Extra implementer rules applied when the work packet is for a TDD task. */
export const GREEN_IMPLEMENTER_RULES: readonly string[] = [
  "You are the green-implementer for this TDD task.",
  "Edit production paths only; never edit, weaken, delete, or bypass recorded tests.",
  "Return status green when you implemented the current batch, already_green when the batch already passes without needed production changes, or test_issue when a test is defective or contradicts the agreed seam.",
  "On test_issue, do not modify the test; report the path, reason, and evidence so the red-writer can repair it.",
  "Focus on the current coherent batch while respecting the overall public contract; do not intentionally anticipate uncovered behaviors.",
];

export function roleRulesFor(role: AgentRole): readonly string[] {
  return ROLE_RULES[role];
}

export function roleRulesForPacket(packet: WorkPacket): readonly string[] {
  if (packet.role === "implementer" && isTddWorkPacket(packet)) {
    return [...ROLE_RULES.implementer, ...GREEN_IMPLEMENTER_RULES];
  }
  return ROLE_RULES[packet.role];
}

function roleLabelForPacket(packet: WorkPacket): string {
  if (packet.role === "implementer" && isTddWorkPacket(packet)) return "green-implementer";
  return packet.role;
}

function isTddWorkPacket(packet: WorkPacket): boolean {
  if (!isRecord(packet.input)) return false;
  const task = packet.input.task;
  return isRecord(task) && task.tdd === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Role intro + role rules + compiled guidance pack (no WORK PACKET). */
export function renderGuidancePromptPreview(role: AgentRole, guidancePack: string): string {
  return [
    `You are the ${role} worker in a deterministic software-delivery harness.`,
    ...ROLE_RULES[role].map((rule) => `- ${rule}`),
    ...renderGuidancePack(guidancePack),
  ].join("\n");
}

export function renderPrompt(packet: WorkPacket): string {
  const { guidance: _guidance, guidancePack: _pack, ...packetForJson } = packet;
  return [
    `You are the ${roleLabelForPacket(packet)} worker in a deterministic software-delivery harness.`,
    "This is a fresh session. The work packet below is the complete handoff; do not assume hidden chat history.",
    ...roleRulesForPacket(packet).map((rule) => `- ${rule}`),
    ...packet.constraints.map((constraint) => `- ${constraint}`),
    ...renderGuidance(packet),
    "",
    "WORK PACKET",
    JSON.stringify(packetForJson),
    ...outputContractLines(packet),
    `Expected output: ${packet.expectedOutput}`,
  ].join("\n");
}

export function renderPromptBuilderPrompt(packet: WorkPacket): string {
  const { guidance: _guidance, guidancePack: _pack, ...packetForJson } = packet;
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
  options: {
    includeGuidance?: boolean;
    /** When supplied, rely on retained history and submit only this new input. */
    deltaInput?: unknown;
  } = {},
): string {
  const includeGuidance = options.includeGuidance !== false;
  if (options.deltaInput !== undefined) {
    return [
      "Continue the existing conversation; all prior instructions and context remain in force.",
      ...(includeGuidance
        ? ["Updated guidance for this and later turns:", ...renderGuidance(packet)]
        : []),
      "The only new authoritative input since the previous turn is:",
      JSON.stringify(options.deltaInput),
      "Return the same output contract as the previous turn.",
    ].join("\n");
  }
  return [
    `Continue the durable episode. For this turn, act as the ${roleLabelForPacket(packet)} worker.`,
    "Use the existing conversation and repository findings; do not repeat exploration already completed unless the new input invalidates it.",
    ...roleRulesForPacket(packet).map((rule) => `- ${rule}`),
    ...packet.constraints.map((constraint) => `- ${constraint}`),
    ...(includeGuidance ? renderGuidance(packet) : []),
    `Objective: ${packet.objective}`,
    "New authoritative input:",
    JSON.stringify(packet.input),
    ...outputContractLines(packet),
    `Expected output: ${packet.expectedOutput}`,
  ].join("\n");
}

const EPISODE_ROLES = new Set<AgentRole>(["griller"]);

function outputContractLines(packet: Pick<WorkPacket, "role" | "expectedOutput">): string[] {
  if (EPISODE_ROLES.has(packet.role)) {
    return [
      "Return exactly one JSON object matching the expected output contract.",
      "Do not write Markdown interview prose, headings, or reports as the deliverable.",
      "You may deliver that JSON via CreatePlan or as raw assistant result text.",
      "If using CreatePlan, the plan body is that JSON object (raw or one ```json fence) — nothing else.",
      "Do not write headings, research briefings, tables, or \"JSON alongside this plan\" Markdown in CreatePlan.",
      "Put codebase facts in JSON fields (summary, question context), not outside the object.",
    ];
  }
  const lines = [
    "Return exactly one raw JSON object matching the expected output contract.",
    "Do not wrap the object in Markdown or split its fields into separate sections.",
  ];
  if (packet.role === "planner") {
    const example = packet.expectedOutput.includes("userStories")
      ? '{"summary":"...","problemStatement":"...","solution":"...","userStories":["..."],"implementationDecisions":["..."],"testingDecisions":["..."],"outOfScope":["..."],"furtherNotes":"..."}'
      : '{"summary":"...","problemStatement":"...","solution":"...","approach":"...","constraints":["..."],"outOfScope":["..."],"openQuestions":[]}';
    lines.push(`Valid shape example: ${example}`);
  }
  return lines;
}

function renderGuidance(packet: WorkPacket): string[] {
  return renderGuidancePack(packet.guidancePack);
}

function renderGuidancePack(guidancePack: string): string[] {
  const pack = guidancePack.trim();
  if (!pack) return [];
  return ["", "GUIDANCE", pack];
}
