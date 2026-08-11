# ADR 0012: Plan review gate, local PRD, and issue slicing

## Status

Accepted; extends [ADR 0001](0001-executable-agent-harness.md) and the grill-complete gate described in [ADR 0008](0008-visible-fog-and-batched-grill-questions.md)

## Context

The planner previously jumped from grill resolutions straight to executable `BuildTasks` (and optional `proposedInstalls`). Operators had no chance to review the product/technical approach before tickets and installs appeared. That conflated three different jobs: high-level planning, PRD authoring, and vertical-slice issue breakdown.

## Decision

- **Reviewed artifact is a high-level plan**, not final tasks. After verification gates, the `planner` role emits `{summary, problemStatement, solution, approach, constraints, outOfScope, openQuestions}` and the run pauses on `planReady` (`awaiting_input`).
- **`confirmPlan`** accepts optional edited plan JSON (dashboard) or feedback. Approve clears `planReady` and continues planning; feedback clears plan/PRD/tasks/undecided installs and cold-restarts the planner with `planFeedback`.
- **to-prd is a planner continuation** on the same retained `plannerEpisode.providerSessionId`. It writes a structured `prd` on run state and syncs `prd.md` via `LocalTracker`. No GitHub publish.
- **`issue-slicer` is a new AgentRole** that always starts cold. It materializes `BuildTasks` + `proposedInstalls` from the local PRD (`tasks.materialized`). Install approvals remain the next HITL pause when installs are pending.
- **No extra HITL** after PRD authoring or after slicing beyond the existing install gate.
- **Session policy:** retain planner only through to-prd success (or release on cancel / plan feedback). Never reuse a provider session for the slicer.
- **No `CONFIG_VERSION` bump:** run-state fields default safely; `issue-slicer` is added to role enums and guidance assignment defaults.

## Consequences

- Happy-path advance after grill confirmation now stops at `planReady` until the operator approves.
- Scripted/fake backends must supply two planner outputs (plan then PRD) plus an `issue-slicer` task payload.
- Local artifacts grow: `plan.md` and `prd.md` alongside `brief.md` / `grill.md` / `tasks/`.
- Operators edit the approach before tickets exist; task content is not re-edited on the plan gate after execution starts.
