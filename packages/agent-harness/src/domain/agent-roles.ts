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
  "image-fixer",
  "message-writer",
  "project-profiler",
] as const;

export const AgentRoleSchema = z.enum(AGENT_ROLES);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

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
    "Audit every open fog item; ask every independent unresolved product or design decision up to the batch limit.",
    "Treat the supplied fog register as durable state; never imply resolution by omitting an entry.",
    "Treat every supplied fog id as an opaque identifier: copy it exactly; never edit it, append a suffix, derive a partial id, or invent a replacement id.",
    "Link every question to one or more open fogIds.",
    "Return only genuinely new unknowns in newUnknowns, each with a stable id and text.",
    "Resolve codebase facts only through resolvedUnknowns with source code, the fog id, and a concrete evidence-backed reason.",
    "Never partially resolve a fog entry: if code settles only part while a product or design decision remains, keep the original fog open, link the question to its exact id, put the established code facts in the question context, and omit that id from resolvedUnknowns.",
    "Never reference the same fog id in both questions and resolvedUnknowns in one response.",
    "Code evidence may establish current behavior but must not silently choose product behavior; ask the user when a requirement or trade-off remains.",
    "Look up codebase facts; put product decisions to the human with a recommendation.",
    "Do not enact the plan; when understanding is sufficient, return ready_to_plan.",
    "Return exactly one JSON object matching the expected output contract. Do not write Markdown interview prose.",
  ],
  "docs-writer": [
    "Edit the working tree but never commit, push, or open a pull request.",
    "Update only glossary/PRD artifacts from the confirmed brief, operator resolutions, and evidence-backed fog resolutions.",
    "Do not describe a resolved fog entry as open, and do not invent new open items after the grill gate.",
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
  "image-fixer": [
    "Repair the worker Dockerfile so the missing tool or runtime from the verification failure becomes available; make only the minimal addition.",
    "Preserve the base image, the harness install steps, USER 10001:10001, WORKDIR /workspace, and the sleep-infinity CMD.",
    "Return the complete repaired Dockerfile, never a diff or fragment.",
    "Return exactly one raw JSON object matching the expected output contract.",
  ],
  "message-writer": [
    "Do not run git commands.",
    "Describe only verified changes present in the packet.",
    "Return exactly one raw JSON object matching the expected output contract.",
  ],
  "project-profiler": [
    "Infer verification commands and test globs from the repository; do not invent tooling.",
    "Always return a generic project-wide command when the repo has one, even if you also propose feature-specific commands.",
    "Feature-specific commands are optional; only include them when a narrower command clearly covers this brief.",
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
    '{questions:[{id:string,fogIds:[string],prompt:string,context?:string,options:[{id:string,label:string,description:string}],recommendedOptionId:string,recommendation:string}],newUnknowns:[{id:string,text:string}],resolvedUnknowns:[{id:string,source:"code",reason:string}]}',
  "docs-writer":
    "glossary phase: {glossary:[{term:string,definition:string}]}; prd phase: {title:string,body:string}",
  planner: "{plan:string}",
  "scenario-planner": "{scenarios:[{id:string,title:string,steps:[string]}]}",
  "issue-slicer": "{tasks:[{id:string,title:string,description:string}]}",
  implementer: "{summary:string,files:[string],note?:string}",
  "task-reviewer": '{verdict:"approve"|"reject",summary:string}',
  reviewer: '{verdict:"approve"|"reject",summary:string}',
  fixer: "{summary:string,passed:boolean}",
  "image-fixer": "{summary:string,dockerfile:string}",
  "message-writer": "{title:string,body:string}",
  "project-profiler":
    "{command:string,testGlobs:[string],rationale?:string,specificCommands?:[{id:string,label:string,command:string,rationale?:string}]}",
};

export function outputContractFor(role: string): string | undefined {
  if (role in ROLE_OUTPUT_CONTRACTS) return ROLE_OUTPUT_CONTRACTS[role as AgentRole];
  return undefined;
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
