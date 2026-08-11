# ADR 0009: Operational intervention, repository locking, and spend ceilings

## Status

Accepted; shared-working-tree lock grain superseded for worktree-backed runs by [ADR 0010](0010-per-run-worktrees.md). Legacy-shared runs (missing `workspace.json`) still follow this ADR's repository-lock semantics until explicitly migrated.

## Context

The harness is trustworthy when a run completes, and opaque or unrecoverable when it does not. Four operational gaps share one through-line: the operator needs levers that do not queue behind the work they interrupt, the shared working tree needs exclusive ownership while any run mutates it, spend must stop between steps rather than after a surprise bill, and repair must reuse implementer context without collapsing the independent review boundary.

Cancellation previously shared the UI server's FIFO with every other mutation. While a run was mid-`advance`, Cancel returned 409 or sat behind the job it was meant to stop. The per-run lock protected `state.json` only; nothing serialised branch switches and `changedFiles()` across a CLI `advance` beside the UI. Usage was summed for display and never enforced. Each implementation repair spawned a cold implementer that re-explored the tree from scratch.

## Decision

- **Cancellation is out-of-band.** `cancel` writes `<runDir>/cancel.request` without taking the run lock, aborts any in-process `AbortController` registered by `advance`, and only then tries a short bounded lock wait to complete the `cancelled` transition. The UI route calls `engine.cancel` directly and never enqueues. The advancing loop checks the request (and its own abort) before and after each step, completes the transition itself when needed, and never classifies an abort as a retriable provider failure.
- **The repository is the lock grain.** `start` (preflight / Graphify / knowledge refresh) and `advance` take `<stateDirectory>/repo.lock` before the run lock. Lock order is always repository → run. Human input (`answer`, `answerMany`, `addNote`), `status`, and `cancel` do not take the repository lock. Hold time matches the work; that is correct with one shared working tree. True parallelism waits on isolated worktrees ([Parallel task execution](../roadmap.md#parallel-task-execution)).
- **Usage is recomputed, not incremented.** After each budget-consuming step, sum usage across `sessions/*.json` and replace the total on `RunState`. Enforce `workflow.maxRunTokens` / `workflow.maxRunCostUsd` between steps only — never abort an in-flight agent call for budget. Optional `models.pricing` turns tokens into a cost lower bound; unpriced models contribute tokens and zero cost. Raising a ceiling rewrites the frozen run snapshot via `retry --max-run-tokens` / `--max-run-cost-usd` (with `--force` for budget blocks).
- **The reviewer stays cold; the implementer may retain a session.** Repair turns resume the task's implementer episode with continuation input (review findings and latest evidence). The reviewer always starts fresh so it cannot approve its own prior work in-context. Session retention is an optimisation: a process restart cold-starts; the full packet remains the recovery path.

## Consequences

- An operator can cancel a multi-hour run without killing the process, and cancellation cannot be mis-classified into the provider-retry path.
- Concurrent runs against one tree fail fast with a holder-aware message instead of interleaving git state. Stale holders are cleared with `agent-harness unlock --repo`.
- Unattended runs have a hard spend stop that survives restarts and includes failed attempts and provider retries. Budget recovery is an explicit raise-and-retry, not an edit to the project config alone.
- Implementation repair reuses exploration and prompt-cache where the provider allows it, without weakening independent review.
- Planner-authored shell commands have since been removed: verification is config-owned and per-task targeting is a validated filter applied to a config-owned template.
