---
name: grill-me
description: Interview relentlessly about a plan until shared understanding, with recommendations. Look up codebase facts; decisions belong to the operator. Do not enact until confirmed. Creates GLOSSARY.md and ADRs as terms and decisions crystallise. Use when the harness griller role runs, or when the user wants to stress-test a plan / mentions "grill me".
disable-model-invocation: true
---

# Grill-Me

Interview relentlessly about every aspect of this plan until shared understanding. Walk each branch of the design tree, resolving dependent decisions in order. For every question, provide a recommended answer with rationale.

## Harness delivery (required)

When running as the harness **griller** worker, the deliverable is **only** the expected JSON contract. The supplied fog register is durable state: omission never resolves an entry. Link every question to its existing `fogIds`; add only genuinely new entries through `newUnknowns`; resolve codebase facts through `resolvedUnknowns` with a concrete evidence-backed reason. Product decisions must be answered by the operator, not placed in `resolvedUnknowns`.

Each question must use structured options the dashboard can render as cards:

```json
{
  "id": "tone",
  "fogIds": ["fog-interface-tone"],
  "prompt": "Which tone should the interface use?",
  "context": "Optional why-this-matters note",
  "options": [
    { "id": "quiet", "label": "Quiet", "description": "Restrained presentation supports focused work." },
    { "id": "energetic", "label": "Energetic", "description": "Stronger emphasis makes progress more prominent." }
  ],
  "recommendedOptionId": "quiet",
  "recommendation": "Use quiet because this is a long-running work surface."
}
```

The complete result shape is:

```json
{
  "questions": [],
  "newUnknowns": [{ "id": "fog-new-stable-id", "text": "A genuinely new unknown" }],
  "resolvedUnknowns": [{ "id": "fog-existing-id", "reason": "Concrete codebase evidence" }]
}
```

An empty `questions` list is valid only when every fog entry is already resolved or parked, including entries explicitly resolved in the same result.

Do **not** write Markdown interview reports, headings, bullet briefings, or chat-style Q&A as the session result. Codebase facts belong in `summary` / question `context`, not in a freeform Markdown document. When plan mode uses CreatePlan, the plan body must be that JSON contract only — Markdown research notes are not a valid deliverable.

Prefer fewer questions; batch only mutually independent ones. Dependent forks stay sequential across turns.

## Outside the harness

In a normal chat (no harness JSON contract), ask one question at a time and wait for feedback before continuing.

## Research vs decisions

If a fact can be found by exploring the codebase, look it up rather than asking. Product and design decisions belong to the operator — put each one to them with options and a recommendation.

Do not enact the plan until understanding is confirmed (`ready_to_plan` in harness, or explicit user confirmation in chat).

## Domain language

Use the `/domain-modeling` skill throughout. Challenge conflicts as terms are resolved. In harness mode, do not edit glossary files: return the resolutions in the JSON contract so the small `docs-writer` can update the glossary once the operator confirms the completed session. Outside the harness, read `GLOSSARY.md` at the start and update it when a term is resolved. Record load-bearing trade-offs as ADRs (`domainArtifacts.adrDirs` in harness, otherwise `docs/adr/`). In harness mode, ADR edits are side effects, not a substitute for the JSON contract.
