# Alternating persistent RED/GREEN TDD loop

## Purpose

Replace the current one-shot TDD sequence with a two-agent, multi-round loop:

1. A persistent **red-writer** session adds the next coherent batch of tests.
2. A persistent **green-implementer** session implements until the accumulated targeted tests pass.
3. The harness independently verifies GREEN.
4. The harness resumes the same red-writer session for another batch.
5. The cycle ends only when the red-writer returns `done` from an already verified-green checkpoint.

The worktree remains the primary handoff. Continuation packets contain only the new round facts, not
the agents' transcripts or repeated full command output. The normal loop has only two agent roles;
test correction is routed back to the same red-writer session rather than a third `test-writer`
agent.

This plan deliberately keeps the existing internal `implementer` role identifier for compatibility.
Within a TDD task it acts as the green-implementer and may be labelled **green-implementer** in the
UI. Renaming the enum, configuration keys, and guidance assignments is unrelated work and is out of
scope. Its stored session state does move under `tddLoop.greenImplementerSession` (see Durable
domain model); only the durable field changes, not the role.

## Why the current workflow must change

Today `TaskExecutionService` follows this path:

```text
writing_tests -> run targeted RED -> red -> implementing
              -> run targeted GREEN -> verifying (all configured gates)
              -> reviewing -> committing
```

The initial red-writer must produce a runnable assertion failure, may add production scaffolds, and
is followed by a single implementation phase. This encourages the red-writer to discover and write
the entire test suite before receiving implementation feedback. Tasks in statically compiled or
otherwise setup-heavy repositories can then require many reads, edits, compile repairs, and test
runs inside one provider invocation.

The target path is:

```text
writing_tests
  -> red checkpoint (no command is run)
  -> implementing
  -> targeted GREEN verification
  -> writing_tests
  -> ...
  -> red-writer done at a verified-green checkpoint
  -> final verification gates
  -> review
  -> commit
```

## Product decisions and invariants

These are authoritative for the implementation.

### Project-agnostic execution

- The loop must not assume a language, build tool, test framework, package manager, repository
  layout, or assertion-output format.
- Test ownership is derived only from configurable `workflow.testPathPatterns`.
- Targeted and final commands remain config-owned through `commands.testTargetTemplate` and
  `commands.verification`; agents never construct authoritative shell commands.
- A RED batch may reference any not-yet-existing public production surface, including types,
  functions, methods, fields, routes, schema members, command options, configuration keys, or other
  repository-native interfaces.
- GREEN verification is based on command exit status and stored evidence. Framework-specific output
  parsing may enrich diagnostics but must not control the core state transition.
- Git-disabled behavior and repositories without a compilation phase remain supported.

### Two logical agents with retained sessions

- Each TDD task owns one retained red-writer provider session and one retained implementer provider
  session.
- Both sessions are resumed across all rounds for that task so they retain codebase discoveries and
  benefit from provider prompt caching.
- A provider restart may cold-start either role. The durable round ledger and worktree must be a
  complete recovery handoff; correctness must never depend on hidden provider history.
- `workflow.maxContextTurns`, when non-zero, applies independently to each retained role. Reaching
  the limit rotates only that provider session and preserves the logical agent and ledger.
- Both provider sessions are released when the task completes, fails, is cancelled, or is otherwise
  abandoned.

### RED owns tests only

- The red-writer may edit only paths matching `workflow.testPathPatterns`.
- It may reference production types, functions, methods, fields, routes, schema members,
  configuration surfaces, or other public interfaces that do not exist yet. Compilation or
  equivalent pre-execution failure is acceptable between RED and GREEN.
- It may not add production scaffolds, configuration, localization, or implementation wiring.
- It does not run test, compile, build, lint, or verification commands. This is a role rule and an
  explicit prompt constraint. No selective tool policy exists today: the only backend
  (`cursor-backend.ts`) implements `allowTools` strictly as an all-or-nothing abort on the first
  tool call of any kind, which is unusable for the red-writer because it needs file
  search/read/edit tools. The step-audit fallback is therefore the only enforcement mechanism:
  audit streamed step records after the invocation and reject a RED turn that used `shell` or
  another command-execution tool (`SHELL_TOOL_NAMES` in `src/infrastructure/agents/step-utils.ts`
  is reusable for the classification). This requires new plumbing to surface observed tool names
  out of `invokeInEpisode`, where `onStep` is currently consumed by the session activity tracker.
  Post-hoc rejection does not recover the spent tokens and cannot undo test edits made by a shell
  command within the same turn when the resulting paths are test paths (the path check only
  catches non-test output), but it prevents a command-using RED turn from becoming authoritative.
  The harness also does not run commands after RED.
- The harness performs deterministic path and checkpoint checks after the red-writer returns.

### Soft batch guidance, including edge cases

The red-writer receives this guidance:

> Add the smallest coherent batch that meaningfully advances the feature, typically three to five
> tests. Each batch should cover a focused behavior cluster and include relevant edge cases,
> boundaries, invalid inputs, or exemption paths. Use judgment: prefer a parameterized test when
> several cases express the same rule, and stop when implementation feedback would help determine
> the next batch.

This is not a hard test-count limit. The output records normal behaviors separately from edge cases
so that later rounds and final review can see both kinds of coverage.

Relevant edge-case categories include, when applicable:

