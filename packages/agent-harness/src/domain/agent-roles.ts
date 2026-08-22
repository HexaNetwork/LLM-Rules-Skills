import { z } from "zod";

/** Roles the modular harness can invoke as workers. */
export const AGENT_ROLES = [
  "reflector",
  "griller",
  "docs-writer",
  "planner",
  "scenario-planner",
  "issue-slicer",
  "implementer",
  "task-reviewer",
  "reviewer",
  "fixer",
  "message-writer",
  "project-profiler",
] as const;

export const AgentRoleSchema = z.enum(AGENT_ROLES);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const GuidanceAssignmentSchema = z.object({
  rules: z.array(z.string().min(1)).default([]),
  skills: z.array(z.string().min(1)).default([]),
});
export type GuidanceAssignment = z.infer<typeof GuidanceAssignmentSchema>;

/** Exact skill/rule packs each role receives — not lexical grab-bag search. */
export const DEFAULT_ROLE_ASSIGNMENTS: Record<AgentRole, GuidanceAssignment> = {
  reflector: { rules: [], skills: ["domain-modeling"] },
  griller: { rules: [], skills: ["grill-me", "domain-modeling"] },
  "docs-writer": { rules: [], skills: ["domain-modeling"] },
  planner: { rules: [], skills: ["domain-modeling", "to-prd"] },
  "scenario-planner": { rules: [], skills: [] },
  "issue-slicer": {
    rules: [],
    skills: ["prd-to-issues", "domain-modeling", "improve-codebase-architecture"],
  },
  implementer: { rules: [], skills: [] },
  "task-reviewer": { rules: [], skills: ["task-review"] },
  reviewer: { rules: [], skills: ["code-review"] },
  fixer: { rules: [], skills: ["diagnose"] },
  "message-writer": { rules: [], skills: [] },
  "project-profiler": { rules: [], skills: [] },
};

export const RoleAssignmentsSchema = z
  .object({
    reflector: GuidanceAssignmentSchema.default(DEFAULT_ROLE_ASSIGNMENTS.reflector),
    griller: GuidanceAssignmentSchema.default(DEFAULT_ROLE_ASSIGNMENTS.griller),
    "docs-writer": GuidanceAssignmentSchema.default(DEFAULT_ROLE_ASSIGNMENTS["docs-writer"]),
    planner: GuidanceAssignmentSchema.default(DEFAULT_ROLE_ASSIGNMENTS.planner),
    "scenario-planner": GuidanceAssignmentSchema.default(
      DEFAULT_ROLE_ASSIGNMENTS["scenario-planner"],
    ),
    "issue-slicer": GuidanceAssignmentSchema.default(DEFAULT_ROLE_ASSIGNMENTS["issue-slicer"]),
    implementer: GuidanceAssignmentSchema.default(DEFAULT_ROLE_ASSIGNMENTS.implementer),
    "task-reviewer": GuidanceAssignmentSchema.default(DEFAULT_ROLE_ASSIGNMENTS["task-reviewer"]),
    reviewer: GuidanceAssignmentSchema.default(DEFAULT_ROLE_ASSIGNMENTS.reviewer),
    fixer: GuidanceAssignmentSchema.default(DEFAULT_ROLE_ASSIGNMENTS.fixer),
    "message-writer": GuidanceAssignmentSchema.default(DEFAULT_ROLE_ASSIGNMENTS["message-writer"]),
    "project-profiler": GuidanceAssignmentSchema.default(
      DEFAULT_ROLE_ASSIGNMENTS["project-profiler"],
    ),
  })
  .default(DEFAULT_ROLE_ASSIGNMENTS);

export type RoleAssignments = z.infer<typeof RoleAssignmentsSchema>;

