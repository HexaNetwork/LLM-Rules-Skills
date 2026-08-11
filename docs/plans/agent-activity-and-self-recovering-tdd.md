# Agent activity timeline and self-recovering TDD

**Status:** implemented (core path)  
**Scope:** `packages/agent-harness`  
**Primary outcomes:** replace the misleading session-card grid; preserve strict RED/GREEN evidence; recover from bounded implementation and test defects without circular model calls.

**Implementation notes (2026-08-10):** Delivery slices 1–7 are in the harness. Runnable RED writer (`red-writer`) plus scaffolds-on-`affectedPaths`, runnable-red gate, and first-implement false-repair fix are in place. Remaining polish: full temporary-worktree counterfactual RED isolation (current accept path validates meaningful RED in-place), dedicated Playwright coverage for the Agent activity timeline, and stricter per-invocation token circuit-breaker enforcement beyond UI warnings / `maxContextTurns`.

## Problem

The dashboard calls every persisted backend invocation a "session" even when several records reuse one provider context. A flat, reverse-chronological card grid hides that relationship and makes repeated turns look like newly spawned agents.

The execution loop has a related modeling problem. Retry eligibility is inferred from a task step and an attempt counter. It does not require evidence that the repository or failure changed, so the same deterministic failure can launch the same role repeatedly. The recorded-test guard also compares test paths with the branch `HEAD`, even though the test writer intentionally left those paths dirty. That makes a legitimate RED test indistinguishable from a later implementer edit.

## Vocabulary and hierarchy

Use these terms consistently in persisted records, API responses, UI copy, and documentation:

- **Provider context** — a retained provider conversation, identified by `providerSessionId`.
- **Invocation** — one harness request sent to a provider context. The existing `sessionId` is the durable invocation-record ID and remains readable for backward compatibility.
- **Schema attempt** — a structured-output repair within one logical invocation (`attempt`).
- **Step** — a provider tool/reasoning activity recorded in `*.steps.jsonl`.
- **RED checkpoint** — a harness-owned Git commit containing verified failing tests and optional minimal compile scaffolds on declared production seams.

The UI hierarchy is:

```text
Run
└─ provider context
   ├─ invocation / turn 1
   │  └─ tool and reasoning steps
   ├─ invocation / turn 2 (context reused)
   └─ invocation / turn 3 (context reused)
```

Do not use “session” as a countable user-facing synonym for invocation.

## Part A — replace the Sessions grid

### A1. Persist causal invocation metadata

Extend each newly written invocation record with harness-authored metadata:

```ts
{
  taskId?: string;
  phase?: RunPhase;
  taskStep?: BuildTask["step"];
  invocationKind:
    | "initial"
    | "continuation"
    | "implementation-repair"
    | "test-repair"
    | "review-repair"
    | "schema-repair";
  trigger: {
    event: string;
    classification: string;
    summary: string;
    previousInvocationId?: string;
    evidenceFingerprint?: string;
  };
}
```

The coordinator continues to persist `providerSessionId`, `providerSessionReused`, `invocationId`, and `attempt`. The harness supplies causal metadata; models do not report or infer it.

Add a derived `contextTurn` in the run-read projection by ordering records with the same non-empty `providerSessionId`. It need not be persisted. Historical records without causal metadata remain inspectable and show `Reason unavailable for historical invocation`.

### A2. Return provider-context groups from the read API

Keep the existing flat `sessions` response during migration and add:

```ts
agentActivity: {
  providerContexts: Array<{
    id: string;
    role: AgentRole | "mixed";
    model: string;
    startedAt: string;
    endedAt?: string;
    status: "running" | "completed" | "failed" | "cancelled";
    invocationCount: number;
    schemaRepairCount: number;
    usage: Usage;
    invocations: InvocationSummary[];
  }>;
  totals: {
    providerContexts: number;
    invocations: number;
    continuedInvocations: number;
    schemaRepairs: number;
  };
}
```

Records without `providerSessionId` form one synthetic context per invocation. Aggregate usage from invocation records exactly once; do not add provider-context totals back into run usage.

### A3. Replace the card grid with an activity timeline

Rename the tab from **Sessions** to **Agent activity**. Replace `.session-grid` with a full-width chronological list grouped by provider context.

Each collapsed context row shows:

- role and task title;
- model;
- status;
- `1 provider context · N invocations`;
- total duration and token usage;
- warning when one invocation exceeds configured or relative usage thresholds.

Expanding a context displays connected invocation rows:

```text
20:07  Turn 1  NEW CONTEXT       initial implementation       329K
20:10  Turn 2  REUSED CONTEXT    test-integrity repair        400K
20:12  Turn 3  REUSED CONTEXT    repeated evidence blocked   4.33M ⚠
```