- minimum, maximum, and exact-boundary values;
- one step inside and outside a boundary;
- missing, empty, defaulted, malformed, or invalid input;
- exemptions and rule-precedence conflicts;
- repeated or duplicate operations;
- absent relationships or optional collaborators;
- regression behavior that must remain unchanged.

### GREEN owns production

- The implementer may edit production paths but never recorded test paths.
- It receives the task on its first turn. Later turns receive only the newly added test paths,
  behavior and edge-case descriptions, current round number, and concise prior GREEN evidence.
- It may run targeted commands while working. The harness independently reruns the config-owned
  targeted command only after the implementer returns `green` or `already_green`.
- It should implement the current coherent batch without intentionally anticipating uncovered
  behaviors. This is soft guidance, not a deterministic restriction.
- If a test is defective or contradicts the agreed seam, the implementer reports `test_issue`; it
  must not edit, weaken, delete, or bypass the test.

### GREEN is the only command boundary inside the loop

- No command is run by the harness after a RED batch.
- After a GREEN response, the harness runs the validated targeted command derived from
  `commands.testTargetTemplate` plus the task's `testFilter`.
- A passing targeted command completes the round and returns control to RED.
- A failing targeted command remains in the same GREEN round and resumes the same implementer
  session, unless it is explicitly routed to RED as a test issue.
- Full `commands.verification`, independent review, and commit happen only after RED declares the
  feature done.

### Completion

- `done` is valid only when the task has at least one completed GREEN round and the worktree is at a
  verified-green checkpoint.
- A `done` turn may not change any files.
- The red-writer supplies a final coverage assessment for acceptance criteria, primary behaviors,
  and relevant edge cases.
- The harness then runs final verification gates. The existing cold reviewer remains independent
  and reviews the complete task diff (for TDD tasks, `redBaseSha..worktree`, so every round's
  checkpoint-committed tests are included) and coverage assessment.
- If final gates or review require production repair, resume the same implementer session. After
  that repair becomes green, route through RED again before accepting completion so the red-writer
  can decide whether the repair exposes another missing test.
- Post-`done` repairs use a dedicated `finalRepairAttempts` budget, not the per-round implementer
  counter and not the cumulative `attempts.implementation` diagnostic counter.

## Target state machine

Retain the existing `BuildTask.step` values where possible. Their TDD meanings become:

| Step | Meaning in the alternating loop | Next step |
| --- | --- | --- |
| `pending` | Task has not started | `writing_tests` |
| `writing_tests` | Invoke or resume red-writer | `red`, `verifying`, or `failed` |
| `red` | RED checkpoint is durable; no command evidence is required | `implementing` |
| `implementing` | Invoke or resume green-implementer for current round | `writing_tests`, `implementing`, or `failed` |
| `verifying` | RED declared done; run final configured gates | `reviewing`, `implementing`, or `failed` |
| `reviewing` | Cold independent final review | `committing`, `implementing`, or `failed` |
| `committing` | Squash all RED checkpoints plus production work | `done` |

### Normal round

```text
writing_tests
  red-writer returns continue and changed tests
  harness validates test-only diff
  harness commits RED checkpoint
red
  harness transitions without running a command
implementing
  implementer returns green
  harness enforces test integrity
  harness runs targeted command
  PASS -> record completed round -> writing_tests
```

### Already-covered round

New regression tests may already pass because the behavior existed or an earlier implementation
covered more than expected.

```text
implementing
  implementer returns already_green with no required production change
  harness runs targeted command
  PASS -> record round as already-covered -> writing_tests
```

This is accepted coverage, but the event and ledger must distinguish it from a true red-to-green
implementation round.

### Test issue

```text
implementing
  implementer returns test_issue
  harness records concise issue evidence
  harness transitions to writing_tests in repair mode
  same red-writer session corrects tests only
  harness creates a replacement RED checkpoint
  same implementer session resumes
```

Allow one accepted test repair per stable issue fingerprint per task, using the existing
progress-gate and fingerprint concepts. Repeating the same red/green edge without tree or evidence
progress blocks the task instead of ping-ponging indefinitely. A test repair mutates the existing
`pendingRound` in place: `number` is unchanged, `mode` flips to `"test-repair"`, and
`implementerAttempts` is preserved. Only a completed GREEN round advances `number`. The
one-repair-per-fingerprint set is task-scoped.

### RED completion

```text
writing_tests at a verified-green checkpoint
  red-writer returns done and changes no files
  harness stores final coverage assessment
verifying
  run all configured verification commands
reviewing
  cold reviewer checks implementation, tests, criteria, and edge cases
committing
```

## Durable domain model

### Episode schema

Generalize the existing `implementerSession` shape into a reusable episode schema:

```ts
const WorkerEpisodeSchema = z.object({
  providerSessionId: z.string().min(1).optional(),
  guidanceFingerprint: z.string().optional(),
  turns: z.number().int().nonnegative().default(0),
});
```

With no legacy runs to migrate, go straight to one consolidated nested structure. Remove
`implementerSession` from `BuildTask` and replace it with:

```ts
tddLoop: z.object({
  round: z.number().int().positive().default(1),
  atVerifiedGreen: z.boolean().default(false),
  finalRepairPending: z.boolean().default(false),
  finalRepairAttempts: z.number().int().nonnegative().default(0),
  redWriterSession: WorkerEpisodeSchema.optional(),
  greenImplementerSession: WorkerEpisodeSchema.optional(),
  pendingRound: TddPendingRoundSchema.optional(),
  completedRounds: z.array(TddCompletedRoundSchema).default([]),
  coverage: TddCoverageLedgerSchema.default({}),
}).optional()
```

