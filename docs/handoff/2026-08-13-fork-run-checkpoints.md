# Handoff: Fork Run from durable worktree checkpoints

**Date:** 2026-08-13  
**Branch:** `main`  
**Status:** design exploration complete; no implementation started

## Summary

Design a **Fork Run** capability that creates a new run and isolated worktree from a durable point in an existing run. The motivating case is to fork immediately after implementation has completed, select an updated workflow, and retry scenario testing without repeating reflection, grilling, planning, or implementation.

The design should expose as many fork points as safely possible. The preferred grain is every completed persisted transition at which no agent or command remains in flight, not a small hard-coded list of phase boundaries.

## User goal

Given a run that has already produced useful code:

1. Select a prior durable point, such as `implementation.completed` or the latest return from an implementer.
2. Create a child run with a new run ID and a new worktree containing the files exactly as they existed at that point.
3. Preserve the product decisions and workflow state already reached.
4. Optionally freeze the project's **current** workflow/configuration into the child instead of reusing the parent's workflow.
5. Continue only the downstream workflow. For the primary example, enter `scenario_testing` directly.
6. Leave the parent run and its worktree unchanged and independently resumable.

## Decisions reached

- Name the feature **Fork Run**. UI copy may say **Fork from here**.
- A fork always creates a new descendant run; never rewind or mutate the parent in place.
- The fork coordinate is a durable **checkpoint** containing both workflow state and an exact workspace snapshot.
- Create checkpoints at as many quiescent persisted transitions as possible.
- Agent/provider conversation history is an optimization, not the authority. A child starts fresh provider sessions from its complete persisted packet unless a future backend can safely fork a completed provider turn.
- Support both reproducible and experimental workflow selection:
  - `source`: use the parent's frozen workflow/configuration.
  - `current`: freeze the project's current workflow/configuration into the child.
  - An explicit config path may be supported as an additional CLI option.
- Reset child publication identity (`branchName`, `pullRequestUrl`, and related delivery state). Do not reuse the parent's delivery branch automatically.
- Record lineage in the child: parent run ID, source checkpoint/event sequence, source event type, source workspace snapshot SHA, and fork time.
- Preserve upstream state and evidence. Downstream work is avoided by choosing a checkpoint before it happened rather than destructively editing later state.

## Primary acceptance scenario

Starting from a parent run that has reached scenario testing:

```text
task.committed
    -> implementation.completed       <- source checkpoint
    -> scenario.tests_written
    -> scenario execution/repair
```

Fork from `implementation.completed` using the current workflow. The child must:

- have all completed task commits and production files;
- retain the idea, resolutions, plan, PRD, tasks, and planned scenarios;
- have pending scenarios with no later scenario-test artifacts;
- use a new isolated worktree and run ID;
- use freshly frozen current workflow components/configuration;
- enter `scenario_testing` without invoking earlier roles;
- leave the parent state and worktree byte-for-byte unchanged.

## Fork-point policy

### Forkable

Make a transition forkable when its state is durable and no child process, command, or model invocation is still running. Desired points include:

- reflector/griller outputs and operator gates;
- plan, PRD, scenario-plan, and issue-slicing transitions;
- every agent return after its filesystem edits are complete;
- targeted implementation verification and full task gates;
- task review and every task commit;
- `implementation.completed`;
- `scenario.tests_written`, `scenario.passed`, `scenario.repair_routed`, and `scenarios.completed`;
- coverage measurement, coverage test writing, and coverage routing;
- final review results and repair-routing decisions;
- blocked, failed, stopped, cancelled, and completed states;
- immediately before publication, with an external-side-effect warning where applicable.

### Not forkable

- An in-flight model invocation.
- An in-flight command.
- A partially persisted transition.
- A provider turn known to be incomplete.

The event timeline may still display non-forkable activity, but the UI should disable **Fork from here** and explain why.

## Exact workspace snapshots

Existing task commits make committed boundaries straightforward, but useful points such as `scenario.tests_written` may have dirty tracked or untracked test files. Do not limit the feature to visible Git commits.

Proposed Git implementation:

1. Use a temporary Git index, leaving the run's real index, `HEAD`, branch, and worktree untouched.
2. Populate it from the current `HEAD` and add tracked plus non-ignored untracked workspace files.
3. Write a Git tree and synthetic checkpoint commit.
4. Keep the commit reachable under a private ref such as:

   ```text
   refs/agent-harness/checkpoints/<run-id>/<event-sequence>
   ```

5. Create the child's detached worktree from the checkpoint commit SHA.

