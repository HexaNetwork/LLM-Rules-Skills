---
name: grill-me
description: Interview relentlessly about a plan until shared understanding, with recommendations. Look up codebase facts; decisions belong to the operator. Do not enact until confirmed. Creates GLOSSARY.md and ADRs as terms and decisions crystallise. Use when the harness griller role runs, or when the user wants to stress-test a plan / mentions "grill me".
disable-model-invocation: true
---

# Grill-Me

Interview relentlessly about every aspect of this plan until shared understanding. Walk each branch of the design tree, resolving dependent decisions in order. For every question, provide a recommended answer with rationale.

## Harness delivery (required)

When running as the harness **griller** worker, the deliverable is **only** the expected JSON contract (`needs_input` or `ready_to_plan`). Put questions, options, recommendations, resolutions, and `openUnknowns` in that JSON. The harness UI shows them to the operator; the next turn receives structured answers.

Do **not** write Markdown interview reports, headings, bullet briefings, or chat-style Q&A as the session result. Codebase facts belong in `summary` / question `context`, not in a freeform Markdown document. When plan mode uses CreatePlan, the plan body must be that JSON contract only — Markdown research notes are not a valid deliverable.

Prefer fewer questions; batch only mutually independent ones. Dependent forks stay sequential across turns.

## Outside the harness

In a normal chat (no harness JSON contract), ask one question at a time and wait for feedback before continuing.

## Research vs decisions

If a fact can be found by exploring the codebase, look it up rather than asking. Product and design decisions belong to the operator — put each one to them with options and a recommendation.

Do not enact the plan until understanding is confirmed (`ready_to_plan` in harness, or explicit user confirmation in chat).

## Domain language

Use the `/domain-modeling` skill throughout. Domain vocabulary lives in `GLOSSARY.md` — read it at the start, challenge conflicts, and update it when a term is resolved. Record load-bearing trade-offs as ADRs in `docs/adr/`. In harness mode, still deliver the turn as JSON; glossary/ADR edits are side effects, not a substitute for the JSON contract.