`tddLoop` is authoritative from Phase 1; there is no interim split-field step. Keep `.default(...)`
on every new field anyway: defaults keep test fixtures terse and future additive evolution cheap.

### Pending round

```ts
const TddPendingRoundSchema = z.object({
  number: z.number().int().positive(),
  // A test_issue repair flips mode in place; number and implementerAttempts are unchanged.
  // Only a completed GREEN round clears the pending round and advances the round counter.
  mode: z.enum(["feature", "test-repair"]),
  redCheckpointSha: z.string().optional(),
  testPathsAdded: z.array(z.string()).default([]),
  behaviorsAdded: z.array(z.string().min(1)).default([]),
  edgeCasesAdded: z.array(z.string().min(1)).default([]),
  implementerAttempts: z.number().int().nonnegative().default(0),
  startedAt: z.string(),
});
```

### Completed round

```ts
const TddCompletedRoundSchema = z.object({
  number: z.number().int().positive(),
  outcome: z.enum(["implemented", "already-covered"]),
  redCheckpointSha: z.string().optional(),
  testPathsAdded: z.array(z.string()),
  behaviorsAdded: z.array(z.string()),
  edgeCasesAdded: z.array(z.string()),
  targetedEvidencePurpose: z.string(),
  completedAt: z.string(),
});
```

Do not copy stdout or stderr into the round ledger. `CommandEvidence` remains the audit artifact;
continuation prompts receive only a bounded summary.

Each verified round still records its targeted command evidence with purpose `tdd:green`, and
`targetedEvidencePurpose` defaults to that purpose, so `assertCanMarkTaskDone` keeps passing:
`canMarkTaskDone` requires a passed `tdd:green` evidence entry before commit for TDD tasks.

### Coverage ledger

```ts
const TddCoverageLedgerSchema = z.object({
  behaviors: z.array(z.string().min(1)).default([]),
  edgeCases: z.array(z.string().min(1)).default([]),
  finalAssessment: z.object({
    acceptanceCriteria: z.array(z.object({
      criterionIndex: z.number().int().nonnegative(),
      covered: z.boolean(),
      testPaths: z.array(z.string()),
      rationale: z.string().min(1),
    })),
    edgeCaseRationale: z.string().min(1),
  }).optional(),
});
```

Acceptance criteria continue to be stored as strings. Use their stable task-array indices in the
coverage assessment rather than inventing durable IDs or rewriting existing task artifacts.

### Attempt accounting

The existing counters are task-global and cannot directly limit a multi-round loop:

- Keep `attempts.tests` and `attempts.implementation` as total diagnostic counters for UI reporting
  and transition signatures. They keep incrementing on every red-writer and implementer invocation,
  which also keeps repeated `writing_tests -> red` and GREEN-retry transitions distinguishable in
  the run-advancer's `workflowSignature` (see Phase 4).
- Use `pendingRound.implementerAttempts` for `maxImplementationAttempts`; reset it after every
  completed GREEN round.
- Final verification and review repairs use a dedicated per-task budget:
  `tddLoop.finalRepairAttempts` (together with the `tddLoop.finalRepairPending` marker) instead of
  the cumulative `attempts.implementation`, which otherwise permanently exceeds
  `maxImplementationAttempts` after a few rounds and would route post-`done` failures straight to
  `failed`. Increment it each time `verifyTask` or `reviewTask` routes the task back to
  `implementing`; never reset it within a task, since it is a budget rather than a per-round
  counter.
- `maxTestAttempts` applies to schema/path/test-repair revisions within one RED round, not to the
  number of normal TDD rounds.
- Do not add a hard test-count or round-count limit. Cancellation, no-progress fingerprints,
  optional context-turn rotation, and the run-level spend ceilings remain the circuit breakers.
  Note that today only `maxRunTokens` and `maxRunCostUsd` are actually enforced (in
  `run-advancer.ts`); `maxInvocationTokens` and `maxTaskTokens` are config values surfaced to the
  UI but not enforced, so until that enforcement lands a runaway loop is only stopped by the
  run-level ceilings.

## Agent output contracts

Create dedicated schemas instead of overloading `WorkerOutputSchema`.

### Red-writer output

```ts
const RedWriterOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("continue"),
    summary: z.string().min(1),
    changedFiles: z.array(z.string()).min(1),
    behaviorsAdded: z.array(z.string().min(1)).min(1),
    edgeCasesAdded: z.array(z.string().min(1)).default([]),
  }),
  z.object({
    status: z.literal("done"),
    summary: z.string().min(1),
    changedFiles: z.array(z.string()).length(0),
    acceptanceCoverage: z.array(z.object({
      criterionIndex: z.number().int().nonnegative(),
      covered: z.boolean(),
      testPaths: z.array(z.string()),
      rationale: z.string().min(1),
    })),
    edgeCaseRationale: z.string().min(1),
  }),
]);
```

The harness discovers actual changed paths from Git and treats those as authoritative. The
`changedFiles` output remains useful for git-disabled mode and discrepancy diagnostics.

Do not let the red-writer author a shell command. The harness owns the targeted command, consistent
with ADR 0009. The RED-to-GREEN continuation includes the resolved config-owned command for
transparency.

### Green-implementer output

