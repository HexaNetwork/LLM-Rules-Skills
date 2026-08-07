# ADR 0007: A single budget authority owns every byte entering a prompt

## Status

Accepted

## Context

Work packets already separated durable run state from agent handoffs, but packet assembly still mixed unbounded `input` (including full command evidence) with retrieval context. Guidance was rendered twice, and roles that cannot use retrieval still paid for it. Evidence belonged in the audit trail at full fidelity, yet projecting that same evidence into every repair prompt dominated token cost precisely when a task was struggling.

## Decision

A single module (`buildWorkPacket`) is the budget authority for every byte that enters a prompt. It applies separate ceilings for guidance+context, serialized `input`, and Graphify excerpts, and records every truncation in the packet's retrieval sibling audit (`{ retrieval, budget }`).

Command evidence remains durable on `RunState` at the full capture limits. Packet projections use a newest-first, budgeted renderer (`recentEvidenceOutput`) and a `taskForPacket` shape that drops `evidence` entirely. Roles that cannot use retrieval (`message-writer`, and any future caller that sets `retrieval: false`) skip guidance and search; callers that enable retrieval must supply an explicit `knowledgeQuery`.

## Consequences

- Future packet fields must pass through `buildWorkPacket` rather than being assembled ad hoc in `AgentCoordinator`.
- Prompt renderers may present guidance human-readably once, but must not re-embed the same excerpts in the JSON packet view.
- Repair loops stay bounded even when durable evidence grows; audits stay complete.
