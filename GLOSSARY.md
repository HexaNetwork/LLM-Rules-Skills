# Agent Harness glossary

Map user-facing words and requests to these canonical terms for code, reviews, and agent prompts.

## Language

### Core

**Agent Harness**:
The executable orchestration system that prepares frozen implementation contracts, runs bounded Cursor SDK agent loops, verifies outcomes, and publishes verified results.
_Avoid_: implement-auto (the legacy prose skill), orchestrator (the engine is one part of the harness)

**Run manifest**:
The frozen, approved execution contract for one run: tasks, acceptance criteria, models, retry budgets, gates, and source hashes. It must not change during execution.
_Avoid_: plan, PRD, issue list (those are inputs that become a manifest)

**Run**:
One execution of an approved run manifest, including prepare/approve identity, worktree, events, and final report.
_Avoid_: session, job (prefer Run)

**Task**:
One independently accepted and committed change in a run, with acceptance criteria, dependencies, and allowed paths.
_Avoid_: issue (tracker input), ticket, story

**Worker**:
The durable code-mutating agent assigned to a task. It may be resumed for bounded command/spec repairs.
_Avoid_: implementer, coding agent

**Verifier**:
The independent evidence-producing agent that checks acceptance, correctness, and standards for a task or the full branch.
_Avoid_: reviewer (alone), code-review skill

**Gate**:
A machine-evaluated pass/fail condition owned by the harness (path scope, commands, schema-valid evidence, permissions).
_Avoid_: check, CI step (CI may implement a gate, but Gate is the harness concept)

**Repair attempt**:
A bounded response to failed evidence or commands. Exhausting the budget yields a typed blocked state, never an unbounded loop.
_Avoid_: retry (retry may mean infrastructure retry; repair attempt is product work)

### Lifecycle

**Prepare**:
The phase that researches implementation context, validates AFK readiness, and emits a draft run manifest without changing product acceptance criteria.

**Approve**:
The phase that freezes the draft into an immutable run manifest.

**Execute**:
The phase that runs an approved manifest in an isolated worktree until success, partial completion, or a typed blocked state.

**Resume**:
Continue a crashed or stopped run after verifying worktree, branch, HEAD, manifest hash, and completed gate evidence.

### Outcomes

**AFK task**:
A task whose acceptance criteria and dependencies are complete enough for unattended execution.
_Avoid_: automatic task, unsupervised task

**HITL task**:
A task that requires human product or architectural authority before execution.
_Avoid_: interactive task

**BLOCKING finding**:
A schema-valid verifier finding that demonstrably violates acceptance, correctness, security, or an explicit repository rule and therefore triggers repair.
_Avoid_: Critical, error

**ADVISORY finding**:
A schema-valid improvement suggestion that is recorded but never triggers repair or blocks commit.
_Avoid_: Suggestion, Nice-to-have, warning