Ignored build output should not be included. Submodule dirt, symlinks, executable bits, deletions, renames, and untracked test files need explicit tests.

Synthetic checkpoint commits must not leak into delivered history. Decide whether publication squashes them, recreates clean task commits, or treats the source snapshot commit as an internal parent that is removed before delivery.

## Checkpoint persistence

`state.json` currently stores only the latest state. `events.jsonl` contains event summaries and cannot reconstruct every historical `RunState`. Add immutable checkpoint manifests, for example:

```text
runs/<run-id>/
  checkpoints/
    000042.json
  events.jsonl
  state.json
```

Indicative manifest:

```json
{
  "checkpointId": 42,
  "eventSequence": 42,
  "eventType": "implementation.completed",
  "state": {},
  "workspaceSnapshotSha": "...",
  "workspaceEvidence": {},
  "configurationHash": "...",
  "createdAt": "...",
  "forkable": true
}
```

Checkpoint creation should be coordinated with the existing transition journal. A crash must not produce a checkpoint whose state/event sequence disagrees with `state.json` or `events.jsonl`. Extend recovery so prepared snapshot refs and checkpoint manifests are either completed idempotently or recognized as orphaned.

Do not assume that checkpointing only in `RunAdvancer` after `advanceOne()` is sufficient. Some service methods perform several `store.record()` calls, model invocations, commands, and recursive workflow steps before returning. Capturing every persisted transition likely requires a checkpoint-aware transition service or a carefully bounded hook around `RunStore.record()` / `persistTransition()`.

## Child-state construction

At fork time:

- allocate a new run ID and directory;
- copy/parse the checkpoint's exact `RunState`, then replace `runId` and timestamps;
- add lineage metadata;
- create a new event history beginning with `run.forked` that references the parent checkpoint;
- do not copy parent provider-session IDs or active episode handles;
- copy or reference durable source artifacts needed to explain inherited state;
- freeze the selected workflow config and effective components for the child;
- recompute `configurationHash`, set the current supported `configVersion`, and reset `configRevision` appropriately;
- create and register the child worktree from `workspaceSnapshotSha`;
- stamp new workspace evidence from the child worktree;
- clear cancellation, stop, lock, transition-journal, delivery-branch, and PR state;
- start child usage accounting at zero, while exposing inherited parent usage separately if useful for audit.

For `--workflow current`, run a compatibility validator before creating the child. Model choices, prompts, commands, attempt ceilings, coverage policy, and workflow components should normally be eligible. Repository identity, storage roots, Git enablement, worktree ownership, and incompatible state-schema changes should be rejected or require an explicit migration.

## Proposed interface

CLI examples:

```powershell
# Exact checkpoint sequence
agent-harness fork --run-id <parent> --checkpoint 42 --workflow source

# Latest checkpoint for an event type
agent-harness fork --run-id <parent> --after implementation.completed --workflow current

# Convenience selector resolving to the latest completed return from a role
agent-harness fork --run-id <parent> --after-role implementer --workflow current
```

Also add a checkpoint-listing command or extend status inspection:

```powershell
agent-harness checkpoints --run-id <parent>
```

API/dashboard:

- list checkpoint metadata without loading every full state snapshot;
- show **Fork from here** beside forkable timeline entries;
- show child/parent lineage and links in run details;
- offer **Original workflow** and **Current workflow** choices;
- preview the selected checkpoint's phase, task/scenario status, Git snapshot, workflow differences, and irreversible external effects before creating the child.

## Repository findings

- Durable state schema: `packages/agent-harness/src/domain.ts` (`RunStateSchema`, around line 475).
- Atomic state/event transition and recovery journal: `packages/agent-harness/src/store.ts` (`RunStore.record`, around line 129; `persistTransition` follows).
- Run creation/config freezing/worktree preparation: `packages/agent-harness/src/application/run-lifecycle-service.ts`.
- Existing per-run worktree creation accepts an optional `baseSha`: `packages/agent-harness/src/git/worktree-manager.ts` (`WorktreeManager.create`, around line 77).
- Implementation-to-scenario boundary: `packages/agent-harness/src/application/task-execution-service.ts` (`implementation.completed`, around line 51).
- Scenario transitions and immediate recursive execution: `packages/agent-harness/src/application/scenario-testing-service.ts`.
- Advance loop and phase dispatch: `packages/agent-harness/src/application/run-advancer.ts`.
- Existing CLI resume/retry surfaces: `packages/agent-harness/src/cli/create-cli.ts` (`continue` around line 372; `retry` around line 575).
- Existing dashboard run actions: `packages/agent-harness/src/ui/http/routes/runs.ts`.
- Relevant architecture decisions: `docs/adr/0002-durable-wayfinder-harness.md` and `docs/adr/0010-per-run-worktrees.md`.