Each invocation row exposes its deterministic trigger, result, changed paths, command evidence, usage, and an **Inspect invocation** action. The existing inspector remains, but its title becomes `<role> · turn N of M`; `Context mode` becomes a prominent `NEW CONTEXT` or `REUSED CONTEXT` badge.

The overview replaces “model sessions” with separate metrics for provider contexts and invocations.

### A4. Compatibility and tests

- Parse existing `sessions/*.json` without migration.
- Group the current run’s three implementer records into one provider context with three invocations.
- Test unknown/missing provider IDs, mixed success/failure groups, schema-repair records sharing an `invocationId`, running records, usage aggregation, and stable chronological ordering.
- Add browser assertions for grouping, expansion, terminology, badges, warning state, and opening the existing inspector.
- Remove the legacy grid only after grouped and historical-data tests pass.

## Part B — RED checkpoint commits

### B1. Commit verified RED tests immediately

After the **red-writer** returns and the targeted command produces a **runnable RED** (tests compile, execute, and fail on assertions — not compile-only / missing-symbol failures):

1. Validate that every newly changed path is a configured test path **or** a declared `affectedPaths` scaffold.
2. Stage those exact paths (tests + optional scaffolds).
3. Commit them with a deterministic message and trailers:

   ```text
   test: establish RED for <task title>

   Harness-Checkpoint: red
   Harness-Checkpoint-Task: <task id>
   ```

4. Persist `redBaseSha`, `redCheckpointSha`, `redCheckpointNumber`, and the committed paths on the task.
5. Re-stamp the tree fingerprint and move to `red`.

`test-writer` remains a separate role for **test-repair only** (tests only; no production scaffolds). When `task.tdd === false`, the harness never enters `writing_tests` and never invokes `red-writer`.

This makes `git changedFiles()` after the checkpoint a valid indication of post-RED edits. The integrity check compares **recorded test paths** directly against `redCheckpointSha` (scaffolds are fair game for the implementer); it must not depend only on broad porcelain status.

Do not put the existing `Harness-Task` trailer on a checkpoint: `isTaskCommitted()` currently uses that trailer to identify the final task commit. If the process crashes after the Git commit but before state persistence, recovery finds `Harness-Checkpoint: red` plus `Harness-Checkpoint-Task` and attaches the commit idempotently instead of creating another checkpoint.

### B2. Preserve clean published history

RED checkpoints intentionally fail and are useful during execution, but should not make the final branch permanently non-bisectable.

Before creating the normal verified task commit:

1. Preserve checkpoint SHAs in task state and events.
2. Squash the task’s RED checkpoint commit(s) plus verified production changes into the existing atomic task commit.
3. Add `Harness-Red-Checkpoints: <sha,...>` to the final commit body.
4. Perform rewriting only on the unpushed harness-owned run branch and verify the expected branch/HEAD before changing it.

If a run blocks, leave the latest checkpoint commit intact so the branch is recoverable and label the branch state clearly in the UI.

### B3. Test integrity handling

Run the integrity guard immediately after an implementer invocation and before GREEN:

- unchanged versus `redCheckpointSha` → continue;
- changed recorded tests → restore those paths from the checkpoint, record `test_integrity.restored`, and preserve production edits;
- restoration changed no production path → do not consume an implementation attempt;
- repeated test edits by the same provider context → release that context and continue only under the no-progress policy below.

Restoration is deterministic. It does not require a fixer or operator approval because the harness is restoring its own committed checkpoint on its own branch.

## Part C — bounded self-recovery

### C1. Require progress before another invocation

Persist an `evidenceFingerprint` after every failed transition. Hash canonical representations of:

- task id and step;
- source-path content/tree state;
- RED checkpoint SHA;
- normalized failing-test identifiers and failure category;
- latest review/policy finding;
- relevant frozen configuration.

Before invoking an agent for a repair:

- a new fingerprint permits a bounded repair;
- the same fingerprint with no new operator input produces `task.no_progress` and does not call a model;
- a previously seen role-transition edge for the same fingerprint is rejected, preventing implementer ↔ test-writer ping-pong.

Attempt counters increase only after an invocation that was eligible under this rule. Deterministic restore, command normalization, baseline comparison, and resume checks do not consume model attempts.

### C2. Deterministic failure routing

Route from observed evidence rather than a generic failed step:

| Classification | Default action |
| --- | --- |
| command did not launch / wrong host entrypoint | deterministic config repair; no model retry |
| recorded test changed after RED | restore from RED checkpoint; no model retry |
| production compile or behavioral assertion failure | implementer repair |
| missing production symbols before any implementation attempt | implementer (never test-repair on `implementation === 0`) |
| diagnostic points only to test compilation/setup **after** an implementation attempt | test-repair candidate (`test-writer`) |
| unchanged known baseline failures | proceed or block according to baseline policy; no implementer retry |
| malformed worker JSON | bounded schema repair inside the same logical invocation |
| repeated evidence fingerprint | stop as `no_progress` |
| provider/timeout failure | bounded provider retry, normally with fresh context after threshold |

Add failure kinds for `test_integrity`, `verification`, `baseline`, and `no_progress`. Reserve `contract` for output-schema failures.

### C3. Allow a later test writer without weakening TDD

Do not launch a test writer merely because an implementer failed. Permit the transition only for a `test-repair candidate` classification, an explicit independent review finding, or an implementer’s structured blocker corroborated by compiler/test diagnostics.

The repair test writer receives the task contract, current RED checkpoint, and relevant failure evidence. It may edit tests only. After it returns:

1. Commit only its test changes as a candidate RED checkpoint.
2. In an isolated temporary worktree at that candidate commit, run the targeted test against production code from `redBaseSha`.
3. Accept the checkpoint only if the test still produces a meaningful, task-relevant RED.
4. Reject and roll back the candidate checkpoint if it passes against baseline, fails for infrastructure reasons, removes required behavioral assertions, or repeats a prior checkpoint/failure fingerprint.
5. Restore the current implementation workspace, update its test files to the accepted checkpoint, and return to the implementer with a fresh evidence fingerprint.

Allow at most one accepted test-repair checkpoint per unique implementation-failure fingerprint by default. Additional transitions require genuinely new evidence or operator direction.

Counterfactual RED does not prove that every expected value is correct, so normal independent review still evaluates test intent against acceptance criteria.

### C4. Context reuse policy and budgets

- Reuse a provider context only when the prior invocation made measurable progress and the next instruction directly continues that work.
- Release the context after a repeated integrity violation, a repeated evidence fingerprint, or a configured turn/token threshold.
- A fresh context receives a compact deterministic handoff; it does not receive the entire previous transcript.
- Add nonzero per-invocation, per-task, and per-run token ceilings plus tool-step and elapsed-time ceilings.
- Surface circuit-breaker decisions as harness events and in Agent activity; they are not model failures.

## State-machine sketch

```text
writing_tests (tdd only; red-writer)
  └─ runnable RED
       └─ commit RED checkpoint (tests + optional scaffolds)
            └─ implementing
                 ├─ recorded test changed → restore → evaluate progress
                 ├─ implementation failure → implementer repair
                 ├─ test-repair candidate (after impl attempt) → bounded test-writer
                 │    ├─ counterfactual RED accepted → new checkpoint → implementing
                 │    └─ rejected/repeated → no_progress or blocked
                 └─ targeted GREEN
                      └─ gates → review → squash checkpoint(s) → task commit
```

## Delivery slices

1. **Terminology and read model:** grouped API projection, new metrics, compatibility tests.
2. **Agent activity UI:** grouped timeline, invocation inspector copy, usage warnings, browser tests.
3. **Initial RED checkpoint:** explicit-path commit, crash recovery, SHA-based integrity guard.
4. **Deterministic restore and progress fingerprints:** eliminate circular retries before adding new role transitions.
5. **Test-writer re-entry:** evidence routing, counterfactual RED worktree, bounded transition graph.
6. **Final task squashing and checkpoint audit:** clean published history with durable provenance.
7. **Budgets and context rollover:** per-invocation limits and visible circuit breakers.

Each slice must ship with unit/integration tests and one scripted TDD lifecycle. Do not enable test-writer re-entry until the no-progress guard and RED checkpoint recovery are already active.

## Acceptance criteria

- The dashboard distinguishes provider contexts, invocations, schema attempts, and steps.
- Three implementer invocations sharing one `providerSessionId` render as one context with three turns.
- A verified runnable RED produces exactly one idempotent checkpoint commit containing test paths and optional compile scaffolds; integrity restores tests only.
- An implementer edit to a recorded test is restored before GREEN and does not consume an implementation attempt by itself.
- Identical deterministic evidence can never launch the same or alternating repair roles repeatedly.
- First implementing after RED never routes to test-repair for missing production symbols (`implementation === 0`).
- A repaired test must demonstrate RED against the pre-implementation production baseline before it becomes authoritative.
- Successful tasks publish as one atomic task commit while retaining checkpoint provenance in artifacts and trailers.
- Historical run artifacts remain readable.
- Usage totals are unchanged by UI grouping and are never double-counted.
