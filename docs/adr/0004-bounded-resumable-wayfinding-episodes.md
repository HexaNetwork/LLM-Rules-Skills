# ADR 0004: Bounded resumable episodes preserve wayfinding context

## Status

Accepted; interview interaction model amended by [ADR 0008](0008-visible-fog-and-batched-grill-questions.md)

## Context

ADR 0002 made every decision a fresh provider agent so recovery never depended on hidden chat state. A real trial resolved eight decisions and processed three human answers using 2.55 million reported tokens across twenty completed provider agents, plus two failed calls whose usage was not retained. Most tokens came from repeated agent/tool exploration rather than the persisted prompts themselves.

Wayfinding is conversational: navigation, research, and successive human answers build one body of understanding. Recreating that understanding for every ticket prevents conversational prefix reuse and encourages repeated repository reads. Planning, implementation tasks, and independent review still benefit from clean boundaries.

## Decision

- Group navigation, AFK decisions, and HITL facilitator turns into a **wayfinding episode** backed by one resumable provider agent.
- Bound an episode with `workflow.maxWayfindingTurnsPerEpisode` (six turns by default). Roll to a new provider agent after the limit.
- Persist the episode number, provider agent ID, turn count, and timestamps in `state.json`. Persist every individual invocation in `sessions/` as before.
- On a successful provider resume, append a compact continuation containing the new objective and authoritative input. Do not resend retrieved context or repeat repository exploration unless new input invalidates prior findings.
- Keep a complete persisted work packet for every invocation. If resume fails, create a fresh provider agent and submit the complete deterministic prompt; provider state is never required for correctness or recovery.
- Reuse the current provider agent for structured-output repair and persist usage/output before schema validation so invalid responses remain accountable.
- Disable prompt compilation by default and always bypass it during wayfinding. The deterministic prompt renderer remains authoritative.
- Close the episode when the route reaches planning. Planning, task execution, review, and publication retain separate context boundaries.

## Consequences

- Several Q→A turns can share codebase findings and a stable conversational prefix, reducing repeated exploration and enabling provider caching where supported.
- A process restart can attempt `Agent.resume`; missing or expired provider state degrades to a complete fresh packet rather than blocking the run.
- Token accounting includes invalid structured outputs, provider run IDs, context-reuse status, and any cache telemetry returned by the provider.
- Episode rollover limits stale assumptions and context growth. The configured limit can be tuned from measured runs without changing the artifact contract.
- Provider-specific conversation behavior must be verified by an end-to-end smoke run; deterministic fake-backend tests cover orchestration and fallback semantics.