export const ROLE_RULES: Record<AgentRole, string[]> = {
  reflector: [
    "Write restatement as the feature itself in plain language; do not invent requirements.",
    'Do not meta-frame restatement (for example "The operator wants to…" or "The request is…").',
    'Propose a concise imperative feature title suitable as a run label (for example "Add greeting tone"), not a paragraph.',
    "Separate goal, users, in-scope, out-of-scope, assumptions, and unknowns.",
    "Do not ask grilling questions and do not plan implementation.",
    "Look up codebase facts when they clarify existing behavior; do not decide product preferences.",
    "Return exactly one raw JSON object matching the expected output contract. Do not use Markdown headings or code fences.",
  ],
  griller: [
    "Ask only mutually independent questions in a single turn; dependent forks stay sequential.",
    "Prefer fewer questions; batch size is a ceiling, not a target.",
    "Return openUnknowns every turn — everything still needed before planning, including unasked items.",
    "Look up codebase facts; put product decisions to the human with a recommendation.",
    "Do not enact the plan; when understanding is sufficient, return ready_to_plan.",
    "Return exactly one JSON object matching the expected output contract. Do not write Markdown interview prose.",
  ],
  "docs-writer": [
    "Edit the working tree but never commit, push, or open a pull request.",
    "Update only glossary/PRD artifacts from the confirmed brief and grill resolutions.",
    "Preserve existing glossary entries unless a grill resolution sharpens or replaces them.",
    "Return exactly one raw JSON object matching the expected output contract.",
  ],
  planner: [
    "Do not edit the working tree. Produce a high-level plan only — not executable tickets.",
    "Plan from the confirmed reflect brief and grill resolutions only.",
    "Return exactly one JSON object matching the expected output contract.",
  ],
  "scenario-planner": [
    "Do not edit the working tree. Author intent-level test scenarios only.",
    "Cover happy-path and error-path scenarios in plain, observable product language.",
    "Do not include harness jargon (operator, phases, fog, packets) in scenario titles or steps.",
    "Return exactly one raw JSON object matching the expected output contract.",
  ],
  "issue-slicer": [
    "Do not edit the working tree. Produce executable tracer-bullet tickets only.",
    "Slice into narrow vertical slices — not horizontal layers.",
    "Return exactly one raw JSON object matching the expected output contract.",
  ],
  implementer: [
    "Edit the working tree but never commit, push, or open a pull request.",
    "Do not write, edit, weaken, delete, or bypass tests during implementation.",
    "Return exactly one raw JSON object matching the expected output contract.",
  ],
  "task-reviewer": [
    "Do not edit files.",
    "Block only for demonstrable production correctness, security, or acceptance failure.",
    "Missing tests are advisory at this phase, not blocking.",
    "Return exactly one raw JSON object matching the expected output contract.",
  ],
  reviewer: [
    "Do not edit files.",
    "Block only for a demonstrable correctness, security, or acceptance failure.",
    "Return exactly one raw JSON object matching the expected output contract.",
  ],
  fixer: [
    "Treat the reported failure and operator guidance as authoritative.",
    "Make only the minimal change needed; do not expand scope.",
    "Return exactly one raw JSON object matching the expected output contract.",
  ],
  "message-writer": [
    "Do not run git commands.",
    "Describe only verified changes present in the packet.",
    "Return exactly one raw JSON object matching the expected output contract.",
  ],
  "project-profiler": [
    "Infer verification commands and test globs from the repository; do not invent tooling.",
    "Return exactly one raw JSON object matching the expected output contract.",
  ],
};

export function roleRulesFor(role: string): readonly string[] {
  if (role in ROLE_RULES) return ROLE_RULES[role as AgentRole];
  return [];
}

/** Role-specific JSON output contracts appended to each worker's context. */
export const ROLE_OUTPUT_CONTRACTS: Record<AgentRole, string> = {
  reflector:
    "{proposedTitle:string,summary:string,restatement:string,goal:string,users:[string],inScope:[string],outOfScope:[string],assumptions:[string],unknowns:[string]}",
  griller:
    '{questions:[{id:string,prompt:string,context?:string,options:[{id:string,label:string,description:string}],recommendedOptionId:string,recommendation:string}],unknowns:[string]}',
  "docs-writer":
    "glossary phase: {glossary:[{term:string,definition:string}]}; prd phase: {title:string,body:string}",
  planner: "{plan:string}",
  "scenario-planner": "{scenarios:[{id:string,title:string,steps:[string]}]}",
  "issue-slicer": "{tasks:[{id:string,title:string,description:string}]}",
  implementer: "{summary:string,files:[string],note?:string}",
  "task-reviewer": '{verdict:"approve"|"reject",summary:string}',
  reviewer: '{verdict:"approve"|"reject",summary:string}',
  fixer: "{summary:string,passed:boolean}",
  "message-writer": "{title:string,body:string}",
  "project-profiler": "{command:string,testGlobs:[string]}",
};

export function outputContractFor(role: string): string | undefined {
  if (role in ROLE_OUTPUT_CONTRACTS) return ROLE_OUTPUT_CONTRACTS[role as AgentRole];
  return undefined;
}

export function assignmentFor(
  assignments: RoleAssignments,
  role: string,
): GuidanceAssignment {
  if (role in assignments) return assignments[role as AgentRole];
  return { rules: [], skills: [] };
}

export function renderGuidancePromptPreview(role: string, guidancePack: string): string {
  const pack = guidancePack.trim();
  return [
    `You are the ${role} worker in a deterministic software-delivery harness.`,
    ...roleRulesFor(role).map((rule) => `- ${rule}`),
    ...(pack ? ["", "GUIDANCE", pack] : []),
  ].join("\n");
}

/** Full worker context: role identity/rules, output contract, then the editable guidance body. */
export function renderRoleContext(role: string, guidanceBody: string): string {
  const contract = outputContractFor(role);
  const body = guidanceBody.trim();
  return [
    `You are the ${role} worker in a deterministic software-delivery harness.`,
    ...roleRulesFor(role).map((rule) => `- ${rule}`),
    ...(contract ? ["", "EXPECTED OUTPUT", contract] : []),
    ...(body ? ["", "GUIDANCE", body] : []),
  ].join("\n");
}
