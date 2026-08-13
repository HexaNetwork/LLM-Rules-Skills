# ADR 0013: Alternating persistent RED/GREEN TDD loop

## Status

**Superseded** by the intent-first workflow ([intent-first-workflow plan](../plans/intent-first-workflow.md)): per-task RED/GREEN / `red-writer` / `tddLoop` machinery was removed. Historical runs with TDD steps remain readable but cannot be resumed. Kept for decision history.

Was: Accepted; extends [ADR 0001](0001-executable-agent-harness.md) / [ADR 0002](0002-durable-wayfinder-harness.md) task execution and the session-retention posture in [ADR 0009](0009-operational-intervention-and-budgets.md)

## Context

The previous TDD path was a one-shot sequence: write runnable failing tests, implement once, then run full verification. That pushed the red-writer to discover the entire suite before any implementation feedback, and it forced compilation/setup work into a single provider invocation on heavy repositories.

The harness already treats provider history as optional: every invocation has a complete work packet, and resume must work after a cold start. Retaining sessions across a multi-round loop is valuable for prompt caching and continuity, but must not become a second source of truth.

## Decision

- **Alternate two logical agents per TDD task:** one red-writer and one green-implementer (internal role id remains `implementer` for compatibility; UI/prompts may say green-implementer).
- **Retain one provider session per role** across rounds for that task so discoveries and cache warm across batches. Release both sessions on completion, failure, cancellation, or abandonment.
- **Treat retained sessions as an optimization, not durable correctness state.** Round number, pending/completed rounds, coverage, checkpoints, and evidence live in the worktree and `tddLoop` ledger on `state.json`. A provider restart cold-starts either role from that ledger; continuation packets carry only new round facts, not full transcripts.
- **RED owns tests only** (`workflow.testPathPatterns`). RED does not run harness commands; GREEN is independently verified with the config-owned targeted command before the next RED batch.
- **Final verification and review run only after RED `done`** at a verified-green checkpoint. `workflow.maxTestAttempts` limits per-round RED revisions, not round count; `maxImplementationAttempts` is per-round GREEN and resets after GREEN; post-done repairs use `tddLoop.finalRepairAttempts`.
- **Bump `CONFIG_VERSION`** when this behavior ships, for frozen-config hash hygiene. No behavior branching hangs off the version.

## Consequences

- TDD tasks may take many RED/GREEN rounds with two long-lived provider contexts; UI/CLI must show round, active role, session turns, and coverage.
- Operators must not assume final gates after every RED batch, or that `maxTestAttempts` caps the number of rounds.
- Scripted backends and tests must cover multi-round session reuse, cold-start resume, cancellation session release, and independent context rotation per role.
- Non-TDD tasks keep the existing single-implementation flow.