The current architecture explicitly treats filesystem artifacts as authoritative and provider sessions as recoverable optimization. Per-run detached worktrees and immutable `baseSha` ownership make Fork Run a natural extension.

## Suggested implementation slices

### Slice 1: Checkpoint contract and committed-boundary fork

- Add checkpoint and lineage schemas.
- Persist immutable state snapshots for selected committed boundaries.
- List/read checkpoints.
- Fork `implementation.completed` using the source workflow.
- Create the child worktree from the committed checkpoint SHA.
- Prove parent immutability and child resumability with integration tests.

This slice provides the motivating use case quickly without yet snapshotting dirty worktrees.

### Slice 2: Snapshot every quiescent transition

- Add temporary-index Git snapshot commits and private refs.
- Integrate checkpoint persistence with transition-journal recovery.
- Checkpoint agent-return, test-writing, repair, coverage, blocked, and review states.
- Add orphan-ref recovery and conservative cleanup.

### Slice 3: Updated workflow and dashboard

- Add `source` / `current` / explicit-config selection.
- Validate configuration compatibility and show diffs.
- Add CLI selectors by event type and role.
- Add timeline actions and lineage display.

### Slice 4: Delivery and retention hardening

- Ensure synthetic checkpoint ancestry does not leak into published history.
- Define checkpoint retention and cleanup rules.
- Handle cleaned-up parent worktrees, archived runs, and external publication warnings.
- Decide behavior for Git-disabled and legacy-shared runs.

## Minimum tests

- Fork from `implementation.completed`; child begins at scenario testing and never invokes prior roles.
- Source and child state/worktrees are independent.
- Fork captures dirty tracked edits, deletion, rename, and non-ignored untracked test files.
- Snapshotting does not alter parent `HEAD`, index, status, or branch.
- Exact checkpoint selection and latest-event/role selectors resolve deterministically.
- Child uses source workflow by default and current workflow when requested.
- Incompatible current config is rejected before any child artifacts/worktree are created.
- Provider session IDs and active episode handles are not inherited.
- Usage and attempt counters follow the chosen inheritance policy.
- Crash after snapshot-ref creation, checkpoint preparation, state write, or event append recovers idempotently.
- Concurrent fork/advance is serialized by the run lock.
- Cleanup never deletes a ref/worktree still used by a child.
- Publication produces intended clean history without private checkpoint artifacts.

## Open decisions

- Whether Slice 1 is worthwhile or checkpoint-aware dirty snapshots should be implemented from the start.
- Exact private-ref naming and retention policy.
- How to keep synthetic checkpoint commits out of publication history.
- Whether checkpoint manifests embed full state or use deduplicated/content-addressed state blobs.
- Whether child artifacts are copied, hard-linked, or referenced through lineage.
- Whether inherited attempts remain visible only or continue consuming the child's ceilings. The current preference is to preserve upstream attempts and let a pre-downstream checkpoint naturally avoid later attempts.
- Whether child usage starts at zero with `inheritedUsage` metadata or continues the parent's aggregate. Current preference is fresh child limits plus explicit inherited audit metadata.
- Compatibility rules for `--workflow current`, especially changed test-path patterns and scenario representations.
- Fork support for `git-disabled` and `legacy-shared` runs. These can be deferred; do not silently provide weaker filesystem semantics under the same command.
- Whether role-oriented selection means the latest provider return, the following persisted state transition, or both when an invocation is followed immediately by a deterministic command. Prefer the following durable transition and label it precisely.

## Current repository state

No Fork Run code or tests were changed during this exploration. At handoff creation, the worktree already contained unrelated untracked files:

- `docs/handoff/2026-08-13-legacy-install-scan.md`
- `docs/plans/agent-harness-legacy-sunset.md`

Preserve them. This handoff adds only `docs/handoff/2026-08-13-fork-run-checkpoints.md`.

## Start here next session

1. Read this handoff, ADR 0002, ADR 0010, `RunStore.record()` / `persistTransition()`, and `WorktreeManager.create()`.
2. Decide whether to begin with Slice 1 or go directly to checkpoint-aware dirty Git snapshots.
3. Write an ADR for immutable run checkpoints, lineage, and private Git snapshot ownership before spreading checkpoint logic through application services.
4. Begin with the primary acceptance integration test: fork at `implementation.completed` with the current workflow and resume directly into `scenario_testing`.