```ts
const GreenImplementerOutputSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.enum(["green", "already_green"]),
    summary: z.string().min(1),
    changedFiles: z.array(z.string()),
  }),
  z.object({
    status: z.literal("test_issue"),
    summary: z.string().min(1),
    changedFiles: z.array(z.string()),
    testPath: z.string().min(1),
    reason: z.string().min(1),
    evidence: z.string().min(1),
  }),
]);
```

The harness still verifies `green` and `already_green`; the status is an agent claim, not evidence.
If `already_green` includes production changes, record a diagnostic warning and treat it as
`green` after verification.

## Continuation handoffs

Use `AgentCoordinator.invokeInEpisode` for both roles. On continuation, pass `continuationInput` so
`renderContinuationPrompt` emits only delta input and omits unchanged guidance when its fingerprint
matches.

### First red-writer turn

The full packet contains:

- complete task and acceptance criteria;
- affected paths and test path patterns;
- configured targeted filter and command description;
- RED test-only rules;
- three-to-five soft batch guidance;
- explicit edge-case responsibility;
- red output contract.

### Subsequent red-writer turn

```json
{
  "round": 3,
  "lastGreen": {
    "checkpoint": "<sha-or-tree-fingerprint>",
    "testPaths": ["..."],
    "command": "<resolved config-owned targeted command>",
    "summary": "Targeted tests passed"
  },
  "coverageSoFar": {
    "behaviors": ["..."],
    "edgeCases": ["..."]
  },
  "instruction": "Add the next coherent test batch or return done. Do not run commands."
}
```

Do not resend full evidence, prior packet JSON, full task state, or command logs. The retained session
has the task; a cold-start fallback gets the full current packet plus the bounded ledger.

### First green-implementer turn

The full packet contains the task plus current round:

```json
{
  "round": 1,
  "testPathsAdded": ["..."],
  "allProtectedTestPaths": ["..."],
  "behaviorsAdded": ["..."],
  "edgeCasesAdded": ["..."],
  "testCommand": "<resolved command>"
}
```

### Subsequent green-implementer turn

```json
{
  "round": 3,
  "testPathsAdded": ["..."],
  "behaviorsAdded": ["..."],
  "edgeCasesAdded": ["..."],
  "testCommand": "<resolved command>",
  "lastGreenSummary": "Round 2 independently verified",
  "instruction": "Implement this round without modifying tests."
}
```

For a failed GREEN retry, include only the latest bounded failure summary and its evidence artifact
reference, not the entire command output.

## Checkpoints and test integrity

The existing RED checkpoint and final squash design can support several rounds, but two corrections
are required.

### One RED checkpoint per continued round

- After a valid `continue` response, commit only newly dirty test paths with
  `GitService.commitRedCheckpoint`.
- Keep every checkpoint SHA in `redCheckpointHistory` in chronological order.
- Add `Harness-Checkpoint-Round: <n>` to the checkpoint commit body for recovery and diagnostics.
- `redCheckpointSha` points to the latest RED checkpoint.
- `redBaseSha` must continue to mean the parent of the oldest checkpoint, not the parent of the
  latest checkpoint. Do not overwrite it after round one. All three assignment sites — the normal
  commit, `confirmRed` recovery, and `establishRedCheckpoint`'s adopt-existing-checkpoint branch —
  guard with `redBaseSha: task.redBaseSha ?? recovered.baseSha`.
- Production changes from GREEN remain dirty while later test-only checkpoint commits are created.
  `commitRedCheckpoint` must continue staging only explicit test paths.
- Final `squashCheckpointsIntoTaskCommit` soft-resets to the parent of the oldest checkpoint and
  creates one atomic task commit containing all tests and production work.

### Protect all accumulated tests

`establishRedCheckpoint` currently replaces `redCheckpointPaths` with paths from the newest
checkpoint. In a multi-round loop that would leave tests from earlier rounds outside the integrity
guard.

Change the invariant to:

- `testPaths` is the cumulative authoritative set of all red-writer-owned tests.
- `redCheckpointPaths` is also cumulative, or is removed from integrity decisions.
- `enforceTestIntegrity` compares every cumulative `testPaths` entry against the latest
  `redCheckpointSha`, whose tree contains all prior checkpoint commits.
- Restoring tests uses the latest RED checkpoint and the complete cumulative test path set.

This cumulative invariant also normalizes an existing inconsistency in `establishRedCheckpoint`:
the Git branch replaces `redCheckpointPaths` with the newest commit's paths while the git-disabled
branch accumulates them. Under the new invariant both converge on the cumulative set.

Add integration coverage for an implementer modifying a round-one test during round three.

### Git-disabled mode

- Continue using reported plus observed changed paths.
- Store cumulative test paths and enforce them using porcelain/report comparison where possible.
- No crash-safe content restoration is available without Git; fail the round on test mutation rather
  than pretending it was restored.
- `fingerprintFor` uses a constant `sourceTreeState: "git-disabled"` when Git is off, and
  `EvidenceFingerprintInput` has no round input, so identical failures across rounds would collide
  and false-block the task. Include the TDD round number in the fingerprint input when Git is
  disabled.

## TaskExecutionService changes

### `writeTests`

Refactor into a round-oriented red action:

1. Assert the task is either starting a new feature round, repairing a reported test issue, or
   requesting final completion assessment at verified GREEN.
