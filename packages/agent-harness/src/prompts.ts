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
    "Return exactly one JSON object matching the expected output contract. Do not write Markdown plan prose, headings, or reports as the deliverable. If you use CreatePlan, the plan body must be that JSON only — not a Markdown research plan.",
  ],
  "scenario-planner": [
    "Do not edit the working tree. Author intent-level test scenarios only — not executable test code or tickets.",
    "Cover the PRD user stories and plan approach with happy-path and error-path scenarios.",
    "Each scenario must state intent, given, when, and then in operator-readable language.",
    "Use stable scenario ids that issue-slicer can reference later.",
    "Return exactly one raw JSON object matching the expected output contract. Do not use Markdown headings or code fences.",
  ],
  "issue-slicer": [
    "Do not edit the working tree. Produce executable tracer-bullet tickets only.",
    "Slice the supplied local PRD into narrow, complete vertical slices — not horizontal layers.",
    "Tag each task with scenarioIds from the supplied scenario register when the task contributes to that scenario.",
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
  "scenario-writer": [
    "Edit the working tree but never commit, push, or open a pull request.",
    "Implement the supplied scenario intent as automated tests only — do not change production code.",
    "Changed files must match the configured test path patterns.",
    "Return exactly one raw JSON object matching the expected output contract. Do not use Markdown headings or code fences.",
  ],
  "unit-test-writer": [
    "Edit the working tree but never commit, push, or open a pull request.",
    "Write unit tests that crystallize current production behavior and raise coverage — do not change production code.",
    "Changed files must match the configured test path patterns.",
    "Return exactly one raw JSON object matching the expected output contract. Do not use Markdown headings or code fences.",
  ],
  implementer: [
    "Edit the working tree but never commit, push, or open a pull request.",
    "Treat supplied command output as ground truth and fix the reported behavior.",
    "Use the supplied verificationCommands to compile or run project checks while iterating; the harness reruns them authoritatively after you finish.",
    "Do not write, edit, weaken, delete, or bypass tests during implementation; tests are authored in later run phases.",
    "During scenario_testing repairs, do not edit scenario test paths supplied in the packet.",
    "Return exactly one raw JSON object matching the expected output contract. Do not use Markdown headings or code fences.",
  ],
  reviewer: [
    "Do not edit files.",
    "Block only for a demonstrable correctness, security, or acceptance failure.",
    "Use advisory findings for optional improvements.",
    "Every finding must include kind: production, test-coverage, test-design, scenario-intent, or advisory.",
    "During final_review, consider the full base..HEAD diff plus scenario and coverage evidence.",
    "The diff is the primary evidence. Read the listed omitted files from disk before commenting on them.",
    "Return exactly one raw JSON object matching the expected output contract. Do not use Markdown headings or code fences.",
  ],
  "task-reviewer": [
    "Do not edit files.",
    "Block only for a demonstrable production correctness, security, or production-acceptance failure (kind: production).",
    "Missing tests, missing scenario implementations, and coverage gaps are expected at this phase; emit them only as advisory findings.",
    "Do not treat passing verification commands as proof that new tests exist, or as a reason to block when they do not.",
    "Use advisory findings for optional improvements.",
    "Every finding must include kind: production, test-coverage, test-design, scenario-intent, or advisory.",
    "The packet diff is the primary evidence. Read listed omitted files from disk before commenting on them.",
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

export function roleRulesFor(role: AgentRole): readonly string[] {
  return ROLE_RULES[role];
}

export function roleRulesForPacket(packet: WorkPacket): readonly string[] {
  return ROLE_RULES[packet.role];
}

function roleLabelForPacket(packet: WorkPacket): string {
  return packet.role;
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

const CREATE_PLAN_JSON_ROLES = new Set<AgentRole>(["griller", "planner"]);

function outputContractLines(packet: Pick<WorkPacket, "role" | "expectedOutput">): string[] {
  if (CREATE_PLAN_JSON_ROLES.has(packet.role)) {
    const lines = [
      "Return exactly one JSON object matching the expected output contract.",
      packet.role === "griller"
        ? "Do not write Markdown interview prose, headings, or reports as the deliverable."
        : "Do not write Markdown plan prose, headings, or reports as the deliverable.",
      "You may deliver that JSON via CreatePlan or as raw assistant result text.",
      "If using CreatePlan, the plan body is that JSON object (raw or one ```json fence) — nothing else.",
      "Do not write headings, research briefings, tables, or \"JSON alongside this plan\" Markdown in CreatePlan.",
    ];
    if (packet.role === "griller") {
      lines.push(
        "Put codebase facts in JSON fields (summary, question context), not outside the object.",
      );
    }
    if (packet.role === "planner") {
      const example = packet.expectedOutput.includes("userStories")
        ? '{"summary":"...","problemStatement":"...","solution":"...","userStories":["..."],"implementationDecisions":["..."],"testingDecisions":["..."],"outOfScope":["..."],"furtherNotes":"..."}'
        : '{"summary":"...","problemStatement":"...","solution":"...","approach":"...","constraints":["..."],"outOfScope":["..."],"openQuestions":[]}';
      lines.push(`Valid shape example: ${example}`);
    }
    return lines;
  }
  return [
    "Return exactly one raw JSON object matching the expected output contract.",
    "Do not wrap the object in Markdown or split its fields into separate sections.",
  ];
}

function renderGuidance(packet: WorkPacket): string[] {
  return renderGuidancePack(packet.guidancePack);
}

function renderGuidancePack(guidancePack: string): string[] {
  const pack = guidancePack.trim();
  if (!pack) return [];
  return ["", "GUIDANCE", pack];
}
