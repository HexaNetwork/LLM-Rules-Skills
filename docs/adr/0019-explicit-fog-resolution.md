# ADR 0019: Resolve fog explicitly by stable identifier

## Status

Accepted; replaces the omission-based reconciliation rule in [ADR 0008](0008-visible-fog-and-batched-grill-questions.md)

## Context

ADR 0008 treated each griller `unknowns` list as a complete projection. An existing entry omitted from the latest list became resolved. Because entries were matched by normalized prose, a griller that paraphrased an unknown created a new entry and silently resolved the old one. A later empty list could then resolve the entire register without an operator answer or recorded evidence.

Questions were also associated with fog by comparing question prompts to unknown text. A reasonable prompt rewrite therefore prevented an operator answer from resolving the intended entry.

## Decision

- Fog entries retain stable IDs for their lifetime. Text is presentation, not identity.
- Griller questions must reference one or more open `fogIds`. Operator answers and parks transition exactly those entries.
- Griller output uses `newUnknowns` only for genuinely new entries. Omitting an existing entry has no state effect.
- A codebase fact may be resolved through `resolvedUnknowns`, but each resolution must name an existing fog ID and include a concrete reason. The reason is persisted with the entry and in the run artifacts.
- Product decisions may not be agent-resolved; they remain open until answered or explicitly parked by the operator.
- A griller response with no questions blocks when any non-parked fog remains open. It cannot advance merely by returning an empty list.
- Invalid references, duplicate question links, and unreasoned resolutions block as retriable griller contract failures.

## Consequences

- Fog counts now describe recorded transitions rather than the latest model projection.
- Paraphrasing no longer creates a false resolution, and answers remain connected to the decision they address.
- Agents must use a stricter output contract. Older string-form `unknowns` are accepted only as additive entries during transition; omission is never destructive.
- Runs already corrupted by omission-based reconciliation are not automatically reopened because their lost intent cannot be reconstructed safely without operator review.