2. Crash re-entry: if Git is enabled and `findRedCheckpoint(task.id)` returns a checkpoint newer
   than the recorded `redCheckpointSha` and there are no new dirty test paths, a crash occurred
   between `commitRedCheckpoint` and the step-flip `updateTask`. Adopt the checkpoint, synthesize
   `pendingRound` from `checkpoint.paths` minus the task's prior `testPaths` (recording
   behaviors/edge-cases as unknown/recovered), and transition to `red` without invoking the agent.
3. Invoke `red-writer` with `invokeInEpisode`, using `tddLoop.redWriterSession` when available.
4. On a continuation, send only round delta input.
5. Observe changed paths from Git.
6. Reject every non-test changed path; remove the affected-production-path exception and scaffold
   handling.
7. Do not call `runTargetedTest` and do not classify runnable RED.
8. If status is `continue`, require at least one dirty test path, establish the next RED checkpoint,
   store `pendingRound`, set `atVerifiedGreen=false`, and transition to `red`.
9. If status is `done`, require no dirty paths, no pending round, at least one completed round, and
   `atVerifiedGreen=true`; store final coverage and transition directly to `verifying`.
10. Persist the red episode after every successful invocation.

The `test-writer` repair role is deleted outright: remove the enum value, its `ROLE_RULES` entry,
its guidance assignment and defaults entries (`config/schema.ts`, `config/defaults.ts`,
`domain.ts`, `prompts.ts`), and its retrieval-budget entry in `agent-coordinator.ts`. The
evidence-driven repair machinery it served is deleted with it (see `implementTask`).

### `confirmRed`

- Never run a test command.
- Require a `pendingRound` and transition to `implementing`.
- Needs no dangling-checkpoint recovery: a crash between `commitRedCheckpoint` and the step-flip
  leaves the task at `writing_tests`, so the `writeTests` re-entry rule (above) owns that recovery.
  When the task is already at `red` with a recorded checkpoint, only assert the checkpoint still
  exists and continue.

### `implementTask`

1. Remove the pre-invocation `tdd:resume-check`; a resumed GREEN round goes straight back to the
   retained implementer with the latest bounded evidence.
2. Use the existing implementer episode mechanism (now `tddLoop.greenImplementerSession`) and apply
   `maxContextTurns` independently.
3. Use `GreenImplementerOutputSchema` for TDD tasks and `WorkerOutputSchema` for non-TDD tasks.
4. Delete the evidence-driven repair path: the `failureCategoryFromEvidence` classification routing
   in `implementTask`, plus `routeToTestRepair`, `acceptTestRepairCheckpoint`, and
   `counterfactualRedAccepted`. Agent-reported `test_issue` replaces them. The task field
   `acceptedTestRepairFingerprints` is kept and reused by the new flow for the
   one-accepted-repair-per-fingerprint rule; only the functions around it go away.
5. On `test_issue`, fingerprint the issue, store concise evidence, mutate the current `pendingRound`
   in place (`mode: "test-repair"`, same `number`, preserved `implementerAttempts`), and route to
   `writing_tests` without releasing either episode.
6. On `green` or `already_green`, enforce cumulative test integrity.
7. Run the targeted command.
8. On pass, append a completed round, record the targeted evidence with purpose `tdd:green` (see
   Completed round), clear `pendingRound`, set `atVerifiedGreen=true`, reset the per-round
   implementation-attempt count, and transition to `writing_tests`.
9. On failure, increment the current round's implementation attempts and remain `implementing` with
   the same provider session until the per-round limit is exhausted.
10. Do not transition to `verifying` after an ordinary GREEN round.

### `verifyTask`

- This becomes final verification only.
- It is entered exclusively after a valid red-writer `done` response (or non-TDD implementation).
- The repair budget is the dedicated per-task `tddLoop.finalRepairAttempts` counter, not the
  cumulative `attempts.implementation` (which permanently exceeds `maxImplementationAttempts` after
  a few rounds of the loop).
- If final gates fail and `finalRepairAttempts` remains below `maxImplementationAttempts`,
  increment it, set the `tddLoop.finalRepairPending` marker, and transition to `implementing`.
  Otherwise fail the task.
- After a successful final repair, clear `finalRepairPending` and return to `writing_tests`, not
  directly to final gates, so RED reassesses coverage before declaring `done` again.

### `reviewTask`

- Add the final coverage assessment and completed-round summary to the reviewer packet.
- Keep the reviewer cold and read-only.
- Build the review diff over `redBaseSha..worktree` (the parent of the oldest checkpoint through
  the current worktree), not today's dirty-only diff against HEAD: tests committed at RED
  checkpoints are clean versus HEAD and would otherwise be silently excluded, which is fatal for
  `test-coverage` findings once a task has multiple checkpoints.
- Extend reviewer findings with a required structured `kind`, at minimum `production`,
  `test-coverage`, and `advisory`, while retaining blocking/advisory severity. Do not infer routing
  from free-form message text.
- If review rejects production behavior, resume the green-implementer, budgeting with
  `tddLoop.finalRepairAttempts` and setting `finalRepairPending` exactly as in `verifyTask`. After
  repair and targeted GREEN verification, route through red-writer completion assessment again.
- If review identifies only missing tests, route directly to the retained red-writer with the
  finding as new authoritative input.

### Completion, failure, and cancellation

Replace implementer-only cleanup helpers with task-worker cleanup:

```ts
releaseTaskWorkerSessions(task): Promise<BuildTask>
releaseAllTaskWorkerSessions(state): Promise<RunState>
```

