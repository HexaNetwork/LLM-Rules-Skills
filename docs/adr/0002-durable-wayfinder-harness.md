# ADR 0002: Durable artifacts replace agent-session orchestration

## Status

Accepted; session-isolation decision amended by ADR 0004

## Context

The first executable prototype accumulated coupled lifecycle stages, provider-session resumption, UI state, manifest approval, specialized review loops, and tracker behavior. Although individual operations were bounded, recovery still depended on understanding a large orchestration surface and reconciling in-memory state with partially completed external work.

The desired workflow must carry a loose idea through product decisions and implementation, support genuine human back-and-forth, hand work between fresh contexts, run tests itself, choose TDD or implementation-first, launch different model tiers, work without an external tracker, and own git publication.

## Decision

Replace the prototype with a durable state machine centered on filesystem artifacts.

- Use a Wayfinder-style map to name the destination and separate precise decision tickets from fog and out-of-scope work.
- Use local Markdown as the default tracker. Keep the map as an index; store each resolution in exactly one issue.
- Launch every agent as a fresh, bounded session over a complete persisted work packet. Never require a provider session ID to resume. ADR 0004 later replaces fresh-per-decision execution with bounded resumable wayfinding episodes while preserving the complete packet as fallback.
- Freeze the run configuration beside state and reject a mismatched resume.
- Persist human questions and exact answers, returning control instead of polling or simulating the human.
- Generate tracer-bullet implementation tasks after the decision route is clear.
- Let the harness execute targeted tests and configured gates, then pass recorded output into bounded repair sessions.
- Route optional prompt compilation and git/PR copy to the small model; use deterministic fallbacks for these non-authoritative roles.
- Keep git commands in the harness, require a clean starting tree, and reject unreported paths before commit.
- Store configured documents and generated tracker artifacts in an offline lexical retrieval index. Optionally prepend bounded Graphify traversal output for structural repository lookup; Graphify remains a regenerable, fail-soft projection rather than durable workflow state.

## Consequences

- A run is recoverable from `.agent-harness/runs/<runId>/` without chat history.
- Hangs become bounded failures with an explicit retry point.
- Operators can inspect every model input and output contract.
- v2 initially favors sequential execution, a local tracker, and one Cursor backend. External trackers, isolated parallel worktrees, and semantic embeddings remain replaceable extensions rather than core state.
- ADR 0003 adds a loopback dashboard as a client of these artifacts without changing their authority.
- Exact source output is not reproducible because model output is stochastic; transition order, budgets, commands, evidence, and artifact contracts are deterministic.