This renames `releaseImplementerSession`/`releaseAllImplementerSessions`; update every existing
call site, including `completeCancellation` in `recovery-service.ts`, the `blockNoProgress` path,
and the integrity-violation release path in `task-execution-service.ts`, all of which must release
both sessions.

Release both role sessions on:

- successful task commit;
- task failure or no-progress block (`blockNoProgress`);
- the test-integrity violation release path;
- run cancellation (`completeCancellation` in `recovery-service.ts`);
- explicit cleanup/discard;
- context rotation for that individual role.

Do not release either session merely when handing off between RED and GREEN.

## Prompts and role rules

Update `ROLE_RULES`:

### Red-writer

- Remove the runnable-RED requirement.
- Remove permission for production scaffolds.
- Add test-only and no-command rules.
- Add the three-to-five soft batch guidance verbatim.
- Add explicit edge-case discovery responsibility.
- Explain `continue` versus `done` and that `done` is permitted only at verified GREEN.
- Tell the agent to use existing accumulated tests and avoid duplicating covered behaviors.

### Implementer

- When `task.tdd` is true, identify it as the green-implementer.
- Require production-only changes and preserved tests.
- Explain `green`, `already_green`, and `test_issue` statuses.
- Instruct it to focus on the current batch while respecting the overall public contract.

`renderContinuationPrompt` already supports `deltaInput`; no new prompt transport is required. Add
tests confirming repeated guidance and full task JSON are absent from same-session continuation
prompts.

## Configuration

Avoid introducing configuration until it controls a proven operational need.

Reuse:

- `workflow.maxImplementationAttempts` as the per-round GREEN attempt limit;
- `workflow.maxTestAttempts` as the per-round RED schema/path/test-repair revision limit;
- `workflow.maxContextTurns` independently for each role episode;
- `workflow.maxInvocationTokens`, `maxTaskTokens`, `maxRunTokens`, and cost ceilings;
- `commands.testTargetTemplate`, `commands.verification`, and `workflow.testPathPatterns`.

Do not add:

- a hard tests-per-round limit;
- a hard TDD-round limit;
- an agent-authored command field;
- a third required TDD role.

Update default YAML comments so operators understand that `maxTestAttempts` is not the number of
RED/GREEN rounds and that final verification commands do not run after every RED batch.

## Events, artifacts, and UI

### Events

Add or revise events so the loop is auditable (`task.red_observed`, `task.red_checkpoint_committed`,
and `task.green_observed` already exist; keep them):

- `task.tdd_round_started`
- `task.red_batch_recorded`
- `task.green_requested`
- `task.green_already_covered`
- `task.green_rejected`
- `task.test_issue_reported`
- `task.test_issue_repaired`
- `task.tdd_round_completed`
- `task.tdd_done_declared`
- `task.tdd_context_rotated`

Event details should contain round number, bounded path lists, checkpoint SHA, behavior/edge-case
counts, and evidence fingerprints. Do not put full command output into event details.

### Artifacts

- Keep complete command evidence in the existing evidence/session artifacts.
- Include `pendingRound`, `completedRounds`, and coverage in `state.json`.
- Render the round ledger in the task Markdown artifact: round, outcome, behavior batch, edge cases,
  tests, and targeted verification status.

### UI

Show:

- current TDD round and active role;
- retained red and green session turn counts;
- completed round count;
- behaviors and edge cases added in the current batch;
- `already-covered` rounds distinctly;
- final coverage assessment when RED declares done;
- cached versus total token usage using the existing usage fields.

Do not require operator interaction between ordinary rounds.

## Compatibility

The harness is single-user and pre-release; old runs are discarded and the alternating loop is the
only TDD behavior from the start. There is no in-flight task migration, no legacy state-machine
gating, and no stored-config parsing burden:

- Keep `.default(...)`s on new schema fields as fixture-parsing hygiene, not as a migration
  mechanism.
- Delete the `test-writer` role rather than deprecating it.
- Keep non-TDD task behavior unchanged.
- Bump `CONFIG_VERSION` for frozen-config hash hygiene, since run behavior and stored task
  semantics change. No behavior branching hangs off the version.

## Implementation sequence

### Phase 1: Domain contracts and pure transitions

Files:

- `packages/agent-harness/src/domain.ts`
- a new focused transition module under `src/application/` if needed
- unit tests under `packages/agent-harness/tests/unit/domain/`

Work:

1. Add the consolidated `tddLoop` schema (episode, pending-round, completed-round, coverage,
   `finalRepairPending`, `finalRepairAttempts`) with defaults, replacing `implementerSession`
   outright — no interim split-field step.
2. Add `RedWriterOutputSchema` and `GreenImplementerOutputSchema`.
3. Define pure guards for valid `continue`, `done`, round completion, and test-issue transitions.
4. Define per-round attempt accounting and the dedicated final-repair budget.
5. Keep fixture parse tests confirming the new defaults apply cleanly to stored task JSON.

Exit criterion: state and output schemas express the complete loop without touching agents, Git, or
commands.

### Phase 2: Prompts and retained red episode

Files:

- `packages/agent-harness/src/prompts.ts`
- `packages/agent-harness/src/infrastructure/agents/agent-coordinator.ts` only if a small API
  generalization is required
- prompt/coordinator unit tests

Work:

1. Replace red-writer rules and add green status rules.
2. Invoke red-writer through `invokeInEpisode` with `mode: "agent"` passed explicitly (the method
   defaults to `"plan"`, which would silently neuter the red-writer).
3. Persist its provider session, guidance fingerprint, and turn count.
4. Use `continuationInput` for later RED and GREEN turns.
5. Verify same-session continuations omit repeated full task/evidence payloads.
6. Verify cold fallback packets remain complete.
7. Enforce the no-command RED rule via the provider-step audit. No selective tool policy exists
   (the only backend's `allowTools` aborts on any tool call), so the audit is the only mechanism:
   surface observed tool names out of `invokeInEpisode` (they are currently consumed inside the
   session activity tracker) and reject RED turns that used a command-execution tool, reusing
   `SHELL_TOOL_NAMES` from `src/infrastructure/agents/step-utils.ts`. Do not copy tool output into
   task state.
8. Extend the test fakes (`createFakeBackend`/`createScriptedBackend`) to emit `request.onStep`
   tool-call steps; neither fake invokes `onStep` today, so the audit path is untestable without
   this.

Exit criterion: two fake retained providers receive one full prompt followed by bounded continuation
prompts, and a scripted RED turn that emits a shell step is rejected.

### Phase 3: RED becomes test-only and command-free

Files:

- `packages/agent-harness/src/application/task-execution-service.ts`
- path-guard helpers and their tests

Work:

1. Remove RED production-scaffold permission, scaffold bookkeeping, and the `isRepair` heuristic
   (true from round two onward under the loop; replaced by `pendingRound.mode`).
2. Reject every non-test RED edit.
3. Remove targeted command execution and runnable-RED classification (`classifyRunnableRed`) from
   RED handling, along with the now-dead evidence-driven repair routing.
4. Branch on `continue` versus `done`.
5. Establish a RED checkpoint only for `continue`, including the `writeTests` crash re-entry rule
   that adopts a dangling checkpoint without re-invoking the agent.
6. Require verified-green state for `done`.

Exit criterion: advancing after RED creates a test-only checkpoint and invokes no command runner.

### Phase 4: Alternating GREEN rounds

Files:

- `packages/agent-harness/src/application/task-execution-service.ts`
- `packages/agent-harness/src/application/run-advancer.ts`
- evidence/fingerprint helpers as needed
- workflow integration tests

Work:

1. Send pending-round deltas to the retained implementer.
2. Handle `green`, `already_green`, and `test_issue`.
3. Run targeted verification after green claims.
4. On pass, record the round and return to `writing_tests`.
5. On fail, retry the same GREEN round with the same session and bounded evidence.
6. Route test issues to the same retained red-writer, mutating the existing `pendingRound` in place.
7. Extend the run-advancer's `workflowSignature` with the TDD round number and
   `pendingRound.implementerAttempts`. The repeated-transition circuit breaker currently kills any
   `from -> to` signature seen twice, and same-session GREEN retries that only bump the per-round
   counter would otherwise be killed as an internal error.
8. Preserve no-progress protection across both directions, and include the round number in the
   evidence fingerprint input when Git is disabled (the constant `git-disabled` tree state would
   otherwise collide across rounds and false-block).

Exit criterion: a scripted backend completes at least three RED/GREEN rounds using exactly two
provider session IDs.

### Phase 5: Multi-round Git integrity and squash

Files:

- `packages/agent-harness/src/git.ts`
- `packages/agent-harness/src/application/task-execution-service.ts`
- Git and per-run-worktree integration tests

Work:

1. Add round trailers to RED checkpoints.
2. Preserve the oldest `redBaseSha` and ordered checkpoint history, guarding all three assignment
   sites (the normal establish path plus both recovery paths).
3. Protect cumulative test paths against implementer edits, normalizing the git/git-disabled
   `redCheckpointPaths` replace-versus-accumulate inconsistency to cumulative.
4. Recover the newest checkpoint safely after crashes.
5. Verify dirty production changes survive later test-only checkpoint commits.
6. Verify final squash creates one task commit with all rounds and trailers.

Exit criterion: a three-round real Git fixture finishes with one final task commit and no lost test
or production changes.

### Phase 6: Final verification, review repair, and cleanup

Files:

- `packages/agent-harness/src/application/task-execution-service.ts`
- `packages/agent-harness/src/application/application-context.ts`
- `packages/agent-harness/src/application/recovery-service.ts`
- cancellation and workflow tests

Work:

1. Enter final verification only after RED `done`.
2. Route final gate and review repairs through GREEN, then RED reassessment, budgeted by the
   dedicated `tddLoop.finalRepairAttempts` counter instead of the global
   `attempts.implementation` check currently in `verifyTask`/`reviewTask`.
3. Add structured reviewer finding kinds and route test-coverage versus production findings without
   parsing prose.
4. Pass final coverage to the reviewer and build the TDD review diff from `redBaseSha..worktree`.
5. Release both sessions on every terminal path, including the `completeCancellation` call site in
   `recovery-service.ts`, `blockNoProgress`, and the test-integrity violation path.
6. Apply independent context rotation and emit rotation events.

Exit criterion: success, failure, cancellation, no-progress, and context rotation leak no retained
provider sessions.

### Phase 7: UI, artifacts, documentation, and ADR

Files:

- the task artifact renderer (`src/tracker.ts` via `ctx.syncArtifacts`)
- `packages/agent-harness/src/ui/client/`
- `packages/agent-harness/README.md`
- `packages/agent-harness/src/config/defaults.ts`
- a new ADR documenting the alternating TDD decision

Work:

1. Render round and edge-case coverage.
2. Update activity labels and session details.
3. Document configuration semantics and recovery behavior.
4. Record why retained sessions are an optimization rather than durable correctness state.

Exit criterion: CLI/UI status explains exactly which round and role are active and the README
matches runtime behavior.

## Test plan

### Unit tests

- Task state fixtures parse with the new `tddLoop` defaults applied.
- RED `continue` requires changed tests and at least one behavior.
- RED `done` rejects file changes, pending rounds, uncovered criteria, and non-green state.
- RED command-tool use is rejected by the step-audit fallback (requires the `onStep`-emitting fake
  backends from Phase 2).
- Edge cases are accumulated and de-duplicated without imposing a count.
- Per-round implementation attempts reset after GREEN.
- The final-repair budget (`finalRepairAttempts`) gates `verifyTask`/`reviewTask` repair routing
  independently of the cumulative `attempts.implementation` counter.
- Continuation prompts contain delta input and omit repeated task/evidence text.
- Context-turn rotation is independent for RED and GREEN.
- No-progress fingerprints distinguish round number, checkpoint, and role-transition edge.

### Integration tests with scripted backend

1. Three-round happy path uses one red provider session and one green provider session.
2. RED writes three to five tests as guidance but a two-test or six-test batch is still accepted.
3. RED may introduce uncompilable references; no command runner is called before GREEN.
4. RED production edit is rejected deterministically.
5. GREEN test edit is restored/rejected across cumulative tests from every round.
6. GREEN targeted failure resumes the same green session in the same round, and repeated same-step
   retries do not trip the run-advancer repeated-transition circuit breaker.
7. GREEN `test_issue` resumes the same red session, then the same green session.
8. Repeated identical test issue is blocked by the progress gate.
9. `already_green` passes and records regression coverage without a production delta.
10. RED `done` triggers full verification, review, and commit.
11. Final gate failure routes GREEN repair back through RED reassessment.
12. Structured reviewer `test-coverage` finding routes to RED; `production` finding routes to GREEN.
13. Cancellation releases both sessions.
14. Provider restart cold-starts from ledger and worktree without losing round state.
15. Non-TDD tasks retain the existing single implementation flow.

### Real Git/worktree tests

- Multiple test-only RED checkpoint commits interleave with dirty production work.
- Latest checkpoint tree contains all prior tests.
- Round-one tests remain integrity-protected in later rounds.
- Crash after checkpoint commit but before state update recovers the correct round.
- Final squash produces one atomic commit containing every test and production change.
- Checkpoint trailers include task and round provenance.

### Acceptance tests

Run a repository-neutral fixture through at least three rounds:

- round one introduces a reference to a missing production surface;
- round two adds boundary and invalid-input edge cases;
- round three adds exemptions or precedence behavior;
- red-writer declares done;
- targeted commands run only after GREEN responses;
- configured final verification runs once after `done`;
- activity shows two retained provider sessions;
- session artifacts show bounded continuation prompts;
- final commit contains all tests and implementation.

Also run smoke coverage against at least two materially different project shapes, such as one
compiled project and one interpreted project. These are compatibility fixtures, not separate state
machines: both must use the same config-owned command and test-path abstractions without
language-specific branches in `TaskExecutionService`.

## Observability and rollout

Before making the new loop the only mode, capture per-role and per-round:

- provider session reuse;
- total, input, output, and cache-read tokens;
- tool-call and invocation counts;
- tests and edge cases added;
- GREEN retries and test-issue bounces;
- targeted command duration;
- context rotations;
- already-covered rounds.

Cached input remains part of Cursor's inclusive `inputTokens`, so retaining sessions may improve
latency and provider cost without lowering the displayed raw-token total. Compare both total tokens
and cache-read share when evaluating the rollout.

With no legacy installs to protect, the alternating loop replaces the one-shot flow directly; the
runnable-RED branch is removed as part of Phase 3 rather than kept behind a switch. Gate the
rollout on the Phase 1-6 exit criteria plus one real-repository trial pass.

## Definition of done

The implementation is complete when all of the following are true:

- A TDD task alternates between exactly one logical red-writer and one logical green-implementer.
- Both provider sessions are reused across rounds when the provider process remains alive.
- RED changes tests only and neither the red-writer nor harness runs commands after RED.
- RED batches receive the three-to-five soft guidance and explicitly report edge cases.
- GREEN is independently verified with the config-owned targeted command before returning to RED.
- The state machine contains no language-, framework-, or build-tool-specific branch.
- RED can declare `done` only at verified GREEN with a final behavior and edge-case coverage
  assessment.
- Full verification and cold review happen only after `done`.
- Test issues return to the same red-writer, not a third normal-flow agent.
- All accumulated tests remain protected from implementer edits.
- Multiple RED checkpoints squash safely into one final task commit.
- Cancellation, failure, completion, and context rotation release the correct sessions.
- Same-session GREEN retries and repeated loop transitions do not trip the run-advancer
  repeated-transition circuit breaker.
- Final verification and review repairs are budgeted by the dedicated `finalRepairAttempts`
  counter.
- The reviewer sees the full task diff, including all checkpoint-committed tests.
- Non-TDD workflows remain supported.
- Unit, scripted integration, Git/worktree, cancellation, restart, and acceptance tests pass.
